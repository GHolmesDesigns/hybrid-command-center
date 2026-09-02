import type { Db } from '../db.ts';
import { projectScopes, DriveScopeError } from './browse.ts';
import type { DriveProvider } from './provider.ts';
import { DriveMediaError, resolveDriveMediaFile, type DriveMediaProvider } from './media.ts';
import type { DriveScope } from '../../shared/drive.ts';
import type { SignalPostMedia } from '../../shared/signal-media.ts';

/** A batch is deliberately small enough to finish predictably and be reviewed by a person. */
export const SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS = 100;

export type DriveMediaBatchItem = {
  id: string;
  name: string;
  mimeType: string;
  url: string;
  outcome: 'RESOLVED' | 'REFUSED';
  media?: SignalPostMedia;
  error?: string;
};

export type DriveMediaBatchResult =
  | {
      outcome: 'SUCCESS';
      projectId: string;
      folder: DriveScope;
      maxItems: number;
      truncated: false;
      items: DriveMediaBatchItem[];
    }
  | {
      outcome: 'REFUSED';
      code: 'DRIVE_MEDIA_BATCH_LIMIT_EXCEEDED';
      projectId: string;
      folder: DriveScope;
      maxItems: number;
      truncated: true;
      listedItemCount: number;
      items: [];
      error: string;
    };

/**
 * Resolves every item in one project-owned Drive folder.
 *
 * Listing is performed through the Files provider, so the folder is checked against the
 * project's own folder and its recorded step folders before Drive is contacted. Metadata
 * resolution is intentionally delegated to the separate media capability; no bytes are read and
 * no Drive write is reachable from this operation.
 */
export async function resolveDriveMediaBatch(input: {
  db: Db;
  projectId: string;
  folderId?: string;
  provider: DriveProvider;
  mediaProvider: DriveMediaProvider;
  now?: () => string;
}): Promise<DriveMediaBatchResult> {
  const scopes = projectScopes(input.db, input.projectId);
  const folder = input.folderId ? scopes.find((scope) => scope.id === input.folderId) : scopes[0];
  if (input.folderId && !folder)
    throw new DriveScopeError('That folder is not part of this project.');
  if (!folder) throw new DriveScopeError('This project has no Drive folder.');
  if (!input.provider.connected)
    throw new DriveMediaError('Google Drive is not connected. Connect it in Settings.');
  if (!input.mediaProvider.connected)
    throw new DriveMediaError(
      'Google Drive is not connected, so media cannot be checked. Connect it in Settings.',
    );

  const files = [];
  let pageToken: string | undefined;
  const seenTokens = new Set<string>();
  while (files.length <= SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS) {
    const page = await input.provider.listFiles({
      folderId: folder.id,
      pageSize: Math.min(SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS, 100),
      ...(pageToken ? { pageToken } : {}),
    });
    files.push(...page.files);
    if (files.length > SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS) {
      const result = {
        outcome: 'REFUSED',
        code: 'DRIVE_MEDIA_BATCH_LIMIT_EXCEEDED',
        projectId: input.projectId,
        folder,
        maxItems: SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS,
        truncated: true,
        listedItemCount: files.length,
        items: [],
        error: `This folder contains more than ${SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS} items. Narrow the folder before resolving media.`,
      } satisfies Extract<DriveMediaBatchResult, { outcome: 'REFUSED' }>;
      return result;
    }
    if (!page.nextPageToken) break;
    if (seenTokens.has(page.nextPageToken))
      throw new DriveMediaError('Drive returned a repeated page token while listing this folder.');
    seenTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }

  const now = input.now;
  const items = await Promise.all(
    files.map(async (file): Promise<DriveMediaBatchItem> => {
      try {
        const media = await resolveDriveMediaFile({
          fileId: file.id,
          provider: input.mediaProvider,
          now,
        });
        return { ...file, outcome: 'RESOLVED', media };
      } catch (error) {
        return {
          ...file,
          outcome: 'REFUSED',
          error:
            error instanceof Error
              ? error.message.slice(0, 300)
              : 'Drive media could not be resolved.',
        };
      }
    }),
  );
  return {
    outcome: 'SUCCESS',
    projectId: input.projectId,
    folder,
    maxItems: SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS,
    truncated: false,
    items,
  };
}
