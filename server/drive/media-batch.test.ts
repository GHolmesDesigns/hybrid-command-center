import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { MockDriveMediaProvider, MockDriveProvider, mockDriveFile } from './mock-provider.ts';
import { projectScopes } from './browse.ts';
import { provisionClient, provisionProject, setSetting } from './service.ts';
import { DisconnectedDriveMediaProvider } from './media.ts';
import { resolveDriveMediaBatch, SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS } from './media-batch.ts';

let db: Db;
let projectId: string;
let clientId: string;

beforeEach(() => {
  db = createDb(':memory:');
  clientId = crypto.randomUUID();
  projectId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO clients(id,name,slug,drive_status,created_at,updated_at) VALUES(?,?,'client','PENDING',?,?)",
  ).run(clientId, 'Client', stamp, stamp);
  db.prepare(
    "INSERT INTO projects(id,client_id,name,status,priority,drive_status,created_at,updated_at) VALUES(?,?,'Campaign','ACTIVE','HIGH','PENDING',?,?)",
  ).run(projectId, clientId, stamp, stamp);
  setSetting(db, 'drive_root_id', 'root');
});

const setup = async () => {
  const drive = new MockDriveProvider();
  await provisionClient(db, clientId, drive);
  await provisionProject(db, projectId, drive);
  return { drive, folderId: projectScopes(db, projectId)[0]!.id };
};

describe('folder-batch Drive media resolution', () => {
  it('resolves each item independently and keeps an unresolvable item in the result', async () => {
    const { drive, folderId } = await setup();
    const media = new MockDriveMediaProvider();
    const goodId = 'good-file-123456789';
    const badId = 'bad-file-123456789';
    drive.seed(folderId, [
      [mockDriveFile(goodId, 'good.png'), mockDriveFile(badId, 'bad.txt')].map((file) => file),
    ]);
    media.seed(goodId);
    media.seed(badId, { mimeType: 'text/plain' });

    const result = await resolveDriveMediaBatch({
      db,
      projectId,
      provider: drive,
      mediaProvider: media,
      now: () => '2026-09-02T10:00:00.000Z',
    });

    expect(result.outcome).toBe('SUCCESS');
    expect(result.truncated).toBe(false);
    expect(result.items.map((item) => item.outcome)).toEqual(['RESOLVED', 'REFUSED']);
    expect(result.items[1]?.error).toMatch(/publisher accepts/i);
    expect(media.calls).toEqual([goodId, badId]);
  });

  it('refuses a folder outside the project before listing Drive', async () => {
    const { drive } = await setup();
    const media = new MockDriveMediaProvider();

    await expect(
      resolveDriveMediaBatch({
        db,
        projectId,
        folderId: 'someone-elses-folder',
        provider: drive,
        mediaProvider: media,
      }),
    ).rejects.toThrow(/not part of this project/i);
    expect(drive.listCalls).toEqual([]);
  });

  it('returns named truncation metadata instead of a partial batch', async () => {
    const { drive, folderId } = await setup();
    const media = new MockDriveMediaProvider();
    const files = Array.from({ length: SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS + 1 }, (_, index) => {
      const id = `batch-file-${String(index).padStart(3, '0')}-id`;
      media.seed(id);
      return mockDriveFile(id, `${index}.png`);
    });
    drive.seed(folderId, [files]);

    const result = await resolveDriveMediaBatch({
      db,
      projectId,
      provider: drive,
      mediaProvider: media,
    });

    expect(result).toMatchObject({
      outcome: 'REFUSED',
      code: 'DRIVE_MEDIA_BATCH_LIMIT_EXCEEDED',
      maxItems: SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS,
      truncated: true,
      listedItemCount: SIGNAL_DRIVE_MEDIA_BATCH_MAX_ITEMS + 1,
      items: [],
    });
    expect(media.calls).toEqual([]);
  });

  it('refuses when either Drive capability is disconnected', async () => {
    const { drive, folderId } = await setup();
    const media = new MockDriveMediaProvider();
    drive.connected = false;
    await expect(
      resolveDriveMediaBatch({ db, projectId, folderId, provider: drive, mediaProvider: media }),
    ).rejects.toThrow(/Drive is not connected/i);

    drive.connected = true;
    await expect(
      resolveDriveMediaBatch({
        db,
        projectId,
        folderId,
        provider: drive,
        mediaProvider: new DisconnectedDriveMediaProvider(),
      }),
    ).rejects.toThrow(/media cannot be checked/i);
  });

  it('refuses a project without a provisioned folder', async () => {
    const drive = new MockDriveProvider();
    const media = new MockDriveMediaProvider();
    await expect(
      resolveDriveMediaBatch({ db, projectId, provider: drive, mediaProvider: media }),
    ).rejects.toThrow(/no Drive folder/i);
  });

  it('refuses a repeated Drive page token instead of looping', async () => {
    const { drive, folderId } = await setup();
    const media = new MockDriveMediaProvider();
    const original = drive.listFiles.bind(drive);
    drive.listFiles = async (input) => {
      if (input.pageToken) return { files: [], nextPageToken: input.pageToken };
      const first = await original(input);
      return { ...first, nextPageToken: 'repeated-token' };
    };

    await expect(
      resolveDriveMediaBatch({ db, projectId, folderId, provider: drive, mediaProvider: media }),
    ).rejects.toThrow(/repeated page token/i);
  });
});
