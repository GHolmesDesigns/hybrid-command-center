import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { requestDriveWrite, decideDriveWrite } from './agent-write.ts';
import type { DriveWriteProvider } from './write.ts';

let db: Db;
const projectId = crypto.randomUUID();
const folderId = 'project-folder';

class Provider implements DriveWriteProvider {
  connected = true;
  writes = 0;
  async createFolder(input: { name: string; parentId: string }) {
    this.writes++;
    return { id: 'created', name: input.name, url: 'https://drive.test/created' };
  }
  async uploadFile(input: { name: string; mimeType: string; parentId: string; bytes: Uint8Array }) {
    this.writes++;
    return {
      id: 'uploaded',
      name: input.name,
      mimeType: input.mimeType,
      url: 'https://drive.test/uploaded',
      modifiedAt: null,
      size: input.bytes.length,
    };
  }
}

beforeEach(() => {
  db = createDb(':memory:');
  const stamp = new Date().toISOString();
  const clientId = crypto.randomUUID();
  db.prepare('INSERT INTO clients(id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?)').run(
    clientId,
    'Client',
    'client',
    stamp,
    stamp,
  );
  db.prepare(
    "INSERT INTO projects(id,client_id,name,status,priority,drive_folder_id,drive_folder_url,created_at,updated_at) VALUES(?,?,?,'ACTIVE','HIGH',?,?,?,?)",
  ).run(projectId, clientId, 'Project', folderId, 'https://drive.test/project', stamp, stamp);
});

describe('agent Drive write approval', () => {
  it('creates a pending request without contacting Drive and replays idempotently', () => {
    const input = {
      kind: 'create-folder' as const,
      projectId,
      parentId: folderId,
      name: 'Assets',
      clientRequestId: 'request-1',
    };
    const first = requestDriveWrite(db, 'planner', input);
    const second = requestDriveWrite(db, 'planner', input);
    expect(first).toMatchObject({
      status: 'PENDING',
      confirmation: 'Create folder "Assets" in "Project folder".',
    });
    expect(second.id).toBe(first.id);
    expect(db.prepare('SELECT COUNT(*) AS count FROM integration_events').get()).toEqual({
      count: 1,
    });
  });

  it('denies without contacting Drive and refuses duplicate decisions', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Assets',
      clientRequestId: 'request-2',
    });
    const provider = new Provider();
    await expect(decideDriveWrite(db, request.id, 'deny', provider)).resolves.toMatchObject({
      status: 'DENIED',
    });
    expect(provider.writes).toBe(0);
    await expect(decideDriveWrite(db, request.id, 'deny', provider)).rejects.toThrow(
      'already decided',
    );
  });

  it('executes only after approval and preserves exact upload bytes', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'upload-file',
      projectId,
      folderId,
      name: 'brief.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('hello').toString('base64'),
      clientRequestId: 'request-3',
    });
    const provider = new Provider();
    await expect(decideDriveWrite(db, request.id, 'approve', provider)).resolves.toMatchObject({
      status: 'APPROVED',
    });
    expect(provider.writes).toBe(1);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM integration_events WHERE operation='drive.upload-file' AND outcome='SUCCESS'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it('records provider failures and makes the request terminal', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Broken',
      clientRequestId: 'request-failure',
    });
    const provider = new Provider();
    provider.createFolder = async () => {
      throw new Error('provider rejected secret=hidden');
    };
    await expect(decideDriveWrite(db, request.id, 'approve', provider)).rejects.toThrow(
      'provider rejected',
    );
    expect(
      db.prepare('SELECT status,error FROM drive_write_requests WHERE id=?').get(request.id),
    ).toMatchObject({ status: 'FAILED', error: 'provider rejected secret=[redacted]' });
    await expect(decideDriveWrite(db, request.id, 'approve', provider)).rejects.toThrow(
      'already decided',
    );
  });

  it('rejects unknown requests before any provider call', async () => {
    await expect(
      decideDriveWrite(db, 'missing-request', 'approve', new Provider()),
    ).rejects.toThrow('not found');
  });
});
