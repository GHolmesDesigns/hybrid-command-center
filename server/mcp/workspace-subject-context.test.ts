import { beforeEach, describe, expect, it } from 'vitest';
import { format, subDays } from 'date-fns';
import { createDb, type Db } from '../db.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import { postHandoff } from '../agent-coordination/service.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { callWorkspaceReadTool } from './workspace-read.ts';
import { buildSubjectContext, buildWorkspaceSearch } from './workspace-subject-context.ts';
import {
  MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT,
  MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT,
  MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT,
  MCP_WORKSPACE_SEARCH_TOTAL_LIMIT,
} from '../../shared/mcp-read-tools.ts';

const NOW = new Date('2026-08-11T12:00:00.000Z');

let db: Db;

const addClient = (id: string, name: string, status = 'ACTIVE') =>
  db
    .prepare(
      `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DISCONNECTED', ?, ?)`,
    )
    .run(id, name, `slug-${id}`, status, NOW.toISOString(), NOW.toISOString());

const addProject = (id: string, clientId: string, name: string, status = 'ACTIVE') =>
  db
    .prepare(
      `INSERT INTO projects (id, client_id, name, status, priority, position, drive_status,
         created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'MEDIUM', 0, 'DISCONNECTED', ?, ?, ?)`,
    )
    .run(id, clientId, name, status, NOW.toISOString(), NOW.toISOString(), NOW.toISOString());

const addTask = (
  id: string,
  projectId: string,
  title: string,
  extra: { status?: string; dueDate?: string | null } = {},
) =>
  db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, due_date,
         position, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'MEDIUM', ?, 0, ?, ?)`,
    )
    .run(
      id,
      projectId,
      title,
      extra.status ?? 'TODO',
      extra.dueDate ?? format(subDays(NOW, 1), 'yyyy-MM-dd'),
      NOW.toISOString(),
      NOW.toISOString(),
    );

beforeEach(() => {
  db = createDb(':memory:');
  addClient('c1', 'Acme Studio');
  addProject('p1', 'c1', 'Identity System');
});

describe('buildSubjectContext', () => {
  it('returns a task with parents, blocking dependencies, handoffs, and activity', () => {
    addTask('blocker', 'p1', 'Blocker task', { status: 'TODO' });
    addTask('target', 'p1', 'Target task');
    db.prepare('INSERT INTO task_dependencies(task_id, dependency_id) VALUES (?, ?)').run(
      'target',
      'blocker',
    );
    postHandoff(
      db,
      {
        fromAgentLabel: 'planner',
        subjectType: 'task',
        subjectId: 'target',
        message: 'Please finish the target task.',
      },
      NOW,
    );
    recordIntegrationEvent(db, {
      source: 'campaign-playbook',
      operation: 'playbook.import',
      outcome: 'SUCCESS',
      summary: 'Imported one task.',
      entities: [{ type: 'task', id: 'target', label: 'Target task' }],
    });

    const context = buildSubjectContext(db, { subjectType: 'task', subjectId: 'target' });
    expect(context).toMatchObject({
      subjectType: 'task',
      subjectId: 'target',
      caps: {
        relatedHandoffs: MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT,
        recentActivity: MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT,
      },
      entity: { id: 'target', title: 'Target task' },
      parents: {
        project: { id: 'p1', name: 'Identity System' },
        client: { id: 'c1', name: 'Acme Studio' },
      },
      blockingDependencies: [{ id: 'blocker', title: 'Blocker task' }],
      relatedHandoffs: [
        expect.objectContaining({ subjectType: 'task', subjectId: 'target', state: 'OPEN' }),
      ],
      recentActivity: [expect.objectContaining({ summary: 'Imported one task.' })],
      truncated: { relatedHandoffs: false, recentActivity: false },
    });
  });

  it('returns a project with its client parent', () => {
    const context = buildSubjectContext(db, { subjectType: 'project', subjectId: 'p1' });
    expect(context?.entity).toMatchObject({ id: 'p1', name: 'Identity System' });
    expect(context?.parents.client).toMatchObject({ id: 'c1', name: 'Acme Studio' });
    expect(context?.parents.project).toBeUndefined();
  });

  it('returns a client without parents', () => {
    const context = buildSubjectContext(db, { subjectType: 'client', subjectId: 'c1' });
    expect(context?.entity).toMatchObject({ id: 'c1', name: 'Acme Studio' });
    expect(context?.parents).toEqual({});
  });

  it('returns a signal post without parents', () => {
    const post = seedSignalPost(db, { id: 'post-1', text: 'Launch week caption' });
    const context = buildSubjectContext(db, { subjectType: 'signal_post', subjectId: post.id });
    expect(context?.entity).toMatchObject({ id: post.id, text: 'Launch week caption' });
    expect(context?.parents).toEqual({});
  });

  it('returns null for unknown subjects and freeform', () => {
    expect(buildSubjectContext(db, { subjectType: 'task', subjectId: 'missing' })).toBeNull();
    expect(buildSubjectContext(db, { subjectType: 'freeform', subjectId: 'anything' })).toBeNull();
  });

  it('caps related handoffs and activity', () => {
    addTask('t1', 'p1', 'Capped task');
    for (let index = 0; index < MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT + 2; index += 1) {
      postHandoff(
        db,
        {
          fromAgentLabel: 'planner',
          subjectType: 'task',
          subjectId: 't1',
          message: `Handoff ${index}`,
        },
        new Date(NOW.getTime() + index),
      );
    }
    for (let index = 0; index < MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT + 3; index += 1) {
      recordIntegrationEvent(db, {
        source: 'campaign-playbook',
        operation: 'playbook.import',
        outcome: 'SUCCESS',
        summary: `Activity ${index}`,
        entities: [{ type: 'task', id: 't1', label: 'Capped task' }],
      });
    }

    const context = buildSubjectContext(db, { subjectType: 'task', subjectId: 't1' });
    expect(context?.relatedHandoffs).toHaveLength(MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT);
    expect(context?.recentActivity).toHaveLength(MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT);
    expect(context?.truncated).toEqual({ relatedHandoffs: true, recentActivity: true });
  });
});

describe('buildWorkspaceSearch', () => {
  it('returns typed matches across workspace tables with declared caps', () => {
    addClient('c2', 'Beta Branding');
    addProject('p2', 'c1', 'Beta Launch');
    addTask('t-search', 'p1', 'Beta checklist');
    seedSignalPost(db, { id: 'post-beta', text: 'Beta announcement copy' });

    const payload = buildWorkspaceSearch(db, { query: 'beta' });
    expect(payload.query).toBe('beta');
    expect(payload.caps).toEqual({
      perType: MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT,
      total: MCP_WORKSPACE_SEARCH_TOTAL_LIMIT,
    });
    expect(payload.results).toEqual(
      expect.arrayContaining([
        { subjectType: 'client', subjectId: 'c2', label: 'Beta Branding', matchField: 'name' },
        { subjectType: 'project', subjectId: 'p2', label: 'Beta Launch', matchField: 'name' },
        {
          subjectType: 'task',
          subjectId: 't-search',
          label: 'Beta checklist',
          matchField: 'title',
        },
        {
          subjectType: 'signal_post',
          subjectId: 'post-beta',
          label: 'Beta announcement copy',
          matchField: 'text',
        },
      ]),
    );
    expect(payload.truncated).toBe(false);
  });

  it('enforces the per-type cap and reports truncation', () => {
    for (let index = 0; index < MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT + 2; index += 1) {
      addTask(`task-${index}`, 'p1', `Match ${index}`);
    }
    const payload = buildWorkspaceSearch(db, { query: 'Match' });
    expect(payload.results).toHaveLength(MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT);
    expect(payload.truncated).toBe(true);
  });
});

describe('callWorkspaceReadTool subject tools', () => {
  it('maps unknown subjects to structured not-found failures', async () => {
    const missing = await callWorkspaceReadTool(db, 'workspace_get_subject_context', {
      subjectType: 'project',
      subjectId: 'missing',
    });
    expect(missing.outcome).toBe('FAILURE');
    expect(missing.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');

    const freeform = await callWorkspaceReadTool(db, 'workspace_get_subject_context', {
      subjectType: 'freeform',
      subjectId: 'note-1',
    });
    expect(freeform.outcome).toBe('FAILURE');
    expect(freeform.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');
  });

  it('redacts credential-shaped search queries and rejects short queries', async () => {
    const short = await callWorkspaceReadTool(db, 'workspace_search', { query: 'a' });
    expect(short.outcome).toBe('FAILURE');
    expect(short.errorDetail?.code).toBe('COORDINATION_INVALID_ARGUMENTS');

    const redacted = await callWorkspaceReadTool(db, 'workspace_search', {
      query: 'token=ya29.secret-value',
    });
    expect(redacted.outcome).toBe('SUCCESS');
    expect((redacted.data as { query: string }).query).toContain('[redacted]');
  });
});
