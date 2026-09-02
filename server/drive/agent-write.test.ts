import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { requestDriveWrite, decideDriveWrite, listDriveWriteRequests } from './agent-write.ts';
import {
  commitDriveWrite,
  previewDriveFolderCreate,
  previewDriveUpload,
  type DriveWriteProvider,
} from './write.ts';

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

  it('lists pending requests separately from decided history', async () => {
    const pending = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Pending',
      clientRequestId: 'request-pending',
    });
    const denied = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Denied',
      clientRequestId: 'request-denied',
    });
    await decideDriveWrite(db, denied.id, 'deny', new Provider());
    expect(listDriveWriteRequests(db, 'PENDING').map((request) => request.id)).toEqual([
      pending.id,
    ]);
    expect(listDriveWriteRequests(db).map((request) => request.id)).toHaveLength(2);
  });

  it('refuses an unowned folder and an oversized upload before creating a request', () => {
    expect(() =>
      requestDriveWrite(db, 'planner', {
        kind: 'create-folder',
        projectId,
        parentId: 'another-project-folder',
        name: 'Escape',
        clientRequestId: 'request-unowned',
      }),
    ).toThrow('not part of this project');
    expect(() =>
      requestDriveWrite(db, 'planner', {
        kind: 'upload-file',
        projectId,
        folderId,
        name: 'too-large.bin',
        mimeType: 'application/octet-stream',
        contentBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
        clientRequestId: 'request-too-large',
      }),
    ).toThrow('exceeds the 10 MB limit');
    expect(listDriveWriteRequests(db)).toHaveLength(0);
  });

  it('keeps idempotency scoped to the requesting agent', () => {
    const input = {
      kind: 'create-folder' as const,
      projectId,
      parentId: folderId,
      name: 'Shared',
      clientRequestId: 'same-client-id',
    };
    const plannerRequest = requestDriveWrite(db, 'planner', input);
    const reviewerRequest = requestDriveWrite(db, 'reviewer', input);
    expect(reviewerRequest.id).not.toBe(plannerRequest.id);
    expect(listDriveWriteRequests(db)).toHaveLength(2);
  });

  it('replays the persisted plan when an agent reuses an id with new input', () => {
    const original = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Original',
      clientRequestId: 'replayed-plan',
    });
    const replay = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Changed after submission',
      clientRequestId: 'replayed-plan',
    });
    expect(replay).toEqual(original);
    expect(listDriveWriteRequests(db)).toHaveLength(1);
  });

  it('allows only one concurrent approval to claim a request', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Once',
      clientRequestId: 'concurrent-approval',
    });
    const provider = new Provider();
    const results = await Promise.allSettled([
      decideDriveWrite(db, request.id, 'approve', provider),
      decideDriveWrite(db, request.id, 'approve', provider),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(provider.writes).toBe(1);
    expect(listDriveWriteRequests(db)[0]).toMatchObject({ status: 'APPROVED' });
  });

  it('audits a failed upload without exposing its bytes', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'upload-file',
      projectId,
      folderId,
      name: 'private.txt',
      mimeType: 'text/plain',
      contentBase64: Buffer.from('private bytes').toString('base64'),
      clientRequestId: 'upload-failure',
    });
    const provider = new Provider();
    provider.uploadFile = async () => {
      throw new Error('upload failed');
    };
    await expect(decideDriveWrite(db, request.id, 'approve', provider)).rejects.toThrow(
      'upload failed',
    );
    const audit = db
      .prepare(
        "SELECT outcome,summary,error FROM integration_events WHERE operation='drive.agent-write-request' ORDER BY rowid DESC",
      )
      .get() as { outcome: string; summary: string; error: string | null };
    expect(audit).toMatchObject({ outcome: 'FAILURE', error: 'upload failed' });
    expect(audit.summary).not.toContain('private bytes');
  });

  it('persists a bounded fallback when the provider rejects without an Error', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Unknown failure',
      clientRequestId: 'non-error-failure',
    });
    const provider = new Provider();
    provider.createFolder = async () => {
      throw 'provider rejected';
    };
    await expect(decideDriveWrite(db, request.id, 'approve', provider)).rejects.toBe(
      'provider rejected',
    );
    expect(
      db
        .prepare('SELECT status,error,decided_at FROM drive_write_requests WHERE id=?')
        .get(request.id),
    ).toMatchObject({ status: 'FAILED', error: 'Drive write failed.' });
    expect(provider.writes).toBe(0);
  });

  it('rejects invalid folder and upload previews before any request is persisted', () => {
    expect(() =>
      previewDriveFolderCreate(db, { projectId, parentId: folderId, name: '   ' }),
    ).toThrow('Folder name is required');
    expect(() =>
      previewDriveFolderCreate(db, { projectId, parentId: folderId, name: 'x'.repeat(201) }),
    ).toThrow('Folder name is too long');
    expect(() =>
      previewDriveUpload(db, {
        projectId,
        folderId,
        name: 'file.txt',
        mimeType: '   ',
        contentBase64: 'aGVsbG8=',
      }),
    ).toThrow('valid MIME type');
    expect(() =>
      previewDriveUpload(db, {
        projectId,
        folderId,
        name: 'file.txt',
        mimeType: 'text/plain',
        contentBase64: '',
      }),
    ).toThrow('empty or exceeds');
    expect(listDriveWriteRequests(db)).toHaveLength(0);
  });

  it('refuses a stale confirmation without calling the provider', async () => {
    const request = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId,
      parentId: folderId,
      name: 'Stale',
      clientRequestId: 'stale-confirmation',
    });
    const provider = new Provider();
    const stalePlan = { ...request.plan, name: 'Changed after approval' };
    await expect(commitDriveWrite(db, stalePlan, request.planHash, provider)).rejects.toThrow(
      'confirmation is stale',
    );
    expect(provider.writes).toBe(0);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM integration_events WHERE operation='drive.create-folder'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});
