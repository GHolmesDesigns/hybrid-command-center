import type { Db } from '../db.ts';
import { config } from '../config.ts';
import { driveProvider } from './service.ts';
import type { DriveProvider } from './provider.ts';
import {
  DRIVE_PAGE_SIZE,
  DRIVE_PAGE_SIZE_MAX,
  type DriveListing,
  type DriveScope,
} from '../../shared/drive.ts';

/**
 * Read-only Drive browsing for one project (FR8, decision §5.8).
 *
 * Everything here lists. There is no counterpart that writes, and the provider interface
 * this leans on has no write beyond the folder provisioning that already existed, so a
 * later mistake in the UI cannot reach one through this path.
 *
 * A project is browsable only at folders it owns: its own Drive folder, and the
 * subfolders `provisionProject` recorded for it in `drive_steps`. Those are matched by
 * ID, never by name, and anything else is refused rather than fetched — otherwise a
 * folder ID typed into the address bar would turn a project's file list into a browser
 * for the whole of the connected account.
 */

/** A folder ID that is not one of this project's. Answered as a 400, not a Drive error. */
export class DriveScopeError extends Error {}

/** True when this machine has the credentials Drive needs, whether or not it is connected. */
export const driveConfigured = () =>
  Boolean(config.google.clientId && config.google.clientSecret && config.google.encryptionKey);

/**
 * Where this project may be browsed, project folder first and then its subfolders in the
 * order they were provisioned. Empty until the project has a Drive folder at all.
 */
export function projectScopes(db: Db, projectId: string): DriveScope[] {
  const project = db
    .prepare('SELECT drive_folder_id id, drive_folder_url url, name FROM projects WHERE id=?')
    .get(projectId) as { id: string | null; url: string | null; name: string } | undefined;
  if (!project?.id) return [];
  const subfolders = db
    .prepare(
      `SELECT folder_id id, folder_url url, step_key name FROM drive_steps
       WHERE entity_type='project' AND entity_id=? ORDER BY step_key`,
    )
    .all(projectId) as { id: string; url: string | null; name: string }[];
  return [
    { id: project.id, name: 'Project folder', url: project.url },
    ...subfolders.map((row) => ({ id: row.id, name: row.name, url: row.url })),
  ];
}

export async function listProjectFiles(
  db: Db,
  projectId: string,
  options: {
    folderId?: string;
    pageToken?: string;
    pageSize?: number;
    /** Injected by tests so a listing can be rehearsed without touching real Drive. */
    provider?: DriveProvider;
    configured?: boolean;
  } = {},
): Promise<DriveListing | undefined> {
  const project = db.prepare('SELECT id, name FROM projects WHERE id=?').get(projectId) as
    { id: string; name: string } | undefined;
  if (!project) return undefined;

  const scopes = projectScopes(db, projectId);
  const base = {
    projectId: project.id,
    projectName: project.name,
    folder: null,
    scopes,
    files: [],
    nextPageToken: null,
    error: null,
  } satisfies Omit<DriveListing, 'state'>;

  const provider = options.provider ?? driveProvider(db);
  // A connected provider could not exist without credentials, so `configured` only ever
  // decides *why* a disconnected one is disconnected — and that is the difference between
  // "add credentials to .env" and "click Connect in Settings".
  if (!provider.connected)
    return {
      ...base,
      state: (options.configured ?? driveConfigured()) ? 'NOT_CONNECTED' : 'NOT_CONFIGURED',
    };

  // Scope is checked after the connection, not before it: a bookmarked folder that
  // outlived a disconnection should be told what is wrong with the connection rather than
  // argued with about a folder nobody could browse either way.
  const folder = options.folderId
    ? scopes.find((scope) => scope.id === options.folderId)
    : scopes[0];
  if (options.folderId && !folder)
    throw new DriveScopeError('That folder is not part of this project.');
  if (!folder) return { ...base, state: 'NO_FOLDER' };

  const pageSize = Math.min(Math.max(options.pageSize ?? DRIVE_PAGE_SIZE, 1), DRIVE_PAGE_SIZE_MAX);
  try {
    const page = await provider.listFiles({
      folderId: folder.id,
      pageSize,
      ...(options.pageToken ? { pageToken: options.pageToken } : {}),
    });
    return { ...base, state: 'READY', folder, ...page };
  } catch (error) {
    // A Drive call that fails while connected is its own state: the folder exists, the
    // connection exists, and the only useful next step is to try again.
    return {
      ...base,
      state: 'FAILED',
      folder,
      error: error instanceof Error ? error.message.slice(0, 500) : 'Unknown Drive error',
    };
  }
}
