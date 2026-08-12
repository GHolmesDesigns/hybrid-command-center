import type { DriveFile } from '../../shared/drive.ts';

export interface DriveFolder {
  id: string;
  url: string;
  name: string;
}
/** One page of a folder's contents, with Drive's cursor for the next one. */
export interface DriveFilePage {
  files: DriveFile[];
  nextPageToken: string | null;
}
export interface DriveProvider {
  readonly connected: boolean;
  ensureFolder(input: {
    name: string;
    parentId: string;
    idempotencyKey: string;
  }): Promise<DriveFolder>;
  getFolder(folderId: string): Promise<DriveFolder>;
  /**
   * One page of a folder's contents, by folder ID. Read-only by construction: there is
   * deliberately no counterpart that uploads, moves, renames, or deletes, so nothing in
   * the app can reach a Drive write through this interface.
   */
  listFiles(input: {
    folderId: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<DriveFilePage>;
}

export class DisconnectedDriveProvider implements DriveProvider {
  readonly connected = false;
  async ensureFolder(): Promise<DriveFolder> {
    throw new Error('Google Drive is not connected. Complete setup in Settings.');
  }
  async getFolder(): Promise<DriveFolder> {
    throw new Error('Google Drive is not connected.');
  }
  async listFiles(): Promise<DriveFilePage> {
    throw new Error('Google Drive is not connected.');
  }
}
