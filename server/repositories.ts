import type { Db } from './db.ts';
import { blockingDependencies } from './domain/dependencies.ts';
import { isOverdue } from '../shared/deadlines.ts';
import { TASK_STATUSES, type Category, type Tag, type Task } from '../shared/types.ts';

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
      ...client
    } = row;
    return {
      ...camel(client),
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
/**
 * Workflow order for `status`, which is stored as text. Ordering by the column itself sorts
 * alphabetically — BACKLOG, COMPLETE, IN_PROGRESS, REVIEW, TODO — which is invisible on the
 * board, where every column filters to one status, and plainly wrong on any list that crosses
 * statuses. Built from `TASK_STATUSES` so the SQL cannot drift from the board's column order.
 */
const STATUS_RANK = `CASE t.status ${TASK_STATUSES.map(
  (status, rank) => `WHEN '${status}' THEN ${rank}`,
).join(' ')} ELSE ${TASK_STATUSES.length} END`;

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
