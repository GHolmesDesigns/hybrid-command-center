export interface DriveFolder {
  id: string;
  url: string;
  name: string;
}
export interface DriveProvider {
  readonly connected: boolean;
  ensureFolder(input: {
    name: string;
    parentId: string;
    idempotencyKey: string;
  }): Promise<DriveFolder>;
  getFolder(folderId: string): Promise<DriveFolder>;
}

export class DisconnectedDriveProvider implements DriveProvider {
  readonly connected = false;
  async ensureFolder(): Promise<DriveFolder> {
    throw new Error('Google Drive is not connected. Complete setup in Settings.');
  }
  async getFolder(): Promise<DriveFolder> {
    throw new Error('Google Drive is not connected.');
  }
}
