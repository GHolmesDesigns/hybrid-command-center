import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { MockDriveMediaProvider } from './mock-provider.ts';
import {
  DisconnectedDriveMediaProvider,
  DriveMediaError,
  driveMediaProvider,
  parseDriveMediaLink,
  resolveDriveMedia,
  type DriveMediaProvider,
} from './media.ts';
import { DisconnectedDriveProvider } from './provider.ts';
import { SIGNAL_DRIVE_MAX_BYTES } from '../../shared/signal-media.ts';

/**
 * Binding a Signal media reference to a Drive file: what counts as a link, what counts as a file,
 * and what each refusal says. No real Drive call anywhere — `MockDriveMediaProvider` is the only
 * implementation this suite reaches, which is `AGENTS.md`'s rule and also the point: the capability
 * is small enough to stand in for completely.
 */

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

const resolve = (link: string, provider: DriveMediaProvider = new MockDriveMediaProvider()) =>
  resolveDriveMedia({ link, provider, now: () => '2026-08-20T09:00:00.000Z' });

describe('reading a file id out of a link', () => {
  it('accepts the forms Drive itself hands out, on both hosts', () => {
    expect(parseDriveMediaLink(`https://drive.google.com/file/d/${FILE_ID}/view?usp=sharing`)).toBe(
      FILE_ID,
    );
    expect(parseDriveMediaLink(`https://drive.google.com/file/d/${FILE_ID}`)).toBe(FILE_ID);
    expect(parseDriveMediaLink(`https://drive.google.com/open?id=${FILE_ID}`)).toBe(FILE_ID);
    expect(parseDriveMediaLink(`https://drive.google.com/uc?id=${FILE_ID}&export=download`)).toBe(
      FILE_ID,
    );
    expect(parseDriveMediaLink(`  https://docs.google.com/uc?id=${FILE_ID}  `)).toBe(FILE_ID);
  });

  /**
   * A bare id is the one thing this must never take. It is what the card means by "never accept a
   * raw unvalidated arbitrary ID from the browser": the id has to fall out of a parsed,
   * host-checked link, so there is no request body that turns a guessed id into a stored reference.
   */
  it('refuses a raw id, a wrong host, and anything that is not a link', () => {
    expect(() => parseDriveMediaLink(FILE_ID)).toThrow(/not a link/i);
    expect(() => parseDriveMediaLink('')).toThrow(/Paste a Google Drive file link/);
    expect(() => parseDriveMediaLink(`http://drive.google.com/file/d/${FILE_ID}/view`)).toThrow(
      /https/,
    );
    expect(() =>
      parseDriveMediaLink(`https://drive.google.com.evil.example/file/d/${FILE_ID}/view`),
    ).toThrow(/is not Google Drive/);
    expect(() => parseDriveMediaLink(`https://dropbox.com/file/d/${FILE_ID}/view`)).toThrow(
      /is not Google Drive/,
    );
  });

  it('names a folder link, a Drive view, and a Google-native document as what they are', () => {
    expect(() => parseDriveMediaLink(`https://drive.google.com/drive/folders/${FILE_ID}`)).toThrow(
      /a Drive folder/,
    );
    expect(() => parseDriveMediaLink('https://drive.google.com/drive/my-drive')).toThrow(
      /a Drive view/,
    );
    expect(() => parseDriveMediaLink(`https://docs.google.com/document/d/${FILE_ID}/edit`)).toThrow(
      /Google Docs, Sheets, or Slides/,
    );
    expect(() =>
      parseDriveMediaLink(`https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`),
    ).toThrow(/Google Docs, Sheets, or Slides/);
  });

  it('refuses an id that is not shaped like a Drive id, rather than looking it up', () => {
    expect(() => parseDriveMediaLink('https://drive.google.com/file/d/short/view')).toThrow(
      /carries no Drive file id/,
    );
    expect(() => parseDriveMediaLink('https://drive.google.com/file/d/has spaces/view')).toThrow(
      /carries no Drive file id/,
    );
    expect(() => parseDriveMediaLink('https://drive.google.com/')).toThrow(
      /does not address a single file/,
    );
  });
});

describe('resolving one file to metadata and version evidence', () => {
  it('canonicalizes the file into a stored descriptor', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed(FILE_ID, { name: 'launch.mp4', mimeType: 'video/mp4', size: '4096' });

    const media = await resolve(`https://drive.google.com/open?id=${FILE_ID}`, provider);

    expect(media).toEqual({
      source: 'DRIVE',
      url: `https://drive.google.com/file/d/${FILE_ID}/view`,
      driveFileId: FILE_ID,
      driveName: 'launch.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      driveVersion: '7',
      driveModifiedAt: '2026-03-01T12:00:00.000Z',
      driveChecksum: 'd41d8cd98f00b204e9800998ecf8427e',
      driveVerifiedAt: '2026-08-20T09:00:00.000Z',
    });
    expect(provider.calls).toEqual([FILE_ID]);
  });

  it('follows a shortcut exactly one hop, and refuses one that resolves to no single file', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed('shortcut-to-file-1', {
      mimeType: 'application/vnd.google-apps.shortcut',
      size: null,
      shortcutTargetId: FILE_ID,
    });
    provider.seed(FILE_ID, { name: 'poster.png' });
    const media = await resolve(
      'https://drive.google.com/file/d/shortcut-to-file-1/view',
      provider,
    );
    expect(media.driveFileId).toBe(FILE_ID);
    expect(media.driveName).toBe('poster.png');

    provider.seed('shortcut-to-none-1', {
      mimeType: 'application/vnd.google-apps.shortcut',
      shortcutTargetId: null,
    });
    await expect(
      resolve('https://drive.google.com/file/d/shortcut-to-none-1/view', provider),
    ).rejects.toThrow(/shortcut with no target/);

    provider.seed('shortcut-to-shortcut', {
      mimeType: 'application/vnd.google-apps.shortcut',
      shortcutTargetId: 'shortcut-to-none-1',
    });
    await expect(
      resolve('https://drive.google.com/file/d/shortcut-to-shortcut/view', provider),
    ).rejects.toThrow(/shortcut to another shortcut/);
  });

  it('refuses a Google-native file, an unsupported type, and a trashed one, each by name', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed('native-doc-file-1', {
      name: 'Brief',
      mimeType: 'application/vnd.google-apps.document',
      size: null,
    });
    await expect(
      resolve('https://drive.google.com/file/d/native-doc-file-1/view', provider),
    ).rejects.toThrow(/Brief is a Google-native document/);

    provider.seed('webp-image-file-1', { name: 'hero.webp', mimeType: 'image/webp' });
    await expect(
      resolve('https://drive.google.com/file/d/webp-image-file-1/view', provider),
    ).rejects.toThrow(/hero\.webp is image\/webp, and the publisher accepts image\/png/);

    provider.seed('trashed-file-0001', { name: 'old.png', trashed: true });
    await expect(
      resolve('https://drive.google.com/file/d/trashed-file-0001/view', provider),
    ).rejects.toThrow(/old\.png is in the Drive trash/);
  });

  it('refuses a missing, non-finite, or out-of-bounds size', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed('no-size-file-0001', { name: 'sizeless.png', size: null });
    await expect(
      resolve('https://drive.google.com/file/d/no-size-file-0001/view', provider),
    ).rejects.toThrow(/Drive reports no size for sizeless\.png/);

    provider.seed('bad-size-file-001', { name: 'odd.png', size: 'not-a-number' });
    await expect(
      resolve('https://drive.google.com/file/d/bad-size-file-001/view', provider),
    ).rejects.toThrow(/unusable size for odd\.png/);

    provider.seed('zero-size-file-01', { name: 'empty.png', size: '0' });
    await expect(
      resolve('https://drive.google.com/file/d/zero-size-file-01/view', provider),
    ).rejects.toThrow(/unusable size for empty\.png/);

    provider.seed('huge-size-file-01', {
      name: 'feature.mp4',
      mimeType: 'video/mp4',
      size: String(SIGNAL_DRIVE_MAX_BYTES + 1),
    });
    await expect(
      resolve('https://drive.google.com/file/d/huge-size-file-01/view', provider),
    ).rejects.toThrow(/this app binds files up to/);
  });

  it('refuses a file Drive gives no version signal for', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed('no-version-file-1', {
      name: 'anonymous.png',
      version: null,
      modifiedTime: null,
      md5Checksum: null,
      sha256Checksum: null,
    });
    await expect(
      resolve('https://drive.google.com/file/d/no-version-file-1/view', provider),
    ).rejects.toThrow(/no version, modified time, or checksum/);
  });

  it('takes one version signal on its own, because Drive does not checksum everything', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed('one-signal-file-1', {
      version: null,
      md5Checksum: null,
      sha256Checksum: null,
    });
    const media = await resolve('https://drive.google.com/file/d/one-signal-file-1/view', provider);
    expect(media.driveVersion).toBeNull();
    expect(media.driveChecksum).toBeNull();
    expect(media.driveModifiedAt).toBe('2026-03-01T12:00:00.000Z');
  });

  it('prefers the stronger checksum when Drive reports both', async () => {
    const provider = new MockDriveMediaProvider();
    provider.seed('two-sums-file-001', { sha256Checksum: 'sha-256-value' });
    const media = await resolve('https://drive.google.com/file/d/two-sums-file-001/view', provider);
    expect(media.driveChecksum).toBe('sha-256-value');
  });

  it('carries Drive’s own words when the call fails, bounded and named', async () => {
    const provider = new MockDriveMediaProvider();
    provider.error = 'File not found: 404';
    await expect(
      resolve(`https://drive.google.com/file/d/${FILE_ID}/view`, provider),
    ).rejects.toThrow(/Drive could not return that file: File not found: 404/);
  });

  it('checks the link before the connection, so a bad paste is not blamed on Drive', async () => {
    const disconnected = new DisconnectedDriveMediaProvider();
    await expect(resolve('https://example.com/photo.png', disconnected)).rejects.toThrow(
      /is not Google Drive/,
    );
    await expect(
      resolve(`https://drive.google.com/file/d/${FILE_ID}/view`, disconnected),
    ).rejects.toThrow(/Google Drive is not connected/);
  });

  it('answers every refusal as a DriveMediaError, which the API turns into a 400', async () => {
    await expect(resolve('nonsense')).rejects.toBeInstanceOf(DriveMediaError);
  });
});

describe('the capability boundary', () => {
  it('is disconnected until Drive is, and is not a method on the browsing provider', () => {
    const media = driveMediaProvider(db);
    expect(media.connected).toBe(false);
    // The Files vocabulary is `DriveProvider`, and nothing in it reaches a file by id. Asserted
    // rather than described, because the whole of this card's Files guarantee is that the browsing
    // half was not widened: a `getFile` added there would fail here.
    const browsing = new DisconnectedDriveProvider();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(browsing)).sort()).toEqual([
      'constructor',
      'ensureFolder',
      'getFolder',
      'listFiles',
    ]);
  });
});
