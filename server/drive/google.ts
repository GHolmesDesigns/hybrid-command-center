import { google, drive_v3 } from 'googleapis';
import type { DriveFolder, DriveProvider } from './provider.ts';

const escapeQuery = (value: string) => value.replace(/'/g, "\\'");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GoogleDriveProvider implements DriveProvider {
  readonly connected = true;
  private drive: drive_v3.Drive;
  constructor(drive: drive_v3.Drive) { this.drive = drive; }

  private async retry<T>(work: () => Promise<T>, attempt = 0): Promise<T> {
    try { return await work(); }
    catch (error: any) {
      const status = error?.response?.status;
      if (attempt < 3 && (status === 429 || status >= 500)) { await sleep(300 * 2 ** attempt); return this.retry(work, attempt + 1); }
      throw error;
    }
  }

  async ensureFolder({ name, parentId, idempotencyKey }: { name: string; parentId: string; idempotencyKey: string }): Promise<DriveFolder> {
    const q = `'${escapeQuery(parentId)}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='commandCenterKey' and value='${escapeQuery(idempotencyKey)}' }`;
    const existing = await this.retry(() => this.drive.files.list({ q, fields: 'files(id,name,webViewLink)', spaces: 'drive' }));
    const found = existing.data.files?.[0];
    if (found?.id) return { id: found.id, name: found.name || name, url: found.webViewLink || `https://drive.google.com/drive/folders/${found.id}` };
    const created = await this.retry(() => this.drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId], appProperties: { commandCenterKey: idempotencyKey } },
      fields: 'id,name,webViewLink',
    }));
    if (!created.data.id) throw new Error(`Drive did not return an ID for ${name}`);
    return { id: created.data.id, name: created.data.name || name, url: created.data.webViewLink || `https://drive.google.com/drive/folders/${created.data.id}` };
  }

  async getFolder(folderId: string): Promise<DriveFolder> {
    const result = await this.retry(() => this.drive.files.get({ fileId: folderId, fields: 'id,name,webViewLink,mimeType' }));
    if (result.data.mimeType !== 'application/vnd.google-apps.folder' || !result.data.id) throw new Error('The selected item is not a Drive folder.');
    return { id: result.data.id, name: result.data.name || 'Drive folder', url: result.data.webViewLink || `https://drive.google.com/drive/folders/${result.data.id}` };
  }
}

export function createGoogleProvider(tokens: object, credentials: { clientId: string; clientSecret: string; redirectUri: string }) {
  const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, credentials.redirectUri);
  auth.setCredentials(tokens);
  return { provider: new GoogleDriveProvider(google.drive({ version: 'v3', auth })), auth };
}
