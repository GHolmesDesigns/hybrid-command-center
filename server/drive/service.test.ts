import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { PROJECT_SUBFOLDERS } from '../config.ts';
import { MockDriveProvider } from './mock-provider.ts';
import { provisionClient, provisionProject, setSetting } from './service.ts';

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
});
