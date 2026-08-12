import type { DriveFile } from '../../shared/drive.ts';
import type { DriveFilePage, DriveFolder, DriveProvider } from './provider.ts';

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
