import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './db.ts';
import {
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  updateTask,
  WorkspaceConflictError,
} from './workspace/writes.ts';
import {
  archiveProjectTimeCategory,
  createProjectTimeCategory,
  createProjectTimeEntry,
  deleteProjectTimeEntry,
  listProjectTimeCategories,
  listProjectTimeEntries,
  projectTimeSummary,
  reorderProjectTimeCategories,
  updateProjectTimeBudget,
  updateProjectTimeEntry,
} from './project-time.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

let clientCounter = 0;
function project(name: string) {
  const clientId = `10000000-0000-4000-8000-${String(++clientCounter).padStart(12, '0')}`;
  const stamp = '2026-01-01T00:00:00.000Z';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
    VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
  ).run(clientId, name, `${name.toLowerCase()}-${clientCounter}`, stamp, stamp);
  return createProject(db, { clientId, name, status: 'ACTIVE', priority: 'MEDIUM' });
}

function entryInput(projectId: string, categoryId: string, taskId?: string) {
  return {
    categoryId,
    taskId: taskId ?? null,
    startDate: '2026-03-08',
    startTime: '01:00',
    endTime: '03:00',
    timeZone: 'America/New_York',
    notes: 'Work session',
  };
}

describe('project time persistence', () => {
  it('replaces default categories with active project categories and keeps archived labels readable', () => {
    const p = project('Studio');
    const defaults = listProjectTimeCategories(db, p.id);
    expect(
      defaults.filter((category) => category.selectable).map((category) => category.name),
    ).toContain('Design');
    const next = createProjectTimeCategory(db, p.id, { name: 'Writing' });
    const writing = next.find((category) => category.name === 'Writing')!;
    expect(next.find((category) => category.name === 'Design')?.selectable).toBe(false);
    const entry = createProjectTimeEntry(db, p.id, {
      categoryId: writing.id,
      startDate: '2026-03-08',
      startTime: '01:00',
      endTime: '03:00',
      timeZone: 'America/New_York',
      endAmbiguity: 'later',
      notes: '',
    });
    archiveProjectTimeCategory(db, p.id, writing.id);
    const archived = listProjectTimeCategories(db, p.id).find(
      (category) => category.id === writing.id,
    );
    expect(archived).toMatchObject({ name: 'Writing', selectable: false });
    expect(listProjectTimeEntries(db, p.id)[0].categoryName).toBe('Writing');
    expect(
      updateProjectTimeEntry(
        db,
        p.id,
        entry.id,
        {
          categoryId: writing.id,
          startDate: '2026-03-08',
          startTime: '01:00',
          endTime: '03:00',
          timeZone: 'America/New_York',
          notes: 'Updated entry',
        },
        entry.revision,
      ),
    ).toMatchObject({ categoryName: 'Writing', notes: 'Updated entry' });
  });

  it('keeps totals project-scoped and validates task ownership and duration', () => {
    const first = project('First');
    const second = project('Second');
    const task = createTask(db, {
      projectId: first.id,
      title: 'Draft',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const category = listProjectTimeCategories(db, first.id)[0];
    createProjectTimeEntry(db, first.id, entryInput(first.id, category.id, task.id));
    expect(projectTimeSummary(db, first.id)).toMatchObject({ totalSeconds: 3600, entryCount: 1 });
    expect(projectTimeSummary(db, second.id)).toMatchObject({ totalSeconds: 0, entryCount: 0 });
    expect(() =>
      createProjectTimeEntry(db, second.id, entryInput(second.id, category.id, task.id)),
    ).toThrow(/category|task/i);
    expect(() =>
      createProjectTimeEntry(db, first.id, {
        categoryId: category.id,
        startDate: '2026-03-08',
        startTime: '10:00',
        endTime: '09:00',
        timeZone: 'America/New_York',
        notes: '',
      }),
    ).toThrow(/end date|after start/i);
  });

  it('retargets entries with their task and leaves task-deleted entries on the project unassigned', () => {
    const source = project('Source');
    const destination = project('Destination');
    const task = createTask(db, {
      projectId: source.id,
      title: 'Move me',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const custom = createProjectTimeCategory(db, source.id, { name: 'Research' }).find(
      (item) => item.name === 'Research',
    )!;
    const created = createProjectTimeEntry(db, source.id, {
      categoryId: custom.id,
      taskId: task.id,
      startDate: '2026-01-02',
      startTime: '09:00',
      endTime: '10:00',
      timeZone: 'UTC',
      notes: '',
    });
    updateTask(db, task.id, { projectId: destination.id }, task.revision);
    expect(listProjectTimeEntries(db, source.id)).toHaveLength(0);
    expect(listProjectTimeEntries(db, destination.id)[0]).toMatchObject({
      id: created.id,
      taskId: task.id,
      categoryName: 'Research',
    });
    deleteTask(db, task.id);
    const retained = listProjectTimeEntries(db, destination.id)[0];
    expect(retained).not.toHaveProperty('taskId');
    expect(retained).not.toHaveProperty('taskTitle');
  });

  it('refuses project deletion before changing any saved time or project data', () => {
    const p = project('Protected');
    const category = listProjectTimeCategories(db, p.id)[0];
    createProjectTimeEntry(db, p.id, {
      categoryId: category.id,
      startDate: '2026-01-02',
      startTime: '09:00',
      endTime: '10:00',
      timeZone: 'UTC',
      notes: '',
    });
    expect(() => deleteProject(db, p.id)).toThrowError(
      expect.objectContaining<Partial<WorkspaceConflictError>>({
        code: 'PROJECT_HAS_TIME_ENTRIES',
      }),
    );
    expect(db.prepare('SELECT COUNT(*) count FROM projects WHERE id=?').get(p.id)).toMatchObject({
      count: 1,
    });
    expect(listProjectTimeEntries(db, p.id)).toHaveLength(1);
  });

  it('validates category ownership, uniqueness, ordering, and archival', () => {
    const p = project('Categories');
    const defaults = listProjectTimeCategories(db, p.id);
    expect(() => createProjectTimeCategory(db, 'not-a-project', { name: 'Custom' })).toThrow(
      /Project not found/,
    );
    const first = createProjectTimeCategory(db, p.id, { name: 'Research' }).find(
      (item) => item.name === 'Research',
    )!;
    expect(() => createProjectTimeCategory(db, p.id, { name: ' research ' })).toThrow(
      /already exists/,
    );
    const second = createProjectTimeCategory(db, p.id, { name: 'Writing' }).find(
      (item) => item.name === 'Writing',
    )!;
    expect(() => reorderProjectTimeCategories(db, p.id, [first.id])).toThrow(/Refresh/);
    expect(() => reorderProjectTimeCategories(db, p.id, [first.id, first.id])).toThrow(/Refresh/);
    expect(reorderProjectTimeCategories(db, p.id, [second.id, first.id])[0].id).toBe(second.id);
    expect(() => archiveProjectTimeCategory(db, p.id, defaults[0].id)).toThrow(
      /category not found/i,
    );
    archiveProjectTimeCategory(db, p.id, first.id);
    expect(() => archiveProjectTimeCategory(db, p.id, first.id)).toThrow(/category not found/i);
  });

  it('filters by task, category, operator-local date, and preserves entries on revision conflicts', () => {
    const p = project('Filters');
    const categories = listProjectTimeCategories(db, p.id);
    const task = createTask(db, {
      projectId: p.id,
      title: 'Task',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const one = createProjectTimeEntry(db, p.id, {
      categoryId: categories[0].id,
      taskId: task.id,
      startDate: '2026-01-02',
      startTime: '23:30',
      endDate: '2026-01-03',
      endTime: '00:30',
      timeZone: 'America/New_York',
      notes: '',
    });
    createProjectTimeEntry(db, p.id, {
      categoryId: categories[1].id,
      startDate: '2026-01-05',
      startTime: '09:00',
      endTime: '10:00',
      timeZone: 'UTC',
      notes: '',
    });
    expect(listProjectTimeEntries(db, p.id, { taskId: task.id })).toHaveLength(1);
    expect(listProjectTimeEntries(db, p.id, { categoryId: categories[1].id })).toHaveLength(1);
    expect(
      listProjectTimeEntries(db, p.id, {
        from: '2026-01-02',
        to: '2026-01-02',
        timeZone: 'America/New_York',
      }).map((entry) => entry.id),
    ).toEqual([one.id]);
    expect(listProjectTimeEntries(db, p.id, { from: '2026-01-08' })).toEqual([]);
    expect(() =>
      listProjectTimeEntries(db, p.id, { from: '2026-01-01', timeZone: 'Bad/Zone' }),
    ).toThrow();
    expect(() => listProjectTimeEntries(db, 'not-a-project')).toThrow(/Project not found/);
  });

  it('rejects invalid entries and handles missing or stale entry revisions without writing', () => {
    const p = project('Validation');
    const other = project('Other');
    const category = listProjectTimeCategories(db, p.id)[0];
    const task = createTask(db, {
      projectId: other.id,
      title: 'Wrong project',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    expect(() => createProjectTimeEntry(db, p.id, entryInput(p.id, category.id, task.id))).toThrow(
      /task that belongs/,
    );
    expect(() =>
      createProjectTimeEntry(db, p.id, { ...entryInput(p.id, category.id), categoryId: other.id }),
    ).toThrow();
    expect(() =>
      createProjectTimeEntry(db, p.id, {
        categoryId: category.id,
        startDate: '2026-03-08',
        startTime: '02:30',
        endTime: '03:30',
        timeZone: 'America/New_York',
        notes: '',
      }),
    ).toThrow(/does not exist/);
    const entry = createProjectTimeEntry(db, p.id, {
      categoryId: category.id,
      startDate: '2026-01-01',
      startTime: '09:00',
      endTime: '10:00',
      timeZone: 'UTC',
      notes: '',
    });
    expect(() =>
      updateProjectTimeEntry(
        db,
        p.id,
        entry.id,
        {
          categoryId: category.id,
          startDate: '2026-01-01',
          startTime: '09:00',
          endTime: '10:00',
          timeZone: 'UTC',
          notes: '',
        },
        entry.revision + 1,
      ),
    ).toThrow(/changed/);
    expect(() =>
      updateProjectTimeEntry(db, p.id, 'missing', entryInput(p.id, category.id), 1),
    ).toThrow(/not found/i);
    expect(() => deleteProjectTimeEntry(db, p.id, 'missing', 1)).toThrow(/not found/i);
    expect(() => deleteProjectTimeEntry(db, p.id, entry.id, entry.revision + 1)).toThrow(/changed/);
    expect(listProjectTimeEntries(db, p.id)).toHaveLength(1);
    expect(deleteProjectTimeEntry(db, p.id, entry.id, entry.revision)).toMatchObject({ ok: true });
  });

  it('updates project budgets with revision checking and supports clearing the budget', () => {
    const p = project('Budget');
    const revision = p.revision;
    expect(updateProjectTimeBudget(db, p.id, { minutes: 762 }, revision)).toEqual({
      budgetMinutes: 762,
    });
    expect(() => updateProjectTimeBudget(db, p.id, { minutes: 1 }, revision)).toThrow(/changed/);
    const current = db.prepare('SELECT revision FROM projects WHERE id=?').get(p.id) as {
      revision: number;
    };
    expect(updateProjectTimeBudget(db, p.id, { minutes: null }, current.revision)).toEqual({
      budgetMinutes: null,
    });
    expect(() => updateProjectTimeBudget(db, p.id, { minutes: 0 }, current.revision)).toThrow();
    expect(() => updateProjectTimeBudget(db, 'missing', { minutes: 10 }, current.revision)).toThrow(
      /Project not found/,
    );
  });
});
