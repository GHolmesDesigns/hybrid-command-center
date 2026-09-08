import type { Db } from './db.ts';
import { blockingDependencies } from './domain/dependencies.ts';
import { isOverdue } from '../shared/deadlines.ts';
import { TASK_STATUSES, type Category, type Tag, type Task } from '../shared/types.ts';
import type { TaskFilter } from '../shared/task-filters.ts';

const camel = (row: any) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value ?? undefined,
    ]),
  );

/**
 * Every client, each carrying `mergedInto` when it was merged away.
 *
 * Two joins rather than a second query: `client_merges` for the alias this client is the source
 * of, and `clients` again for the survivor's current name — the live name, not a snapshot, so
 * renaming the surviving client renames it everywhere the merge is reported.
 */
export function listClients(db: Db) {
  return (
    db
      .prepare(
        `SELECT c.*, m.surviving_client_id merged_into_id, m.merged_at merged_at,
                s.name merged_into_name
         FROM clients c
         LEFT JOIN client_merges m ON m.source_client_id = c.id
         LEFT JOIN clients s ON s.id = m.surviving_client_id
         ORDER BY c.status, c.name`,
      )
      .all() as any[]
  ).map((row): any => {
    const {
      merged_into_id: mergedIntoId,
      merged_into_name: mergedIntoName,
      merged_at: mergedAt,
      branding_logo_url: brandingLogoUrl,
      branding_color_one: brandingColorOne,
      branding_color_two: brandingColorTwo,
      ...client
    } = row;
    return {
      ...camel(client),
      ...(brandingLogoUrl || brandingColorOne || brandingColorTwo
        ? {
            branding: {
              logoUrl: brandingLogoUrl ?? '',
              colorOne: brandingColorOne ?? '',
              colorTwo: brandingColorTwo ?? '',
            },
          }
        : {}),
      ...(mergedIntoId ? { mergedInto: { id: mergedIntoId, name: mergedIntoName, mergedAt } } : {}),
    };
  });
}
/**
 * Every project's categories, grouped by project id, in one statement — so listing
 * projects costs two queries rather than one per tile.
 */
function categoriesByProject(db: Db): Map<string, Category[]> {
  const grouped = new Map<string, Category[]>();
  const rows = db
    .prepare(
      `SELECT pc.project_id, c.id, c.name, c.color FROM project_categories pc
       JOIN categories c ON c.id=pc.category_id ORDER BY c.name COLLATE NOCASE`,
    )
    .all() as any[];
  for (const row of rows) {
    const attached = grouped.get(row.project_id) ?? [];
    attached.push(camel({ id: row.id, name: row.name, color: row.color }) as unknown as Category);
    grouped.set(row.project_id, attached);
  }
  return grouped;
}
export function listProjects(db: Db) {
  const categories = categoriesByProject(db);
  return (
    db
      .prepare(
        // `position` leads so the manual tile order survives a reload. Until a project is
        // dragged every row shares position 0, leaving the original ordering intact.
        `SELECT p.*, c.name client_name FROM projects p JOIN clients c ON c.id=p.client_id
    ORDER BY p.position, CASE p.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, p.updated_at DESC`,
      )
      .all() as any[]
  ).map((row) => ({
    ...camel(row),
    // `last_activity_at` is nullable in SQLite because an existing table cannot take a
    // NOT NULL column, and `backfillProjectActivity` fills it on boot. Falling back here
    // too keeps `Project.lastActivityAt` a string for every consumer, so a row written
    // by anything that missed the column can never crash a sort or a date format.
    lastActivityAt: row.last_activity_at || row.updated_at,
    // Empty rather than absent, so every consumer can read `project.categories.length`.
    categories: categories.get(row.id) ?? [],
  }));
}
export function listCategories(db: Db): Category[] {
  return (
    db.prepare('SELECT id, name, color FROM categories ORDER BY name COLLATE NOCASE').all() as any[]
  ).map(camel) as unknown as Category[];
}
export function getCategory(db: Db, id: string): Category | undefined {
  const row = db.prepare('SELECT id, name, color FROM categories WHERE id=?').get(id);
  return row ? (camel(row) as unknown as Category) : undefined;
}
export function listTags(db: Db): Tag[] {
  return (
    db.prepare('SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE').all() as any[]
  ).map(camel) as unknown as Tag[];
}
export function getTag(db: Db, id: string): Tag | undefined {
  const row = db.prepare('SELECT id, name, color FROM tags WHERE id=?').get(id);
  return row ? (camel(row) as unknown as Tag) : undefined;
}
export function hydrateTask(db: Db, raw: any): Task {
  const task: any = camel(raw);
  const tags = (
    db
      .prepare(
        `SELECT tags.id, tags.name, tags.color FROM task_tags
         JOIN tags ON tags.id=task_tags.tag_id WHERE task_tags.task_id=?
         ORDER BY tags.name COLLATE NOCASE`,
      )
      .all(task.id) as any[]
  ).map(camel);
  const checklist = (
    db
      .prepare(
        'SELECT id, task_id, text, completed, position FROM checklist_items WHERE task_id=? ORDER BY position',
      )
      .all(task.id) as any[]
  ).map((item) => ({ ...camel(item), completed: Boolean(item.completed) }));
  const dependencyIds = (
    db.prepare('SELECT dependency_id FROM task_dependencies WHERE task_id=?').all(task.id) as any[]
  ).map((r) => r.dependency_id);
  const blocking = blockingDependencies(db, task.id);
  return {
    ...task,
    tags,
    checklist,
    dependencyIds,
    blockingDependencies: blocking,
    blocked: blocking.length > 0,
    overdue: isOverdue(task),
    checklistCompleted: checklist.filter((i) => i.completed).length,
    checklistTotal: checklist.length,
  } as Task;
}

function grouped<T>(rows: T[], taskId: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const id = taskId(row);
    const values = result.get(id) ?? [];
    values.push(row);
    result.set(id, values);
  }
  return result;
}

/** Hydrates one bounded page with one query per relation, rather than four queries per task. */
function hydrateTaskPage(db: Db, rows: any[]): Task[] {
  if (rows.length === 0) return [];
  const taskIds = rows.map((row) => row.id as string);
  const placeholders = taskIds.map(() => '?').join(',');
  const tags = grouped(
    db
      .prepare(
        `SELECT task_tags.task_id, tags.id, tags.name, tags.color FROM task_tags
         JOIN tags ON tags.id=task_tags.tag_id WHERE task_tags.task_id IN (${placeholders})
         ORDER BY task_tags.task_id, tags.name COLLATE NOCASE`,
      )
      .all(...taskIds) as any[],
    (row) => row.task_id,
  );
  const checklist = grouped(
    db
      .prepare(
        `SELECT id, task_id, text, completed, position FROM checklist_items
         WHERE task_id IN (${placeholders}) ORDER BY task_id, position`,
      )
      .all(...taskIds) as any[],
    (row) => row.task_id,
  );
  const dependencies = db
    .prepare(
      `SELECT d.task_id, d.dependency_id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id=d.dependency_id WHERE d.task_id IN (${placeholders})
       ORDER BY d.task_id, t.title`,
    )
    .all(...taskIds) as any[];
  const dependencyIds = grouped(dependencies, (row) => row.task_id);
  const blocking = grouped(
    dependencies.filter((row) => row.status !== 'COMPLETE'),
    (row) => row.task_id,
  );
  return rows.map((raw) => {
    const task: any = camel(raw);
    const taskTags = (tags.get(task.id) ?? []).map((row) =>
      camel({ id: row.id, name: row.name, color: row.color }),
    );
    const items = (checklist.get(task.id) ?? []).map((item) => ({
      ...camel(item),
      completed: Boolean(item.completed),
    }));
    const ids = (dependencyIds.get(task.id) ?? []).map((row) => row.dependency_id as string);
    const blockers = (blocking.get(task.id) ?? []).map((row) => ({
      id: row.dependency_id as string,
      title: row.title as string,
    }));
    return {
      ...task,
      tags: taskTags,
      checklist: items,
      dependencyIds: ids,
      blockingDependencies: blockers,
      blocked: blockers.length > 0,
      overdue: isOverdue(task),
      checklistCompleted: items.filter((item) => item.completed).length,
      checklistTotal: items.length,
    } as Task;
  });
}
/**
 * Workflow order for `status`, which is stored as text. Ordering by the column itself sorts
 * alphabetically — BACKLOG, COMPLETE, IN_PROGRESS, REVIEW, TODO — which is invisible on the
 * board, where every column filters to one status, and plainly wrong on any list that crosses
 * statuses. Built from `TASK_STATUSES` so the SQL cannot drift from the board's column order.
 */
const STATUS_RANK = `CASE t.status ${TASK_STATUSES.map(
  (status, rank) => `WHEN '${status}' THEN ${rank}`,
).join(' ')} ELSE ${TASK_STATUSES.length} END`;

export type TaskPage = { tasks: Task[]; truncated: boolean };

/** A bounded task page. `orderBy` is an internal SQL fragment, never external input. */
export function listTasksPage(
  db: Db,
  where: string,
  params: (string | number | null)[],
  limit: number,
  offset = 0,
  orderBy = `${STATUS_RANK}, t.position, t.updated_at DESC`,
): TaskPage {
  const rows = db
    .prepare(
      `SELECT t.*, p.name project_name, p.client_id, c.name client_name FROM tasks t
       JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id ${where}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit + 1, offset) as any[];
  return { tasks: hydrateTaskPage(db, rows.slice(0, limit)), truncated: rows.length > limit };
}

export function listTasks(db: Db, where = '', params: (string | number | null)[] = []) {
  const rows = db
    .prepare(
      `SELECT t.*, p.name project_name, p.client_id, c.name client_name FROM tasks t
    JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id ${where}
    ORDER BY ${STATUS_RANK}, t.position, t.updated_at DESC`,
    )
    .all(...params) as any[];
  return rows.map((row) => hydrateTask(db, row));
}

/** Build the one SQL vocabulary shared by the filtered API and bounded task reads. */
export function taskFilterWhere(filters: TaskFilter): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const addIn = (column: string, values: string[]) => {
    if (values.length) {
      clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
      params.push(...values);
    }
  };
  addIn('p.client_id', filters.clients);
  addIn('t.project_id', filters.projects);
  addIn('t.priority', filters.priorities);
  addIn('t.status', filters.statuses);
  if (filters.types.length) {
    const typed = filters.types.filter((value) => value !== 'none');
    const typeClauses = [] as string[];
    if (typed.length) {
      typeClauses.push(`t.task_type IN (${typed.map(() => '?').join(',')})`);
      params.push(...typed);
    }
    if (filters.types.includes('none')) typeClauses.push('t.task_type IS NULL');
    clauses.push(`(${typeClauses.join(' OR ')})`);
  }
  for (const tagId of filters.tags) {
    clauses.push('EXISTS (SELECT 1 FROM task_tags tf WHERE tf.task_id=t.id AND tf.tag_id=?)');
    params.push(tagId);
  }
  if (filters.search) {
    const needle = `%${filters.search.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
    clauses.push(`(LOWER(t.title) LIKE LOWER(?) ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM task_tags ts JOIN tags st ON st.id=ts.tag_id
      WHERE ts.task_id=t.id AND LOWER(st.name) LIKE LOWER(?) ESCAPE '\\'
    ))`);
    params.push(needle, needle);
  }
  if (filters.focus.length) {
    const focus: string[] = [];
    for (const flag of filters.focus) {
      if (flag === 'overdue')
        focus.push("t.status<>'COMPLETE' AND t.due_date < DATE('now','localtime')");
      if (flag === 'today')
        focus.push("t.status<>'COMPLETE' AND t.due_date = DATE('now','localtime')");
      if (flag === 'week')
        focus.push(
          "t.status<>'COMPLETE' AND t.due_date BETWEEN DATE('now','localtime') AND DATE('now','localtime','+7 day')",
        );
      if (flag === 'none') focus.push('t.due_date IS NULL');
      if (flag === 'completed') focus.push("t.status='COMPLETE'");
      if (flag === 'blocked')
        focus.push(
          "EXISTS (SELECT 1 FROM task_dependencies bd JOIN tasks bt ON bt.id=bd.dependency_id WHERE bd.task_id=t.id AND bt.status<>'COMPLETE')",
        );
    }
    clauses.push(`(${focus.join(' OR ')})`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function listTasksFiltered(db: Db, filters: TaskFilter) {
  const built = taskFilterWhere(filters);
  return listTasks(db, built.where, built.params);
}
export function getTask(db: Db, id: string) {
  return listTasks(db, 'WHERE t.id=?', [id])[0];
}
/**
 * Work under a live client and a live project. This is dashboard scope, not a global
 * filter: `GET /api/tasks`, the board, and a direct link to an archived project's task all
 * stay unscoped, so archived work is still reachable — it just stops inflating the numbers
 * on a page that claims to show what needs attention now.
 */
export function listActiveTasks(db: Db) {
  return listTasks(db, "WHERE p.status<>'ARCHIVED' AND c.status<>'ARCHIVED'");
}
