import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './db.ts';
import { createProject, createTask } from './workspace/writes.ts';
import {
  createProjectTimeEntry,
  listProjectTimeCategories,
  updateTaskTimeBudget,
} from './project-time.ts';
import {
  filterWorkspaceTimeEntries,
  listWorkspaceTimeEntries,
  workspaceTimeDashboard,
} from './workspace-time.ts';

let db: Db;
let counter = 0;
beforeEach(() => {
  db = createDb(':memory:');
  counter = 0;
});

function project(name: string) {
  const id = `10000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;
  const at = '2026-11-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
    VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
  ).run(id, name, name.toLowerCase(), at, at);
  return createProject(db, { clientId: id, name, status: 'ACTIVE', priority: 'MEDIUM' });
}

describe('workspace time report reads', () => {
  it('filters entries by operator-local day and linked project, task, and category', () => {
    const p = project('Studio');
    const task = createTask(db, {
      projectId: p.id,
      title: 'Research',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const category = listProjectTimeCategories(db, p.id)[0]!;
    createProjectTimeEntry(db, p.id, {
      categoryId: category.id,
      taskId: task.id,
      startDate: '2026-11-08',
      startTime: '00:30',
      endDate: '2026-11-08',
      endTime: '01:30',
      timeZone: 'America/New_York',
      notes: 'Late shift',
    });
    const entries = listWorkspaceTimeEntries(db);
    expect(
      filterWorkspaceTimeEntries(entries, {
        from: '2026-11-08',
        to: '2026-11-08',
        projectId: p.id,
        taskId: task.id,
        categoryId: category.id,
        timeZone: 'America/New_York',
      }),
    ).toHaveLength(1);
    expect(
      filterWorkspaceTimeEntries(entries, {
        from: '2026-11-09',
        to: '2026-11-09',
        timeZone: 'UTC',
      }),
    ).toHaveLength(0);
  });

  it('counts Monday–Sunday logged time and active over-budget tasks without writing', () => {
    const p = project('Studio');
    const task = createTask(db, {
      projectId: p.id,
      title: 'Research',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const category = listProjectTimeCategories(db, p.id)[0]!;
    createProjectTimeEntry(db, p.id, {
      categoryId: category.id,
      taskId: task.id,
      startDate: '2026-11-02',
      startTime: '00:00',
      endDate: '2026-11-02',
      endTime: '01:00',
      timeZone: 'America/New_York',
      notes: '',
    });
    updateTaskTimeBudget(db, task.id, { minutes: 30 }, task.revision);
    const before = db.prepare('SELECT COUNT(*) count FROM time_entries').get() as { count: number };
    const changes = db.prepare('SELECT COUNT(*) count FROM mcp_change_feed').get() as {
      count: number;
    };
    const summary = workspaceTimeDashboard(
      db,
      new Date('2026-11-08T16:00:00.000Z'),
      'America/New_York',
    );
    expect(summary).toEqual({ loggedSeconds: 3600, overBudgetTasks: 1 });
    expect(db.prepare('SELECT COUNT(*) count FROM time_entries').get()).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) count FROM mcp_change_feed').get()).toEqual(changes);
  });
});
