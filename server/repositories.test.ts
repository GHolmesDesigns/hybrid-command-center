import { beforeEach, describe, expect, it } from 'vitest';
import { addDays, format, subDays } from 'date-fns';
import { createDb, type Db } from './db.ts';
import {
  getCategory,
  getTask,
  hydrateTask,
  listActiveTasks,
  listCategories,
  listClients,
  listProjects,
  listTags,
  listTasks,
} from './repositories.ts';

/**
 * The read layer every endpoint answers through. What it does to a row — the column-name
 * shape, the absent-versus-null distinction, the flags it calculates rather than stores —
 * is contract for the client, and none of it is visible from an assertion on one endpoint's
 * body. These go straight at the functions instead.
 */

const NOW = '2026-08-11T12:00:00.000Z';
const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');
const past = format(subDays(new Date(), 3), 'yyyy-MM-dd');

let db: Db;

const addClient = (id: string, name: string, status = 'ACTIVE') =>
  db
    .prepare(
      `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DISCONNECTED', ?, ?)`,
    )
    .run(id, name, `${name.toLowerCase().replace(/\W+/g, '-')}-${id}`, status, NOW, NOW);

const addProject = (
  id: string,
  clientId: string,
  name: string,
  status = 'ACTIVE',
  lastActivityAt: string | null = NOW,
) =>
  db
    .prepare(
      `INSERT INTO projects (id, client_id, name, status, priority, position, drive_status,
         created_at, updated_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'MEDIUM', 0, 'DISCONNECTED', ?, ?, ?)`,
    )
    .run(id, clientId, name, status, NOW, NOW, lastActivityAt);

const addTask = (
  id: string,
  projectId: string,
  title: string,
  extra: { status?: string; dueDate?: string | null; description?: string | null } = {},
) =>
  db
    .prepare(
      `INSERT INTO tasks (id, project_id, title, description, status, priority, due_date,
         position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'MEDIUM', ?, 0, ?, ?)`,
    )
    .run(
      id,
      projectId,
      title,
      extra.description ?? null,
      extra.status ?? 'TODO',
      extra.dueDate ?? null,
      NOW,
      NOW,
    );

beforeEach(() => {
  db = createDb(':memory:');
  addClient('c1', 'Acme Studio');
  addProject('p1', 'c1', 'Identity System');
});

describe('row shaping', () => {
  it('hands every column back in camelCase', () => {
    addTask('t1', 'p1', 'Build concepts', { dueDate: day(2) });
    const task = getTask(db, 't1') as unknown as Record<string, unknown>;
    expect(task).toMatchObject({
      id: 't1',
      projectId: 'p1',
      projectName: 'Identity System',
      clientId: 'c1',
      clientName: 'Acme Studio',
      dueDate: day(2),
      createdAt: NOW,
      updatedAt: NOW,
    });
    // The snake_case originals do not survive alongside the camelCase ones.
    expect(Object.keys(task)).not.toContain('project_id');
    expect(Object.keys(task)).not.toContain('due_date');
  });

  it('turns a SQL NULL into an absent value rather than an explicit null', () => {
    // This is what lets `JSON.stringify` drop the key, which is the difference the PATCH
    // schemas rest on: an omitted key keeps the stored value, an explicit null clears it.
    addTask('t1', 'p1', 'Build concepts');
    const task = getTask(db, 't1') as unknown as Record<string, unknown>;
    expect(task.description).toBeUndefined();
    expect(task.dueDate).toBeUndefined();
    expect(JSON.parse(JSON.stringify(task))).not.toHaveProperty('dueDate');
  });
});

describe('hydrateTask', () => {
  const raw = (id: string) =>
    db
      .prepare(
        `SELECT t.*, p.name project_name, p.client_id, c.name client_name FROM tasks t
         JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id WHERE t.id=?`,
      )
      .get(id);

  it('counts checklist progress and reads the stored integer as a boolean', () => {
    addTask('t1', 'p1', 'Build concepts');
    for (const [id, text, completed, position] of [
      ['i1', 'Sketch', 1, 0],
      ['i2', 'Review', 0, 1],
      ['i3', 'Ship', 0, 2],
    ] as const)
      db.prepare(
        'INSERT INTO checklist_items (id, task_id, text, completed, position) VALUES (?, ?, ?, ?, ?)',
      ).run(id, 't1', text, completed, position);

    const task = hydrateTask(db, raw('t1'));
    expect({ done: task.checklistCompleted, total: task.checklistTotal }).toEqual({
      done: 1,
      total: 3,
    });
    // SQLite has no boolean type; the client checkbox needs a real one.
    expect(task.checklist.map((item) => item.completed)).toEqual([true, false, false]);
    expect(task.checklist.map((item) => item.text)).toEqual(['Sketch', 'Review', 'Ship']);
  });

  it('reports an empty checklist as zero of zero, not as missing', () => {
    addTask('t1', 'p1', 'Build concepts');
    const task = hydrateTask(db, raw('t1'));
    expect({ done: task.checklistCompleted, total: task.checklistTotal }).toEqual({
      done: 0,
      total: 0,
    });
    expect(task.checklist).toEqual([]);
  });

  it('calculates blocked from the dependencies that are still open', () => {
    addTask('t1', 'p1', 'Launch');
    addTask('t2', 'p1', 'Groundwork');
    db.prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)').run(
      't1',
      't2',
    );

    const blocked = hydrateTask(db, raw('t1'));
    expect(blocked.blocked).toBe(true);
    expect(blocked.dependencyIds).toEqual(['t2']);
    expect(blocked.blockingDependencies).toEqual([{ id: 't2', title: 'Groundwork' }]);

    db.prepare("UPDATE tasks SET status='COMPLETE' WHERE id='t2'").run();
    const unblocked = hydrateTask(db, raw('t1'));
    // The edge is still stored — only the blocking half of it went away.
    expect(unblocked.blocked).toBe(false);
    expect(unblocked.dependencyIds).toEqual(['t2']);
    expect(unblocked.blockingDependencies).toEqual([]);
  });

  it('calculates overdue by the shared deadline rule, finished work included', () => {
    addTask('late', 'p1', 'Late', { dueDate: past });
    addTask('soon', 'p1', 'Soon', { dueDate: day(2) });
    addTask('lateButDone', 'p1', 'Late but done', { dueDate: past, status: 'COMPLETE' });
    addTask('undated', 'p1', 'Undated');

    const overdue = Object.fromEntries(
      listTasks(db).map((task) => [task.id, task.overdue]),
    ) as Record<string, boolean>;
    expect(overdue).toEqual({ late: true, soon: false, lateButDone: false, undated: false });
  });

  it('attaches tags in case-insensitive name order', () => {
    addTask('t1', 'p1', 'Build concepts');
    for (const [id, name] of [
      ['g1', 'urgent'],
      ['g2', 'Brand'],
      ['g3', 'admin'],
    ] as const) {
      db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, NULL)').run(id, name);
      db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run('t1', id);
    }
    expect(hydrateTask(db, raw('t1')).tags.map((tag) => tag.name)).toEqual([
      'admin',
      'Brand',
      'urgent',
    ]);
  });
});

describe('scope and ordering', () => {
  it('keeps archived work out of the active list while leaving it readable', () => {
    addClient('c2', 'Retired Client', 'ARCHIVED');
    addProject('p2', 'c1', 'Shelved Project', 'ARCHIVED');
    addProject('p3', 'c2', 'Work For A Retired Client');
    addTask('live', 'p1', 'Live work');
    addTask('shelved', 'p2', 'Shelved work');
    addTask('retired', 'p3', 'Retired client work');

    expect(listActiveTasks(db).map((task) => task.id)).toEqual(['live']);
    // Unscoped reads still reach it, which is what makes a direct link to an archived
    // project's task keep working.
    expect(
      listTasks(db)
        .map((task) => task.id)
        .sort(),
    ).toEqual(['live', 'retired', 'shelved']);
    expect(getTask(db, 'shelved')?.title).toBe('Shelved work');
  });

  it('falls back to updated_at when a project row carries no activity stamp', () => {
    // `last_activity_at` is nullable because an existing table cannot take a NOT NULL
    // column. A row written by anything that missed it must not hand a consumer undefined.
    addProject('p2', 'c1', 'Written Without A Stamp', 'ACTIVE', null);
    const projects = listProjects(db) as unknown as { id: string; lastActivityAt?: string }[];
    expect(projects.find((row) => row.id === 'p2')?.lastActivityAt).toBe(NOW);
  });

  it('lists clients with the active ones first and alphabetically inside each group', () => {
    addClient('c2', 'Zenith Works');
    addClient('c3', 'Beacon Co', 'ARCHIVED');
    addClient('c4', 'Anvil Ltd');
    expect(listClients(db).map((client) => client.name)).toEqual([
      'Acme Studio',
      'Anvil Ltd',
      'Zenith Works',
      'Beacon Co',
    ]);
  });

  it('lists categories without letting capitalisation decide the order', () => {
    for (const [id, name] of [
      ['k1', 'retainer'],
      ['k2', 'Campaign'],
      ['k3', 'internal'],
    ] as const)
      db.prepare('INSERT INTO categories (id, name, color) VALUES (?, ?, NULL)').run(id, name);
    expect(listCategories(db).map((category) => category.name)).toEqual([
      'Campaign',
      'internal',
      'retainer',
    ]);
    expect(getCategory(db, 'k2')).toEqual({ id: 'k2', name: 'Campaign' });
    expect(getCategory(db, 'missing')).toBeUndefined();
  });

  it('attaches each project its own categories, in case-insensitive name order', () => {
    addProject('p2', 'c1', 'Second Project');
    for (const [id, name] of [
      ['k1', 'retainer'],
      ['k2', 'Campaign'],
    ] as const)
      db.prepare('INSERT INTO categories (id, name, color) VALUES (?, ?, NULL)').run(id, name);
    for (const [projectId, categoryId] of [
      ['p1', 'k1'],
      ['p1', 'k2'],
    ] as const)
      db.prepare('INSERT INTO project_categories (project_id, category_id) VALUES (?, ?)').run(
        projectId,
        categoryId,
      );

    const byId = new Map(
      (listProjects(db) as unknown as { id: string; categories: { name: string }[] }[]).map(
        (project) => [project.id, project.categories],
      ),
    );
    expect(byId.get('p1')?.map((category) => category.name)).toEqual(['Campaign', 'retainer']);
    // Empty rather than absent, so no consumer has to guard before reading the list.
    expect(byId.get('p2')).toEqual([]);
  });

  it('lists tags without letting capitalisation decide the order', () => {
    for (const [id, name] of [
      ['g1', 'urgent'],
      ['g2', 'Brand'],
      ['g3', 'admin'],
    ] as const)
      db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, NULL)').run(id, name);
    expect(listTags(db).map((tag) => tag.name)).toEqual(['admin', 'Brand', 'urgent']);
  });

  it('orders tasks by column, then by position within it', () => {
    for (const [id, status, position] of [
      ['a', 'TODO', 1],
      ['b', 'BACKLOG', 1],
      ['c', 'TODO', 0],
      ['d', 'BACKLOG', 0],
    ] as const) {
      addTask(id, 'p1', id.toUpperCase(), { status });
      db.prepare('UPDATE tasks SET position=? WHERE id=?').run(position, id);
    }
    // 'BACKLOG' sorts before 'TODO' as text, and position orders each column's cards.
    expect(listTasks(db).map((task) => task.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('returns nothing rather than throwing for an id that is not there', () => {
    expect(getTask(db, 'missing')).toBeUndefined();
  });
});
