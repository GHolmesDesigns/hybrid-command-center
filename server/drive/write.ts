import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import type { DriveFile, DriveScope } from '../../shared/drive.ts';
import { DRIVE_FOLDER_MIME } from '../../shared/drive.ts';

export const DRIVE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export interface DriveWriteProvider {
  readonly connected: boolean;
  createFolder(input: { name: string; parentId: string }): Promise<DriveScope>;
  uploadFile(input: {
    name: string;
    mimeType: string;
    parentId: string;
    bytes: Uint8Array;
  }): Promise<DriveFile>;
}

export class DisconnectedDriveWriteProvider implements DriveWriteProvider {
  readonly connected = false;
  async createFolder(input: { name: string; parentId: string }): Promise<DriveScope> {
    void input;
    throw new Error('Google Drive is not connected. Complete setup in Settings.');
  }
  async uploadFile(input: {
    name: string;
    mimeType: string;
    parentId: string;
    bytes: Uint8Array;
  }): Promise<DriveFile> {
    void input;
    throw new Error('Google Drive is not connected. Complete setup in Settings.');
  }
}

type FolderPlan = {
  kind: 'create-folder';
  projectId: string;
  parentId: string;
  parentName: string;
  name: string;
};

type UploadPlan = {
  kind: 'upload-file';
  projectId: string;
  folderId: string;
  folderName: string;
  name: string;
  mimeType: string;
  size: number;
  contentBase64: string;
};

export type DriveWritePlan = FolderPlan | UploadPlan;

export const driveWritePlanSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create-folder'),
    projectId: z.string().uuid(),
    parentId: z.string().min(1).max(200),
    parentName: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('upload-file'),
    projectId: z.string().uuid(),
    folderId: z.string().min(1).max(200),
    folderName: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(200),
    size: z.number().int().positive().max(DRIVE_UPLOAD_MAX_BYTES),
    contentBase64: z.string().min(1),
  }),
]) satisfies z.ZodType<DriveWritePlan>;

export class DriveWriteConfirmationError extends Error {}

const planHash = (plan: DriveWritePlan) =>
  crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');

export function driveWritePlanHash(plan: DriveWritePlan) {
  return planHash(plan);
}

function projectFolderScopes(db: Db, projectId: string): DriveScope[] {
  const project = db
    .prepare('SELECT drive_folder_id id, drive_folder_url url, name FROM projects WHERE id=?')
    .get(projectId) as { id: string | null; url: string | null; name: string } | undefined;
  if (!project?.id) return [];
  const children = db
    .prepare(
      `SELECT folder_id id, folder_url url, step_key name FROM drive_steps
       WHERE entity_type='project' AND entity_id=? ORDER BY step_key`,
    )
    .all(projectId) as { id: string; url: string | null; name: string }[];
  return [
    { id: project.id, url: project.url, name: 'Project folder' },
    ...children.map((child) => ({ id: child.id, url: child.url, name: child.name })),
  ];
}

function requireFolder(db: Db, projectId: string, folderId: string) {
  const folder = projectFolderScopes(db, projectId).find((scope) => scope.id === folderId);
  if (!folder) throw new DriveWriteConfirmationError('That folder is not part of this project.');
  return folder;
}

export function previewDriveFolderCreate(
  db: Db,
  input: { projectId: string; parentId: string; name: string },
) {
  const name = input.name.trim();
  if (!name) throw new DriveWriteConfirmationError('Folder name is required.');
  if (name.length > 200) throw new DriveWriteConfirmationError('Folder name is too long.');
  const parent = requireFolder(db, input.projectId, input.parentId);
  const plan: FolderPlan = {
    kind: 'create-folder',
    projectId: input.projectId,
    parentId: parent.id,
    parentName: parent.name,
    name,
  };
  return {
    plan,
    planHash: planHash(plan),
    confirmation: `Create folder "${name}" in "${parent.name}".`,
  };
}

export function previewDriveUpload(
  db: Db,
  input: {
    projectId: string;
    folderId: string;
    name: string;
    mimeType: string;
    contentBase64: string;
  },
) {
  const name = input.name.trim();
  const mimeType = input.mimeType.trim();
  if (!name) throw new DriveWriteConfirmationError('File name is required.');
  if (name.length > 200) throw new DriveWriteConfirmationError('File name is too long.');
  if (!mimeType || mimeType.length > 200)
    throw new DriveWriteConfirmationError('A valid MIME type is required.');
  const content = Buffer.from(input.contentBase64, 'base64');
  if (!input.contentBase64 || content.length > DRIVE_UPLOAD_MAX_BYTES)
    throw new DriveWriteConfirmationError('The upload is empty or exceeds the 10 MB limit.');
  const folder = requireFolder(db, input.projectId, input.folderId);
  const plan: UploadPlan = {
    kind: 'upload-file',
    projectId: input.projectId,
    folderId: folder.id,
    folderName: folder.name,
    name,
    mimeType,
    size: content.length,
    contentBase64: input.contentBase64,
  };
  return {
    plan,
    planHash: planHash(plan),
    confirmation: `Upload "${name}" (${content.length} bytes) to "${folder.name}".`,
  };
}

export async function commitDriveWrite(
  db: Db,
  plan: DriveWritePlan,
  confirmedPlanHash: string,
  provider: DriveWriteProvider,
) {
  if (planHash(plan) !== confirmedPlanHash)
    throw new DriveWriteConfirmationError('This Drive confirmation is stale. Preview it again.');
  const operation = plan.kind === 'create-folder' ? 'drive.create-folder' : 'drive.upload-file';
  try {
    const result =
      plan.kind === 'create-folder'
        ? await provider.createFolder({ name: plan.name, parentId: plan.parentId })
        : await provider.uploadFile({
            name: plan.name,
            mimeType: plan.mimeType,
            parentId: plan.folderId,
            bytes: Buffer.from(plan.contentBase64, 'base64'),
          });
    recordIntegrationEvent(db, {
      source: 'google-drive',
      operation,
      outcome: 'SUCCESS',
      summary:
        plan.kind === 'create-folder'
          ? `Created Drive folder "${plan.name}".`
          : `Uploaded Drive file "${plan.name}".`,
      entities: [
        {
          type: plan.kind === 'create-folder' ? 'driveFolder' : 'driveFile',
          id: result.id,
          label: result.name,
        },
      ],
    });
    return result;
  } catch (error) {
    recordIntegrationEvent(db, {
      source: 'google-drive',
      operation,
      outcome: 'FAILURE',
      summary:
        plan.kind === 'create-folder'
          ? `Drive folder "${plan.name}" was not created.`
          : `Drive file "${plan.name}" was not uploaded.`,
      error: error instanceof Error ? error.message : 'Unknown Drive error',
    });
    throw error;
  }
}

export const isDriveFolderMime = (mimeType: string) => mimeType === DRIVE_FOLDER_MIME;
