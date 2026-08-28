import { beforeEach, describe, expect, it, vi } from 'vitest';
import { format, subDays } from 'date-fns';
import { createDb, type Db } from '../db.ts';
import { callWorkspaceReadTool } from './workspace-read.ts';
import { PublishService } from '../publish/service.ts';
import { LocalSignalProvider } from '../signal/read.ts';
import { MockPublishProvider } from '../publish/mock-provider.ts';
import { DisconnectedDriveMediaProvider } from '../drive/media.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import {
  MCP_DASHBOARD_TASK_LIMIT,
  MCP_QUEUE_UNSCHEDULED_LIMIT,
  MCP_TASK_LIST_DEFAULT_LIMIT,
  MCP_TASK_LIST_MAX_LIMIT,
} from '../../shared/mcp-read-tools.ts';
import { SIGNAL_RANGE_LIMIT } from '../../shared/signal.ts';

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

const addTask = (id: string, projectId: string, title: string) =>
  db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, due_date,
         position, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'TODO', 'MEDIUM', ?, 0, ?, ?)`,
    )
    .run(
      id,
      projectId,
      title,
      format(subDays(NOW, 2), 'yyyy-MM-dd'),
      NOW.toISOString(),
      NOW.toISOString(),
    );

beforeEach(() => {
  db = createDb(':memory:');
  addClient('c1', 'Acme Studio');
  addProject('p1', 'c1', 'Identity System');
});

describe('callWorkspaceReadTool', () => {
  it('returns dashboard summary with capped task buckets', async () => {
    for (let index = 0; index < MCP_DASHBOARD_TASK_LIMIT + 5; index += 1) {
      addTask(`t-${index}`, 'p1', `Task ${index}`);
    }
    const result = await callWorkspaceReadTool(db, 'workspace_dashboard_summary', {}, { now: NOW });
    expect(result.outcome).toBe('SUCCESS');
    const data = result.data as {
      overdueTasks: unknown[];
      truncated?: { overdueTasks: boolean };
    };
    expect(data.overdueTasks.length).toBeLessThanOrEqual(MCP_DASHBOARD_TASK_LIMIT);
    expect(data.truncated?.overdueTasks).toBe(true);
  });

  it('lists active tasks with pagination and refuses uncapped overflow', async () => {
    for (let index = 0; index < MCP_TASK_LIST_MAX_LIMIT + 10; index += 1) {
      addTask(`task-${index}`, 'p1', `Listed ${index}`);
    }
    const page = await callWorkspaceReadTool(db, 'workspace_list_tasks', { limit: 25, offset: 0 });
    expect(page.outcome).toBe('SUCCESS');
    const payload = page.data as { tasks: unknown[]; limit: number; truncated: boolean };
    expect(payload.tasks).toHaveLength(25);
    expect(payload.limit).toBe(25);
    expect(payload.truncated).toBe(true);

    const defaultPage = await callWorkspaceReadTool(db, 'workspace_list_tasks', {});
    const defaultPayload = defaultPage.data as { limit: number };
    expect(defaultPayload.limit).toBe(MCP_TASK_LIST_DEFAULT_LIMIT);
  });

  it('lists signal posts in range with truncation flag from the read service', async () => {
    for (let index = 0; index < SIGNAL_RANGE_LIMIT + 2; index += 1) {
      seedSignalPost(db, {
        id: `post-${index}`,
        date: '2027-08-14',
        text: `Post ${index}`,
      });
    }
    const result = await callWorkspaceReadTool(db, 'signal_list_posts', {
      from: '2027-08-01',
      to: '2027-08-31',
    });
    expect(result.outcome).toBe('SUCCESS');
    const data = result.data as { posts: unknown[]; truncated: boolean };
    expect(data.posts.length).toBe(SIGNAL_RANGE_LIMIT);
    expect(data.truncated).toBe(true);
  });

  it('returns queue snapshot with capped unscheduled and upcoming posts', async () => {
    for (let index = 0; index < MCP_QUEUE_UNSCHEDULED_LIMIT + 3; index += 1) {
      seedSignalPost(db, { id: `queue-${index}`, date: null, position: index });
    }
    seedSignalPost(db, { id: 'dated', date: '2026-08-15' });
    const result = await callWorkspaceReadTool(db, 'signal_queue_snapshot', {}, { now: NOW });
    expect(result.outcome).toBe('SUCCESS');
    const data = result.data as {
      unscheduled: unknown[];
      upcoming: unknown[];
      truncated: { unscheduled: boolean };
    };
    expect(data.unscheduled.length).toBe(MCP_QUEUE_UNSCHEDULED_LIMIT);
    expect(data.truncated.unscheduled).toBe(true);
    expect(data.upcoming.some((post) => (post as { id?: string }).id === 'dated')).toBe(true);
  });

  it('returns queue health from the existing service', async () => {
    const result = await callWorkspaceReadTool(db, 'signal_queue_health', {}, { now: NOW });
    expect(result.outcome).toBe('SUCCESS');
    expect(result.data).toMatchObject({
      counts: expect.objectContaining({ action: expect.any(Number) }),
    });
  });

  it('builds publish preview without contacting the provider or Drive', async () => {
    const post = seedSignalPost(db, { date: '2027-08-14', channels: ['x'] });
    const provider = new MockPublishProvider([]);
    const listTargets = vi
      .spyOn(provider, 'listTargets')
      .mockRejectedValue(new Error('no network'));
    const drive = new DisconnectedDriveMediaProvider();
    const getFileSpy = vi.spyOn(drive, 'getFile').mockRejectedValue(new Error('no drive'));
    const publisher = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => NOW,
      drive,
    );
    const result = await callWorkspaceReadTool(
      db,
      'signal_publish_preview',
      { postId: post.id },
      { previewPublisher: publisher, now: NOW },
    );
    expect(result.outcome).toBe('SUCCESS');
    expect(listTargets).not.toHaveBeenCalled();
    expect(getFileSpy).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({ postId: post.id, available: expect.any(Boolean) });
  });

  it('refuses invalid date ranges and missing posts', async () => {
    const range = await callWorkspaceReadTool(db, 'signal_list_posts', {
      from: '2027-08-31',
      to: '2027-08-01',
    });
    expect(range.outcome).toBe('FAILURE');

    const missing = await callWorkspaceReadTool(db, 'signal_publish_preview', {
      postId: 'missing-post',
    });
    expect(missing.outcome).toBe('FAILURE');
    expect(missing.errorDetail?.code).toBe('COORDINATION_NOT_FOUND');
  });
});
