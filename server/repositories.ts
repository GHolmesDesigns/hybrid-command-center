import type { Db } from './db.ts';
import { blockingDependencies } from './domain/dependencies.ts';
import { isOverdue } from './domain/deadlines.ts';
import type { Tag, Task } from '../shared/types.ts';

const camel = (row: any) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      value ?? undefined,
    ]),
  );

export function listClients(db: Db) {
  return (db.prepare('SELECT * FROM clients ORDER BY status, name').all() as any[]).map(camel);
}
export function listProjects(db: Db) {
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
  }));
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
    overdue: isOverdue(task.dueDate, task.status),
    checklistCompleted: checklist.filter((i) => i.completed).length,
    checklistTotal: checklist.length,
  } as Task;
}
export function listTasks(db: Db, where = '', params: (string | number | null)[] = []) {
  const rows = db
    .prepare(
      `SELECT t.*, p.name project_name, p.client_id, c.name client_name FROM tasks t
    JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id ${where}
    ORDER BY t.status, t.position, t.updated_at DESC`,
    )
    .all(...params) as any[];
  return rows.map((row) => hydrateTask(db, row));
}
export function getTask(db: Db, id: string) {
  return listTasks(db, 'WHERE t.id=?', [id])[0];
}
