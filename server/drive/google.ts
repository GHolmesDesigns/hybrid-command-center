import { google, drive_v3 } from 'googleapis';
import type { DriveFile } from '../../shared/drive.ts';
import type { DriveFilePage, DriveFolder, DriveProvider } from './provider.ts';
import type { DriveMediaFile, DriveMediaProvider } from './media.ts';

const escapeQuery = (value: string) => value.replace(/'/g, "\\'");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GoogleDriveProvider implements DriveProvider {
  readonly connected = true;
  private drive: drive_v3.Drive;
  constructor(drive: drive_v3.Drive) {
    this.drive = drive;
  }

  private async retry<T>(work: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await work();
    } catch (error: any) {
      const status = error?.response?.status;
      if (attempt < 3 && (status === 429 || status >= 500)) {
        await sleep(300 * 2 ** attempt);
        return this.retry(work, attempt + 1);
      }
      throw error;
    }
  }

  async ensureFolder({
    name,
    parentId,
    idempotencyKey,
  }: {
    name: string;
    parentId: string;
    idempotencyKey: string;
  }): Promise<DriveFolder> {
    const q = `'${escapeQuery(parentId)}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='commandCenterKey' and value='${escapeQuery(idempotencyKey)}' }`;
    const existing = await this.retry(() =>
      this.drive.files.list({ q, fields: 'files(id,name,webViewLink)', spaces: 'drive' }),
    );
    const found = existing.data.files?.[0];
    if (found?.id)
      return {
        id: found.id,
        name: found.name || name,
        url: found.webViewLink || `https://drive.google.com/drive/folders/${found.id}`,
      };
    const created = await this.retry(() =>
      this.drive.files.create({
        requestBody: {
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [parentId],
          appProperties: { commandCenterKey: idempotencyKey },
        },
        fields: 'id,name,webViewLink',
      }),
    );
    if (!created.data.id) throw new Error(`Drive did not return an ID for ${name}`);
    return {
      id: created.data.id,
      name: created.data.name || name,
      url: created.data.webViewLink || `https://drive.google.com/drive/folders/${created.data.id}`,
    };
  }

  /**
   * One page of a folder's contents. Folders sort ahead of files and then by the name
   * order a person reads in, so paging through a folder walks it the way Drive shows it
   * rather than in an order that changes between pages. Trashed items are excluded: they
   * are not in the folder as far as anyone browsing it is concerned.
   */
  async listFiles({
    folderId,
    pageSize,
    pageToken,
  }: {
    folderId: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<DriveFilePage> {
    const result = await this.retry(() =>
      this.drive.files.list({
        q: `'${escapeQuery(folderId)}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,webViewLink,modifiedTime,size)',
        orderBy: 'folder,name_natural',
        pageSize,
        pageToken,
        spaces: 'drive',
      }),
    );
    return {
      files: (result.data.files ?? []).flatMap((file) => (file.id ? [toFile(file, file.id)] : [])),
      // The SDK reports "no more pages" as an absent key; the API answers with null.
      nextPageToken: result.data.nextPageToken ?? null,
    };
  }

  async getFolder(folderId: string): Promise<DriveFolder> {
    const result = await this.retry(() =>
      this.drive.files.get({ fileId: folderId, fields: 'id,name,webViewLink,mimeType' }),
    );
    if (result.data.mimeType !== 'application/vnd.google-apps.folder' || !result.data.id)
      throw new Error('The selected item is not a Drive folder.');
    return {
      id: result.data.id,
      name: result.data.name || 'Drive folder',
      url: result.data.webViewLink || `https://drive.google.com/drive/folders/${result.data.id}`,
    };
  }
}

/**
 * Metadata for one file by id, for the Signal media reference in `media.ts`.
 *
 * A separate class from `GoogleDriveProvider` rather than a method on it, because it satisfies a
 * separate interface: `DriveProvider` — the vocabulary Files is handed — has no way to reach a
 * file by id, and giving it one here would widen Files by a line of plumbing. Both are built from
 * the same authorized client, which is the only thing they share.
 *
 * It reads. `alt=media` is deliberately absent; C75 owns the byte path.
 */
export class GoogleDriveMediaProvider implements DriveMediaProvider {
  readonly connected = true;
  private drive: drive_v3.Drive;
  constructor(drive: drive_v3.Drive) {
    this.drive = drive;
  }

  async getFile(fileId: string): Promise<DriveMediaFile> {
    const result = await this.drive.files.get({
      fileId,
      fields:
        'id,name,mimeType,size,webViewLink,modifiedTime,version,md5Checksum,sha256Checksum,trashed,shortcutDetails(targetId,targetMimeType),videoMediaMetadata(durationMillis,width,height)',
      // A file on a shared drive is still a file the connected account may have selected.
      supportsAllDrives: true,
    });
    const file = result.data;
    if (!file.id) throw new Error('Drive returned no id for that file.');
    return {
      id: file.id,
      name: file.name ?? null,
      mimeType: file.mimeType ?? null,
      size: file.size ?? null,
      webViewLink: file.webViewLink ?? null,
      modifiedTime: file.modifiedTime ?? null,
      version: file.version ?? null,
      md5Checksum: file.md5Checksum ?? null,
      sha256Checksum: file.sha256Checksum ?? null,
      trashed: file.trashed === true,
      shortcutTargetId: file.shortcutDetails?.targetId ?? null,
      videoDurationMillis: file.videoMediaMetadata?.durationMillis ?? null,
      videoWidth: file.videoMediaMetadata?.width ?? null,
      videoHeight: file.videoMediaMetadata?.height ?? null,
    };
  }

  async openFile(fileId: string, signal?: AbortSignal) {
    const result = await this.drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream', signal },
    );
    const body = result.data as unknown as AsyncIterable<Uint8Array>;
    if (!body || typeof body[Symbol.asyncIterator] !== 'function')
      throw new Error('Drive did not return a readable byte stream.');
    return { body };
  }
}

/**
 * One Drive item as the app carries it. `size` arrives as a decimal string and is absent
 * on folders and Google-native documents, which is not the same as zero bytes — the
 * difference is preserved rather than flattened, so the UI can say so.
 */
function toFile(file: drive_v3.Schema$File, id: string): DriveFile {
  const size = file.size === null || file.size === undefined ? NaN : Number(file.size);
  return {
    id,
    name: file.name || 'Untitled',
    mimeType: file.mimeType || 'application/octet-stream',
    url: file.webViewLink || `https://drive.google.com/file/d/${id}/view`,
    modifiedAt: file.modifiedTime || null,
    size: Number.isFinite(size) ? size : null,
  };
}

export function createGoogleProvider(
  tokens: object,
  credentials: { clientId: string; clientSecret: string; redirectUri: string },
) {
  const auth = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri,
  );
  auth.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth });
  return {
    provider: new GoogleDriveProvider(drive),
    media: new GoogleDriveMediaProvider(drive),
    auth,
  };
}
