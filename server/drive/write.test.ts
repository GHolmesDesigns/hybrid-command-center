import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import {
  commitDriveWrite,
  DisconnectedDriveWriteProvider,
  DRIVE_UPLOAD_MAX_BYTES,
  previewDriveFolderCreate,
  previewDriveUpload,
  type DriveWriteProvider,
} from './write.ts';
import { GoogleDriveWriteProvider } from './google.ts';

let db: Db;
const projectId = crypto.randomUUID();
const folderId = 'project-drive-folder';

class WriteProvider implements DriveWriteProvider {
  connected = true;
  folders: string[] = [];
  uploads: { name: string; bytes: Uint8Array }[] = [];
  async createFolder(input: { name: string; parentId: string }) {
    this.folders.push(`${input.parentId}:${input.name}`);
    return { id: 'new-folder', name: input.name, url: 'https://drive.test/new-folder' };
  }
  async uploadFile(input: { name: string; mimeType: string; parentId: string; bytes: Uint8Array }) {
    this.uploads.push({ name: input.name, bytes: input.bytes });
    return {
      id: 'new-file',
      name: input.name,
      mimeType: input.mimeType,
      url: 'https://drive.test/new-file',
      modifiedAt: null,
      size: input.bytes.length,
    };
  }
}

beforeEach(() => {
  db = createDb(':memory:');
  const stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO clients(id,name,slug,drive_status,created_at,updated_at) VALUES(?, 'Client', 'client', 'CONNECTED', ?, ?)",
  ).run(crypto.randomUUID(), stamp, stamp);
  db.prepare(
    "INSERT INTO projects(id,client_id,name,status,priority,drive_status,drive_folder_id,drive_folder_url,created_at,updated_at) VALUES(?,(SELECT id FROM clients LIMIT 1),'Project','ACTIVE','HIGH','CONNECTED',?,'https://drive.test/project',?,?)",
  ).run(projectId, folderId, stamp, stamp);
});

describe('confirmed Drive writes', () => {
  it('previews and commits a folder only when the exact confirmation survives', async () => {
    const provider = new WriteProvider();
    const preview = previewDriveFolderCreate(db, {
      projectId,
      parentId: folderId,
      name: 'Assets',
    });
    await expect(
      commitDriveWrite(db, preview.plan, preview.planHash, provider),
    ).resolves.toMatchObject({
      id: 'new-folder',
    });
    expect(provider.folders).toEqual([`${folderId}:Assets`]);
    expect(
      db.prepare('SELECT operation,outcome,summary FROM integration_events').get(),
    ).toMatchObject({ operation: 'drive.create-folder', outcome: 'SUCCESS' });
  });

  it('refuses a stale upload confirmation without contacting Drive', async () => {
    const provider = new WriteProvider();
    const preview = previewDriveUpload(db, {
      projectId,
      folderId,
      name: 'brief.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    await expect(commitDriveWrite(db, preview.plan, '0'.repeat(64), provider)).rejects.toThrow(
      'stale',
    );
    expect(provider.uploads).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS count FROM integration_events').get()).toEqual({
      count: 0,
    });
  });

  it('uploads transient bytes and records a failure without leaking them to the audit log', async () => {
    const provider = new WriteProvider();
    provider.uploadFile = async () => {
      throw new Error('provider rejected secret=do-not-store');
    };
    const preview = previewDriveUpload(db, {
      projectId,
      folderId,
      name: 'brief.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    await expect(commitDriveWrite(db, preview.plan, preview.planHash, provider)).rejects.toThrow(
      'provider rejected',
    );
    const event = db
      .prepare('SELECT operation,outcome,error,summary FROM integration_events')
      .get() as Record<string, string>;
    expect(event).toMatchObject({ operation: 'drive.upload-file', outcome: 'FAILURE' });
    expect(event.error).toContain('secret=[redacted]');
    expect(event.summary).not.toContain('hello');
  });

  it('uploads the exact bytes from the confirmed preview', async () => {
    const provider = new WriteProvider();
    const preview = previewDriveUpload(db, {
      projectId,
      folderId,
      name: 'brief.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('hello').toString('base64'),
    });
    await commitDriveWrite(db, preview.plan, preview.planHash, provider);
    expect(Buffer.from(provider.uploads[0].bytes).toString()).toBe('hello');
    expect(provider.uploads[0].name).toBe('brief.txt');
  });

  it('refuses empty, invalid, and out-of-scope write targets', () => {
    expect(() =>
      previewDriveFolderCreate(db, {
        projectId: crypto.randomUUID(),
        parentId: folderId,
        name: 'Assets',
      }),
    ).toThrow('not part of this project');
    expect(() =>
      previewDriveFolderCreate(db, { projectId, parentId: 'other', name: 'Assets' }),
    ).toThrow('not part of this project');
    expect(() =>
      previewDriveFolderCreate(db, { projectId, parentId: folderId, name: ' ' }),
    ).toThrow('required');
    expect(() =>
      previewDriveUpload(db, {
        projectId,
        folderId,
        name: 'brief.txt',
        mimeType: 'text/plain',
        contentBase64: '',
      }),
    ).toThrow('empty');
    expect(() =>
      previewDriveUpload(db, {
        projectId,
        folderId,
        name: 'x'.repeat(201),
        mimeType: 'text/plain',
        contentBase64: Buffer.from('hello').toString('base64'),
      }),
    ).toThrow('too long');
    expect(() =>
      previewDriveUpload(db, {
        projectId,
        folderId,
        name: 'brief.txt',
        mimeType: ' ',
        contentBase64: Buffer.from('hello').toString('base64'),
      }),
    ).toThrow('MIME');
    expect(() =>
      previewDriveUpload(db, {
        projectId,
        folderId,
        name: 'brief.txt',
        mimeType: 'text/plain',
        contentBase64: Buffer.alloc(DRIVE_UPLOAD_MAX_BYTES + 1).toString('base64'),
      }),
    ).toThrow('10 MB');
  });

  it('has no connected write capability when Drive is disconnected', async () => {
    const provider = new DisconnectedDriveWriteProvider();
    expect(provider.connected).toBe(false);
    await expect(provider.createFolder({ name: 'Assets', parentId: folderId })).rejects.toThrow(
      'not connected',
    );
    await expect(
      provider.uploadFile({
        name: 'brief.txt',
        mimeType: 'text/plain',
        parentId: folderId,
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('not connected');
  });

  it('keeps the real provider write methods separate from the browse provider', async () => {
    const creates: unknown[] = [];
    const drive = {
      files: {
        create: async (input: unknown) => {
          creates.push(input);
          return {
            data: {
              id: 'uploaded',
              name: 'brief.txt',
              mimeType: 'text/plain',
              webViewLink: 'https://drive.test/uploaded',
              size: '5',
            },
          };
        },
      },
    };
    const provider = new GoogleDriveWriteProvider(drive as never);
    await expect(
      provider.createFolder({ name: 'Assets', parentId: folderId }),
    ).resolves.toMatchObject({ id: 'uploaded' });
    await expect(
      provider.uploadFile({
        name: 'brief.txt',
        mimeType: 'text/plain',
        parentId: folderId,
        bytes: new Uint8Array([1, 2]),
      }),
    ).resolves.toMatchObject({ id: 'uploaded', size: 5 });
    expect(creates).toHaveLength(2);
  });
});
