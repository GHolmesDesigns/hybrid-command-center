import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { PROJECT_SUBFOLDERS } from '../config.ts';
import { MockDriveProvider } from './mock-provider.ts';
import {
  deleteSetting,
  provisionClient,
  provisionProject,
  setSetting,
  syncAllToDrive,
} from './service.ts';

let db: Db, clientId: string, projectId: string;
beforeEach(() => {
  db = createDb(':memory:');
  clientId = crypto.randomUUID();
  projectId = crypto.randomUUID();
  const stamp = new Date().toISOString();
  db.prepare(
    "INSERT INTO clients(id,name,slug,drive_status,created_at,updated_at) VALUES(?,?,'client','PENDING',?,?)",
  ).run(clientId, 'Client', stamp, stamp);
  db.prepare(
    "INSERT INTO projects(id,client_id,name,status,priority,drive_status,created_at,updated_at) VALUES(?,?,'Project','ACTIVE','HIGH','PENDING',?,?)",
  ).run(projectId, clientId, stamp, stamp);
  setSetting(db, 'drive_root_id', 'root');
});
describe('Drive provisioning', () => {
  it('creates the configured hierarchy idempotently', async () => {
    const drive = new MockDriveProvider();
    await provisionClient(db, clientId, drive);
    await provisionProject(db, projectId, drive);
    await provisionProject(db, projectId, drive);
    expect(drive.folders.size).toBe(2 + PROJECT_SUBFOLDERS.length);
    expect(
      (db.prepare('SELECT drive_status FROM projects WHERE id=?').get(projectId) as any)
        .drive_status,
    ).toBe('CONNECTED');
  });
  it('records partial failure and safely resumes without duplicate folders', async () => {
    const drive = new MockDriveProvider();
    drive.failOn = '03_Working_Files';
    await expect(provisionProject(db, projectId, drive)).rejects.toThrow('Temporary');
    const partial = db
      .prepare('SELECT drive_folder_id,drive_status FROM projects WHERE id=?')
      .get(projectId) as any;
    expect(partial.drive_folder_id).toBeTruthy();
    expect(partial.drive_status).toBe('FAILED');
    await provisionProject(db, projectId, drive);
    expect(drive.folders.size).toBe(2 + PROJECT_SUBFOLDERS.length);
    expect((db.prepare('SELECT COUNT(*) count FROM drive_steps').get() as any).count).toBe(
      PROJECT_SUBFOLDERS.length,
    );
  });

  it('provisionClient refuses an unknown client', async () => {
    await expect(provisionClient(db, 'missing', new MockDriveProvider())).rejects.toThrow(
      'Client not found.',
    );
  });

  it('provisionClient returns the existing folder without calling the provider', async () => {
    db.prepare("UPDATE clients SET drive_folder_id='folder-existing' WHERE id=?").run(clientId);
    const drive = new MockDriveProvider();
    await expect(provisionClient(db, clientId, drive)).resolves.toBe('folder-existing');
    expect(drive.calls).toEqual([]);
  });

  it('provisionClient marks a disconnected provider rather than calling it', async () => {
    const drive = new MockDriveProvider();
    drive.connected = false;
    await expect(provisionClient(db, clientId, drive)).resolves.toBeUndefined();
    const row = db.prepare('SELECT drive_status FROM clients WHERE id=?').get(clientId) as any;
    expect(row.drive_status).toBe('DISCONNECTED');
    expect(drive.calls).toEqual([]);
  });

  it('provisionClient waits for a root folder before calling the provider', async () => {
    deleteSetting(db, 'drive_root_id');
    const drive = new MockDriveProvider();
    await expect(provisionClient(db, clientId, drive)).resolves.toBeUndefined();
    const row = db
      .prepare('SELECT drive_status,drive_error FROM clients WHERE id=?')
      .get(clientId) as any;
    expect(row.drive_status).toBe('PENDING');
    expect(row.drive_error).toMatch(/root folder/);
    expect(drive.calls).toEqual([]);
  });

  it('provisionProject refuses an unknown project', async () => {
    await expect(provisionProject(db, 'missing', new MockDriveProvider())).rejects.toThrow(
      'Project not found.',
    );
  });

  it('provisionProject marks a disconnected provider rather than calling it', async () => {
    const drive = new MockDriveProvider();
    drive.connected = false;
    await provisionProject(db, projectId, drive);
    const row = db.prepare('SELECT drive_status FROM projects WHERE id=?').get(projectId) as any;
    expect(row.drive_status).toBe('DISCONNECTED');
    expect(drive.calls).toEqual([]);
  });

  it("provisionProject waits when the client's own folder is not ready", async () => {
    deleteSetting(db, 'drive_root_id');
    const drive = new MockDriveProvider();
    await provisionProject(db, projectId, drive);
    const row = db
      .prepare('SELECT drive_status,drive_error FROM projects WHERE id=?')
      .get(projectId) as any;
    expect(row.drive_status).toBe('PENDING');
    expect(row.drive_error).toMatch(/Client Drive folder is not ready/);
  });
});

describe('syncAllToDrive', () => {
  it('reports disconnected without touching either table', async () => {
    const drive = new MockDriveProvider();
    drive.connected = false;
    const result = await syncAllToDrive(db, drive);
    expect(result).toEqual({
      connected: false,
      message: 'Connect Google Drive and choose a root folder in Settings before syncing.',
      clients: [],
      projects: [],
    });
  });

  it('reports a missing root folder once connected', async () => {
    deleteSetting(db, 'drive_root_id');
    const result = await syncAllToDrive(db, new MockDriveProvider());
    expect(result.connected).toBe(true);
    expect(result.message).toMatch(/Select a Command Center root folder/);
    expect(result.clients).toEqual([]);
  });

  it('provisions every active client and project, and reports which failed', async () => {
    const drive = new MockDriveProvider();
    drive.failOn = '03_Working_Files';
    const result = await syncAllToDrive(db, drive);
    expect(result.connected).toBe(true);
    expect(result.clients).toEqual([{ id: clientId, name: 'Client', ok: true }]);
    expect(result.projects).toEqual([
      { id: projectId, name: 'Project', ok: false, error: expect.stringContaining('Temporary') },
    ]);
    expect(result.message).toMatch(/1 issue/);
  });

  it('reports a clean sync when nothing fails', async () => {
    const result = await syncAllToDrive(db, new MockDriveProvider());
    expect(result.connected).toBe(true);
    expect(result.clients).toEqual([{ id: clientId, name: 'Client', ok: true }]);
    expect(result.projects).toEqual([{ id: projectId, name: 'Project', ok: true }]);
    expect(result.message).toBe('Synced 1 client and 1 project to Drive.');
  });
});
