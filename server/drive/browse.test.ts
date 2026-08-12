import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { PROJECT_SUBFOLDERS } from '../config.ts';
import { DisconnectedDriveProvider } from './provider.ts';
import { MockDriveProvider, mockDriveFile } from './mock-provider.ts';
import { DriveScopeError, listProjectFiles, projectScopes } from './browse.ts';
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
    "INSERT INTO projects(id,client_id,name,status,priority,drive_status,created_at,updated_at) VALUES(?,?,'Spring Campaign','ACTIVE','HIGH','PENDING',?,?)",
  ).run(projectId, clientId, stamp, stamp);
  setSetting(db, 'drive_root_id', 'root');
});

/** A project with its Drive folder and every subfolder provisioning records. */
const provisioned = async (drive = new MockDriveProvider()) => {
  await provisionClient(db, clientId, drive);
  await provisionProject(db, projectId, drive);
  return drive;
};

describe('read-only Drive browsing', () => {
  it('offers the project folder and its provisioned subfolders as the only scopes', async () => {
    await provisioned();
    const scopes = projectScopes(db, projectId);
    expect(scopes).toHaveLength(1 + PROJECT_SUBFOLDERS.length);
    expect(scopes[0].name).toBe('Project folder');
    expect(scopes.slice(1).map((scope) => scope.name)).toEqual([...PROJECT_SUBFOLDERS]);
    // Every scope carries an ID; nothing downstream may match a folder by name alone.
    expect(scopes.every((scope) => Boolean(scope.id))).toBe(true);
  });

  it('lists the project folder by default and pages forward with Drive’s own token', async () => {
    const drive = await provisioned();
    const folderId = projectScopes(db, projectId)[0].id;
    drive.seed(folderId, [
      [mockDriveFile('f1', 'Brief.pdf'), mockDriveFile('f2', 'Storyboard.png')],
      [mockDriveFile('f3', 'Final cut.mp4')],
    ]);

    const first = await listProjectFiles(db, projectId, { provider: drive, pageSize: 2 });
    expect(first?.state).toBe('READY');
    expect(first?.folder?.id).toBe(folderId);
    expect(first?.files.map((file) => file.name)).toEqual(['Brief.pdf', 'Storyboard.png']);
    expect(first?.nextPageToken).toBeTruthy();

    const second = await listProjectFiles(db, projectId, {
      provider: drive,
      pageToken: first!.nextPageToken!,
    });
    expect(second?.files.map((file) => file.name)).toEqual(['Final cut.mp4']);
    expect(second?.nextPageToken).toBeNull();
    expect(drive.listCalls[0].pageToken).toBeUndefined();
    expect(drive.listCalls[1].pageToken).toBe(first!.nextPageToken);
  });

  it('lists a named subfolder by ID', async () => {
    const drive = await provisioned();
    const working = projectScopes(db, projectId).find(
      (scope) => scope.name === '03_Working_Files',
    )!;
    drive.seed(working.id, [[mockDriveFile('f9', 'Working draft.ai')]]);

    const listing = await listProjectFiles(db, projectId, {
      provider: drive,
      folderId: working.id,
    });
    expect(listing?.folder?.name).toBe('03_Working_Files');
    expect(listing?.files.map((file) => file.name)).toEqual(['Working draft.ai']);
  });

  it('refuses a folder that is not this project’s rather than fetching it', async () => {
    const drive = await provisioned();
    await expect(
      listProjectFiles(db, projectId, { provider: drive, folderId: 'someone-elses-folder' }),
    ).rejects.toBeInstanceOf(DriveScopeError);
    // The point of the refusal: Drive was never asked.
    expect(drive.listCalls).toHaveLength(0);
  });

  it('reports an empty folder as ready with nothing in it', async () => {
    const drive = await provisioned();
    const listing = await listProjectFiles(db, projectId, { provider: drive });
    expect(listing?.state).toBe('READY');
    expect(listing?.files).toEqual([]);
    expect(listing?.nextPageToken).toBeNull();
  });

  it('separates missing credentials from a Drive that is merely not connected', async () => {
    const provider = new DisconnectedDriveProvider();
    expect((await listProjectFiles(db, projectId, { provider, configured: false }))?.state).toBe(
      'NOT_CONFIGURED',
    );
    expect((await listProjectFiles(db, projectId, { provider, configured: true }))?.state).toBe(
      'NOT_CONNECTED',
    );
  });

  it('reports a project that has no Drive folder yet as its own state', async () => {
    const listing = await listProjectFiles(db, projectId, { provider: new MockDriveProvider() });
    expect(listing?.state).toBe('NO_FOLDER');
    expect(listing?.scopes).toEqual([]);
    expect(listing?.projectName).toBe('Spring Campaign');
  });

  it('carries a failed Drive call as a state, with what Drive said', async () => {
    const drive = await provisioned();
    drive.listError = 'Rate limit exceeded';
    const listing = await listProjectFiles(db, projectId, { provider: drive });
    expect(listing?.state).toBe('FAILED');
    expect(listing?.error).toBe('Rate limit exceeded');
    expect(listing?.files).toEqual([]);
    // The folder is still named, because the connection and the folder are both fine.
    expect(listing?.folder?.name).toBe('Project folder');
  });

  it('answers with nothing for a project that does not exist', async () => {
    expect(
      await listProjectFiles(db, crypto.randomUUID(), { provider: new MockDriveProvider() }),
    ).toBeUndefined();
  });
});
