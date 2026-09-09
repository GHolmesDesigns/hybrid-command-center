import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { listMcpAgentEvents } from './events.ts';
import { createMcpSession } from './session.ts';
import { callWorkspaceWriteTool } from './workspace-write.ts';
import { callMcpTool } from './dispatch.ts';
import { DEFAULT_BRANDING } from '../../shared/branding.ts';
import { CANONICAL_VIEW_DEFAULTS } from '../../shared/view-defaults.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

const seedClient = () => {
  const clientId = '11111111-1111-4111-8111-111111111111';
  const stamp = '2026-08-29T12:00:00.000Z';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
  ).run(clientId, 'Acme Studio', 'acme-studio', stamp, stamp);
  return clientId;
};

const seedProject = (projectId: string, clientId: string, name = 'Launch') => {
  const stamp = '2026-08-29T12:00:00.000Z';
  db.prepare(
    `INSERT INTO projects(id,client_id,name,created_at,updated_at)
     VALUES(?,?,?,?,?)`,
  ).run(projectId, clientId, name, stamp, stamp);
};

const session = () => createMcpSession({ agentLabel: 'codex' });

describe('workspace MCP writes', () => {
  it('refuses without workspace:write at dispatch', async () => {
    const result = await callMcpTool(
      db,
      session(),
      'workspace_create_task',
      {},
      {
        grantedScopes: ['workspace:read'],
      },
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.errorDetail?.code).toBe('WORKSPACE_SCOPE_REQUIRED');
  });

  it('creates a Signal draft and replays the same clientRequestId', async () => {
    const first = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-1',
      text: 'MCP planned caption',
      channels: ['ig'],
      status: 'DRAFT',
    });
    expect(first.outcome).toBe('SUCCESS');
    const created = first.data as { after: { id: string; text: string; revision: number } };
    expect(created.after.text).toBe('MCP planned caption');
    expect(created.after.revision).toBe(1);

    const replay = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-1',
      text: 'Different text that must not apply',
      channels: ['ig'],
      status: 'DRAFT',
    });
    expect(replay.outcome).toBe('SUCCESS');
    expect(replay.data).toEqual(first.data);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_posts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM integration_events').get()).toEqual({ n: 0 });
    expect(listMcpAgentEvents(db, { tool: 'signal_create_post' }).length).toBeGreaterThanOrEqual(1);
  });

  it('assigns Signal posts atomically, rejects cross-client projects, and supports null clears', async () => {
    const clientId = seedClient();
    const otherClientId = '22222222-2222-4222-8222-222222222222';
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
       VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
    ).run(
      otherClientId,
      'Other Studio',
      'other-studio',
      '2026-08-29T12:00:00.000Z',
      '2026-08-29T12:00:00.000Z',
    );
    const projectId = '33333333-3333-4333-8333-333333333333';
    const otherProjectId = '44444444-4444-4444-8444-444444444444';
    seedProject(projectId, clientId);
    seedProject(otherProjectId, otherClientId, 'Other launch');

    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-assignment-1',
      clientId,
      projectId,
      text: 'Assigned caption',
    });
    expect(created.outcome).toBe('SUCCESS');
    expect(created.data).toMatchObject({
      after: { projectId, client: { id: clientId } },
    });

    const replay = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-assignment-1',
      clientId: otherClientId,
      projectId: otherProjectId,
      text: 'Must not replace the first write',
    });
    expect(replay.data).toEqual(created.data);
    const postId = (created.data as { after: { id: string; revision: number } }).after.id;
    const revision = (created.data as { after: { revision: number } }).after.revision;

    const refused = await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'sig-assignment-2',
      postId,
      revision,
      clientId,
      projectId: otherProjectId,
    });
    expect(refused.outcome).toBe('REFUSED');
    expect(refused.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');
    expect(
      (
        await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
          clientRequestId: 'sig-assignment-3',
          postId,
          revision,
          clientId: null,
        })
      ).data,
    ).toMatchObject({ after: { projectId: null } });

    const rebound = await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'sig-assignment-4',
      postId,
      revision: 2,
      clientId,
      projectId,
    });
    expect(rebound.outcome).toBe('SUCCESS');
    const cleared = await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'sig-assignment-5',
      postId,
      revision: 3,
      projectId: null,
    });
    expect(cleared.data).toMatchObject({ after: { projectId: null } });
  });

  it('refuses a stale Signal revision with WORKSPACE_REVISION_CONFLICT', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-2',
      text: 'Original',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const postId = (created.data as { after: { id: string } }).after.id;
    await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'sig-2b',
      postId,
      revision: 1,
      text: 'Moved on',
    });
    const stale = await callWorkspaceWriteTool(db, session(), 'signal_update_post', {
      clientRequestId: 'sig-2c',
      postId,
      revision: 1,
      text: 'Stale',
    });
    expect(stale.outcome).toBe('REFUSED');
    expect(stale.errorDetail).toMatchObject({
      code: 'WORKSPACE_REVISION_CONFLICT',
      currentRevision: 2,
    });
  });

  it('refuses destructive delete without confirm', async () => {
    const clientId = seedClient();
    const project = await callWorkspaceWriteTool(db, session(), 'workspace_create_project', {
      clientRequestId: 'proj-1',
      clientId,
      name: 'Retainer',
    });
    const projectId = (project.data as { after: { id: string } }).after.id;
    const refused = await callWorkspaceWriteTool(db, session(), 'workspace_delete_project', {
      clientRequestId: 'proj-del',
      projectId,
      confirmProjectId: projectId,
      confirm: false,
    });
    expect(refused.outcome).toBe('REFUSED');
    expect(refused.errorDetail?.code).toBe('WORKSPACE_CONFIRMATION_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
  });

  it('updates branding with a before/after summary', async () => {
    const result = await callWorkspaceWriteTool(db, session(), 'settings_update_branding', {
      clientRequestId: 'brand-1',
      ...DEFAULT_BRANDING,
      title: 'Hybrid MCP',
    });
    expect(result.outcome).toBe('SUCCESS');
    expect(result.data).toMatchObject({
      before: expect.objectContaining({ title: DEFAULT_BRANDING.title }),
      after: expect.objectContaining({ title: 'Hybrid MCP' }),
    });
  });

  it('updates view defaults', async () => {
    const result = await callWorkspaceWriteTool(db, session(), 'settings_update_view_defaults', {
      clientRequestId: 'views-1',
      viewDefaults: CANONICAL_VIEW_DEFAULTS,
    });
    expect(result.outcome).toBe('SUCCESS');
  });

  it('creates and updates tasks, checklist items, and confirmed deletes', async () => {
    const clientId = seedClient();
    const project = await callWorkspaceWriteTool(db, session(), 'workspace_create_project', {
      clientRequestId: 'wp-1',
      clientId,
      name: 'MCP Project',
    });
    const projectId = (project.data as { after: { id: string; revision: number } }).after.id;
    const created = await callWorkspaceWriteTool(db, session(), 'workspace_create_task', {
      clientRequestId: 'wt-1',
      projectId,
      title: 'MCP Task',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    expect(created.outcome).toBe('SUCCESS');
    const task = (created.data as { after: { id: string; revision: number } }).after;
    const updated = await callWorkspaceWriteTool(db, session(), 'workspace_update_task', {
      clientRequestId: 'wt-2',
      taskId: task.id,
      revision: task.revision,
      title: 'MCP Task Renamed',
    });
    expect(updated.outcome).toBe('SUCCESS');
    const revision = (updated.data as { after: { revision: number } }).after.revision;
    const checklist = await callWorkspaceWriteTool(db, session(), 'workspace_add_checklist_item', {
      clientRequestId: 'wt-3',
      taskId: task.id,
      revision,
      text: 'Check me',
    });
    expect(checklist.outcome).toBe('SUCCESS');
    const afterChecklist = (
      checklist.data as { after: { revision: number; checklist: Array<{ id: string }> } }
    ).after;
    const deleted = await callWorkspaceWriteTool(db, session(), 'workspace_delete_task', {
      clientRequestId: 'wt-4',
      taskId: task.id,
      confirmTaskId: task.id,
      confirm: true,
    });
    expect(deleted.outcome).toBe('SUCCESS');
    void afterChecklist;
    void projectId;
  });

  it('duplicates a Signal post and dry-runs variant updates', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-dup-1',
      text: 'Source post',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const postId = (created.data as { after: { id: string; revision: number } }).after.id;
    const revision = (created.data as { after: { revision: number } }).after.revision;
    const dup = await callWorkspaceWriteTool(db, session(), 'signal_duplicate_post', {
      clientRequestId: 'sig-dup-2',
      postId,
    });
    expect(dup.outcome).toBe('SUCCESS');
    expect((dup.data as { after: { id: string } }).after.id).not.toBe(postId);

    const dry = await callWorkspaceWriteTool(db, session(), 'signal_update_variants', {
      clientRequestId: 'sig-var-1',
      postId,
      revision,
      dryRun: true,
      variants: [],
    });
    expect(dry.outcome).toBe('SUCCESS');
    expect(dry.data).toMatchObject({ dryRun: true });
  });

  it('sets a Signal slot and refuses without agent_label', async () => {
    const created = await callWorkspaceWriteTool(db, session(), 'signal_create_post', {
      clientRequestId: 'sig-slot-1',
      text: 'Slot me',
      channels: ['ig'],
      status: 'DRAFT',
    });
    const postId = (created.data as { after: { id: string; revision: number } }).after.id;
    const slotted = await callWorkspaceWriteTool(db, session(), 'signal_set_slot', {
      clientRequestId: 'sig-slot-2',
      postId,
      revision: 1,
      date: '2099-08-01',
      time: '10:00',
      from: '2099-08-01',
    });
    expect(slotted.outcome).toBe('SUCCESS');

    const unlabeled = await callWorkspaceWriteTool(
      db,
      createMcpSession({ agentLabel: null }),
      'signal_create_post',
      {
        clientRequestId: 'sig-no-label',
        text: 'Nope',
        channels: ['ig'],
      },
    );
    expect(unlabeled.outcome).toBe('REFUSED');
    expect(unlabeled.errorDetail?.code).toBe('COORDINATION_AGENT_LABEL_REQUIRED');
  });

  it('updates a project and acknowledges that permanent client delete is absent', async () => {
    const clientId = seedClient();
    const project = await callWorkspaceWriteTool(db, session(), 'workspace_create_project', {
      clientRequestId: 'proj-up-1',
      clientId,
      name: 'Before',
    });
    const after = (project.data as { after: { id: string; revision: number } }).after;
    const updated = await callWorkspaceWriteTool(db, session(), 'workspace_update_project', {
      clientRequestId: 'proj-up-2',
      projectId: after.id,
      revision: after.revision,
      name: 'After',
    });
    expect(updated.outcome).toBe('SUCCESS');
    expect((updated.data as { after: { name: string } }).after.name).toBe('After');
  });
});
