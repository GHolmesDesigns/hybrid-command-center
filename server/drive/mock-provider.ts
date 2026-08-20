import type { DriveFile } from '../../shared/drive.ts';
import type { OAuthAuthorizationClient } from './oauth.ts';
import type { DriveFilePage, DriveFolder, DriveProvider } from './provider.ts';
import type { DriveMediaFile, DriveMediaProvider } from './media.ts';

/**
 * The Drive stand-in every automated test uses. Real Drive is never contacted from a test
 * (`AGENTS.md`), so this is the only implementation of `DriveProvider` a suite may reach
 * for: it remembers the folders it was asked to create, hands back the pages it was seeded
 * with, and can be told to fail on cue so the failure states are exercised for real.
 *
 * It lives beside the provider rather than in one suite because three of them need it —
 * provisioning, browsing, and the API boundary — and a copy per suite is a copy that drifts.
 */
export class MockDriveProvider implements DriveProvider {
  connected = true;
  /** Folders by idempotency key, so a second `ensureFolder` returns the first one. */
  folders = new Map<string, DriveFolder>();
  /** Every idempotency key this provider was asked for, in order. */
  calls: string[] = [];
  /** Fails the first `ensureFolder` for this folder name, then stops failing. */
  failOn?: string;
  failed = false;
  /** Pages keyed by folder ID; each entry is one page in the order they are served. */
  pages = new Map<string, DriveFilePage[]>();
  /** Thrown by `listFiles` when set, standing in for a Drive call that failed. */
  listError?: string;
  /** Every listing this provider was asked for, so paging can be asserted on. */
  listCalls: { folderId: string; pageSize: number; pageToken?: string }[] = [];

  async ensureFolder(input: { name: string; parentId: string; idempotencyKey: string }) {
    this.calls.push(input.idempotencyKey);
    if (this.failOn === input.name && !this.failed) {
      this.failed = true;
      throw new Error('Temporary Drive failure');
    }
    const existing = this.folders.get(input.idempotencyKey);
    if (existing) return existing;
    const folder = {
      id: `folder-${this.folders.size + 1}`,
      url: `https://drive.test/${this.folders.size + 1}`,
      name: input.name,
    };
    this.folders.set(input.idempotencyKey, folder);
    return folder;
  }

  async getFolder(id: string) {
    return { id, url: `https://drive.test/${id}`, name: 'Root' };
  }

  /**
   * Serves the seeded pages for a folder in order: the first call gets page one, a call
   * carrying page one's token gets page two, and so on. An unseeded folder is empty, which
   * is the same answer Drive gives for a folder with nothing in it.
   */
  async listFiles(input: { folderId: string; pageSize: number; pageToken?: string }) {
    this.listCalls.push(input);
    if (this.listError) throw new Error(this.listError);
    const pages = this.pages.get(input.folderId) ?? [];
    const index = input.pageToken
      ? pages.findIndex((page) => page.nextPageToken === input.pageToken) + 1
      : 0;
    return pages[index] ?? { files: [], nextPageToken: null };
  }

  /** Seeds a folder with pages, chaining each page's token to the next automatically. */
  seed(folderId: string, pages: DriveFile[][]) {
    this.pages.set(
      folderId,
      pages.map((files, index) => ({
        files,
        nextPageToken: index < pages.length - 1 ? `${folderId}-page-${index + 1}` : null,
      })),
    );
  }
}

/**
 * The Drive metadata stand-in for the Signal media reference (C74).
 *
 * Separate from `MockDriveProvider` for the same reason the real ones are separate: the two
 * capabilities are two interfaces, and a test that hands a component the browsing mock must not
 * thereby hand it a way to read any file in the account. It records every id it was asked for, so
 * a test can prove that preview asked for none.
 */
export class MockDriveMediaProvider implements DriveMediaProvider {
  connected = true;
  /** Files by id. An id that is not here fails the way a Drive 404 does. */
  files = new Map<string, DriveMediaFile>();
  /** Every id this provider was asked for, in order. */
  calls: string[] = [];
  /** Thrown by `getFile` when set, standing in for a Drive call that failed. */
  error?: string;
  openError?: string;
  /** Byte chunks by file id and every byte-open call, separate from metadata reads. */
  bodies = new Map<string, Uint8Array[]>();
  openCalls: { fileId: string; signal?: AbortSignal }[] = [];

  async getFile(fileId: string): Promise<DriveMediaFile> {
    this.calls.push(fileId);
    if (this.error) throw new Error(this.error);
    const file = this.files.get(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    return file;
  }

  async openFile(fileId: string, signal?: AbortSignal) {
    this.openCalls.push({ fileId, ...(signal ? { signal } : {}) });
    if (this.openError) throw new Error(this.openError);
    const chunks = this.bodies.get(fileId);
    if (!chunks) throw new Error(`No byte stream seeded for: ${fileId}`);
    return {
      body: (async function* () {
        for (const chunk of chunks) {
          if (signal?.aborted) throw signal.reason;
          yield chunk;
        }
      })(),
    };
  }

  /** Seeds one file, defaulting to a small PNG that every rule accepts. */
  seed(id: string, overrides: Partial<DriveMediaFile> = {}): DriveMediaFile {
    const file: DriveMediaFile = {
      id,
      name: `${id}.png`,
      mimeType: 'image/png',
      size: '2048',
      webViewLink: `https://drive.google.com/file/d/${id}/view`,
      modifiedTime: '2026-03-01T12:00:00.000Z',
      version: '7',
      md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
      sha256Checksum: null,
      trashed: false,
      shortcutTargetId: null,
      videoDurationMillis: null,
      videoWidth: null,
      videoHeight: null,
      ...overrides,
    };
    this.files.set(id, file);
    const declared = Number(file.size);
    if (!this.bodies.has(id) && Number.isSafeInteger(declared) && declared <= 1024 * 1024)
      this.bodies.set(id, [new Uint8Array(declared)]);
    return file;
  }

  seedBody(id: string, ...chunks: Uint8Array[]) {
    this.bodies.set(id, chunks);
  }
}

/**
 * The authorization server every automated test connects against. It stands in for Google's
 * two OAuth calls and, more to the point, remembers what it was sent: the PKCE challenge that
 * went out on the authorization URL and the verifier that came back on the exchange are both
 * recorded, so a test can assert the exchange was bound to the request that started it rather
 * than take the route's word for it.
 */
export class MockOAuthClient implements OAuthAuthorizationClient {
  /** Every authorization URL this client was asked to build, in order. */
  authorizations: { state: string; challenge: string }[] = [];
  /** Every exchange it was asked to perform, in order. */
  exchanges: { code: string; verifier: string }[] = [];
  /** Thrown by `exchange` when set, standing in for a code the provider refused. */
  exchangeError?: string;
  /** The credentials a successful exchange answers with. */
  tokens: { access_token: string; refresh_token: string } = {
    access_token: 'mock-access-token',
    refresh_token: 'mock-refresh-token',
  };

  authorizationUrl(input: { state: string; challenge: string }) {
    this.authorizations.push(input);
    const query = new URLSearchParams({
      state: input.state,
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
    });
    return `https://accounts.test/authorize?${query.toString()}`;
  }

  async exchange(input: { code: string; verifier: string }) {
    this.exchanges.push(input);
    if (this.exchangeError) throw new Error(this.exchangeError);
    return this.tokens;
  }
}

/** One Drive item in the shape the provider answers with, varied per case. */
export const mockDriveFile = (
  id: string,
  name: string,
  overrides: Partial<DriveFile> = {},
): DriveFile => ({
  id,
  name,
  mimeType: 'application/pdf',
  url: `https://drive.test/file/${id}`,
  modifiedAt: '2026-03-01T12:00:00.000Z',
  size: 2048,
  ...overrides,
});
