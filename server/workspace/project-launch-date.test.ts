import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { backup, DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { restoreDatabase } from '../backup.ts';
import { commitPlaybook, previewPlaybook } from '../import.ts';
import { callWorkspaceWriteTool } from '../mcp/workspace-write.ts';
import { createMcpSession } from '../mcp/session.ts';

const stamp = '2026-08-29T12:00:00.000Z';
const revisionOf = (db: Db, projectId: string) =>
  (db.prepare('SELECT revision FROM projects WHERE id=?').get(projectId) as { revision: number })
    .revision;

describe('project launch date', () => {
  it('migrates existing databases with null launch dates', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-529-')), 'legacy.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'ACTIVE',
        drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', start_date TEXT, target_deadline TEXT,
        priority TEXT NOT NULL DEFAULT 'MEDIUM', position INTEGER NOT NULL DEFAULT 0,
        drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        last_activity_at TEXT, revision INTEGER NOT NULL DEFAULT 1
      );
    `);
    legacy
      .prepare(
        `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
         VALUES('c1','Acme','acme','ACTIVE','DISCONNECTED',?,?)`,
      )
      .run(stamp, stamp);
    legacy
      .prepare(
        `INSERT INTO projects(id,client_id,name,status,start_date,target_deadline,priority,position,drive_status,created_at,updated_at,last_activity_at,revision)
         VALUES('p1','c1','Retainer','ACTIVE','2026-03-01','2026-04-01','HIGH',0,'DISCONNECTED',?,?,?,1)`,
      )
      .run(stamp, stamp, stamp);
    legacy.close();

    const db = createDb(file);
    const columns = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(columns).toContain('launch_date');
    expect(
      db.prepare('SELECT launch_date FROM projects WHERE id=?').get('p1') as { launch_date: null },
    ).toEqual({ launch_date: null });
    db.close();
  });

  it('accepts real launch dates, rejects invalid ones, and preserves neighboring fields', async () => {
    const db = createDb(':memory:');
    const clientId = '11111111-1111-4111-8111-111111111111';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Acme', 'acme', stamp, stamp);
    const app = createApp(db);

    await request(app)
      .post('/api/projects')
      .send({
        clientId,
        name: 'Launch track',
        startDate: '2026-03-01',
        launchDate: '2026-02-30',
        targetDeadline: '2026-04-01',
      })
      .expect(400);

    const created = (
      await request(app)
        .post('/api/projects')
        .send({
          clientId,
          name: 'Launch track',
          startDate: '2026-03-01',
          launchDate: '2026-05-15',
          targetDeadline: '2026-06-01',
        })
        .expect(201)
    ).body;
    expect(created.launchDate).toBe('2026-05-15');
    expect(created.startDate).toBe('2026-03-01');
    expect(created.targetDeadline).toBe('2026-06-01');

    const updated = (
      await request(app)
        .patch(`/api/projects/${created.id}`)
        .send({
          launchDate: '2026-05-20',
          revision: revisionOf(db, created.id),
        })
        .expect(200)
    ).body;
    expect(updated.launchDate).toBe('2026-05-20');
    expect(updated.startDate).toBe('2026-03-01');
    expect(updated.targetDeadline).toBe('2026-06-01');

    const cleared = (
      await request(app)
        .patch(`/api/projects/${created.id}`)
        .send({ launchDate: '', revision: revisionOf(db, created.id) })
        .expect(200)
    ).body;
    expect(cleared.launchDate).toBeUndefined();
    expect(cleared.startDate).toBe('2026-03-01');
    expect(cleared.targetDeadline).toBe('2026-06-01');
  });

  it('refuses stale project revisions when launch date changes', async () => {
    const db = createDb(':memory:');
    const clientId = '22222222-2222-4222-8222-222222222222';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Bravo', 'bravo', stamp, stamp);
    const app = createApp(db);
    const project = (
      await request(app)
        .post('/api/projects')
        .send({ clientId, name: 'Held launch', launchDate: '2026-07-01' })
        .expect(201)
    ).body;

    await request(app)
      .patch(`/api/projects/${project.id}`)
      .send({ notes: 'Kickoff moved', revision: project.revision })
      .expect(200);

    const stale = await request(app)
      .patch(`/api/projects/${project.id}`)
      .send({ launchDate: '2026-07-15', revision: project.revision })
      .expect(409);
    expect(stale.body.error).toMatch(/changed after it was read/i);
  });

  it('round-trips launch date through MCP and playbook import', async () => {
    const db = createDb(':memory:');
    const clientId = '33333333-3333-4333-8333-333333333333';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Studio', 'studio', stamp, stamp);
    const session = createMcpSession({ agentLabel: 'codex' });

    const created = await callWorkspaceWriteTool(db, session, 'workspace_create_project', {
      clientRequestId: 'launch-create',
      clientId,
      name: 'Imported launch',
      launchDate: '2026-08-01',
      targetDeadline: '2026-09-01',
    });
    expect(created.outcome).toBe('SUCCESS');
    const project = (created.data as { after: { id: string; revision: number; launchDate?: string } })
      .after;
    expect(project.launchDate).toBe('2026-08-01');

    const updated = await callWorkspaceWriteTool(db, session, 'workspace_update_project', {
      clientRequestId: 'launch-update',
      projectId: project.id,
      revision: project.revision,
      launchDate: '2026-08-10',
    });
    expect(updated.outcome).toBe('SUCCESS');
    expect((updated.data as { after: { launchDate?: string; targetDeadline?: string } }).after).toEqual(
      expect.objectContaining({ launchDate: '2026-08-10', targetDeadline: '2026-09-01' }),
    );

    const playbook = [
      '[Clients]',
      'client_key\tname\tcontact_name\temail\tphone\twebsite\tnotes',
      'CLI-N\tNorthwind\tAlex North\talex@example.com\t\t\t',
      '[Projects]',
      'project_key\tclient_key\tname\tstatus\tpriority\tstart_date\tlaunch_date\ttarget_deadline\tdescription\tnotes\tposition',
      'PRJ-N\tCLI-N\tNorth launch\tACTIVE\tMEDIUM\t2026-01-01\t2026-02-01\t2026-03-01\t\t\t1',
      '[Tasks]',
      'task_key\tproject_key\ttitle\ttask_type\tstatus\tpriority\tstart_date\tdue_date\tdescription\tnotes\tposition',
    ].join('\n');
    const preview = previewPlaybook(db, { text: playbook });
    expect(preview.issues).toEqual([]);
    commitPlaybook(db, { text: playbook, fingerprint: preview.fingerprint });
    const imported = db
      .prepare('SELECT launch_date, target_deadline FROM projects WHERE name=?')
      .get('North launch') as { launch_date: string; target_deadline: string };
    expect(imported).toEqual({ launch_date: '2026-02-01', target_deadline: '2026-03-01' });
  });

  it('preserves launch date through backup and restore', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-529-backup-'));
    const sourcePath = path.join(dir, 'live.db');
    const backupPath = path.join(dir, 'snapshot.db');
    const restorePath = path.join(dir, 'restored.db');

    const db = createDb(sourcePath);
    const clientId = '44444444-4444-4444-8444-444444444444';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(clientId, 'Delta', 'delta', stamp, stamp);
    const projectId = '55555555-5555-4555-8555-555555555555';
    db.prepare(
      `INSERT INTO projects(id,client_id,name,status,start_date,launch_date,target_deadline,priority,position,drive_status,created_at,updated_at,last_activity_at)
       VALUES(?,?,?,'ACTIVE',?,?,?,'MEDIUM',0,'DISCONNECTED',?,?,?)`,
    ).run(projectId, clientId, 'Backup launch', '2026-01-01', '2026-02-01', '2026-03-01', stamp, stamp, stamp);
    db.close();

    const source = new DatabaseSync(sourcePath);
    await backup(source, backupPath);
    source.close();

    await restoreDatabase({ backupPath, destinationPath: restorePath, force: true });

    const restored = new DatabaseSync(restorePath, { readOnly: true });
    expect(
      restored.prepare('SELECT launch_date FROM projects WHERE id=?').get(projectId) as {
        launch_date: string;
      },
    ).toEqual({ launch_date: '2026-02-01' });
    restored.close();
  });
});
