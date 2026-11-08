import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from './db.ts';
import { transaction } from './db.ts';
import { advanceRevision, requireRevision, RevisionConflictError } from './domain/revisions.ts';
import { touchProjectActivity } from './domain/activity.ts';
import { recordChangeFeedEvent } from './change-feeds.ts';
import { resolveLocalDateTime, projectTimeBudgetStatus } from '../shared/project-time.ts';
import type { TimeCategory, TimeEntry } from '../shared/types.ts';

const id = () => crypto.randomUUID();
const stamp = () => new Date().toISOString();
const change = (
  db: Db,
  kind: string,
  entityType: string,
  entityId: string,
  summary: string,
  at: string,
) => recordChangeFeedEvent(db, { feed: 'workspace', kind, entityType, entityId, summary, at });

export class ProjectTimeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'TIME_VALIDATION') {
    super(message);
    this.name = 'ProjectTimeError';
    this.status = status;
    this.code = code;
  }
}

const entryFields = {
  categoryId: z.string().uuid(),
  taskId: z.string().uuid().nullable().optional(),
  startDate: z.string(),
  startTime: z.string(),
  endDate: z.string().optional(),
  endTime: z.string(),
  timeZone: z.string().min(1).max(64),
  startAmbiguity: z.enum(['earlier', 'later']).optional(),
  endAmbiguity: z.enum(['earlier', 'later']).optional(),
  notes: z.string().max(2000).default(''),
};
const entryInput = z.object(entryFields);
const categoryInput = z.object({ name: z.string().trim().min(1).max(60) });

type EntryDraft = z.infer<typeof entryInput>;

function ensureProject(db: Db, projectId: string): void {
  if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId))
    throw new ProjectTimeError('Project not found.', 404, 'PROJECT_NOT_FOUND');
}

function mapCategory(row: Record<string, unknown>, selectable = !row.archived_at): TimeCategory {
  return {
    id: row.id as string,
    name: row.name as string,
    ...(row.project_id ? { projectId: row.project_id as string } : {}),
    position: row.position as number,
    ...(row.archived_at ? { archivedAt: row.archived_at as string } : {}),
    isDefault: row.project_id === null,
    selectable,
  };
}

export function listProjectTimeCategories(db: Db, projectId: string): TimeCategory[] {
  ensureProject(db, projectId);
  const projectRows = db
    .prepare(
      'SELECT * FROM time_categories WHERE project_id=? ORDER BY position,name COLLATE NOCASE',
    )
    .all(projectId) as Record<string, unknown>[];
  const activeProjectRows = projectRows.filter((row) => !row.archived_at);
  const defaults = db
    .prepare(
      "SELECT * FROM time_categories WHERE scope_key='workspace' ORDER BY position,name COLLATE NOCASE",
    )
    .all() as Record<string, unknown>[];
  if (activeProjectRows.length)
    return [
      ...activeProjectRows.map((row) => mapCategory(row, true)),
      ...projectRows.filter((row) => row.archived_at).map((row) => mapCategory(row, false)),
      ...defaults.map((row) => mapCategory(row, false)),
    ];
  return [
    ...defaults.map((row) => mapCategory(row, true)),
    ...projectRows.filter((row) => row.archived_at).map((row) => mapCategory(row, false)),
  ];
}

export function createProjectTimeCategory(db: Db, projectId: string, raw: unknown) {
  ensureProject(db, projectId);
  const { name } = categoryInput.parse(raw);
  const categoryId = id();
  const at = stamp();
  transaction(db, () => {
    const exists = db
      .prepare('SELECT id FROM time_categories WHERE scope_key=? AND name=? COLLATE NOCASE')
      .get(projectId, name);
    if (exists) throw new ProjectTimeError('A time category with that name already exists.');
    const position = (
      db
        .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM time_categories WHERE project_id=?')
        .get(projectId) as { next: number }
    ).next;
    db.prepare(
      `INSERT INTO time_categories(id,scope_key,project_id,name,position,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`,
    ).run(categoryId, projectId, projectId, name, position, at, at);
    touchProjectActivity(db, projectId, at);
    change(db, 'project.time_category_created', 'project', projectId, 'Time category added.', at);
  });
  return listProjectTimeCategories(db, projectId);
}

export function reorderProjectTimeCategories(db: Db, projectId: string, categoryIds: string[]) {
  ensureProject(db, projectId);
  const rows = db.prepare('SELECT id FROM time_categories WHERE project_id=?').all(projectId) as {
    id: string;
  }[];
  if (
    rows.length !== categoryIds.length ||
    new Set(categoryIds).size !== categoryIds.length ||
    rows.some((row) => !categoryIds.includes(row.id))
  )
    throw new ProjectTimeError('Refresh the category list and try again.');
  transaction(db, () => {
    const update = db.prepare(
      'UPDATE time_categories SET position=?,updated_at=? WHERE id=? AND project_id=?',
    );
    categoryIds.forEach((categoryId, position) =>
      update.run(position, stamp(), categoryId, projectId),
    );
    const at = stamp();
    touchProjectActivity(db, projectId, at);
    change(
      db,
      'project.time_categories_reordered',
      'project',
      projectId,
      'Time categories reordered.',
      at,
    );
  });
  return listProjectTimeCategories(db, projectId);
}

export function archiveProjectTimeCategory(db: Db, projectId: string, categoryId: string) {
  ensureProject(db, projectId);
  const at = stamp();
  transaction(db, () => {
    const result = db
      .prepare(
        `UPDATE time_categories SET archived_at=?,updated_at=?
      WHERE id=? AND project_id=? AND archived_at IS NULL`,
      )
      .run(at, at, categoryId, projectId);
    if (!result.changes)
      throw new ProjectTimeError('Active project category not found.', 404, 'CATEGORY_NOT_FOUND');
    touchProjectActivity(db, projectId, at);
    change(
      db,
      'project.time_category_archived',
      'project',
      projectId,
      'Time category archived.',
      at,
    );
  });
  return listProjectTimeCategories(db, projectId);
}

function validateDraft(db: Db, projectId: string, data: EntryDraft, preserveCategoryId?: string) {
  ensureProject(db, projectId);
  const categories = listProjectTimeCategories(db, projectId);
  const category = categories.find(
    (value) =>
      value.id === data.categoryId && (value.selectable || value.id === preserveCategoryId),
  );
  if (!category) throw new ProjectTimeError('Choose an active category for this project.');
  if (data.taskId) {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(data.taskId) as
      { project_id: string } | undefined;
    if (!task || task.project_id !== projectId)
      throw new ProjectTimeError('Choose a task that belongs to this project.');
  }
  if (!data.endDate && data.endTime <= data.startTime)
    throw new ProjectTimeError('Enter an end date for an entry that crosses midnight.');
  const endDate = data.endDate || data.startDate;
  let startedAt: Date;
  let endedAt: Date;
  try {
    startedAt = resolveLocalDateTime(
      data.startDate,
      data.startTime,
      data.timeZone,
      data.startAmbiguity,
    );
    endedAt = resolveLocalDateTime(endDate, data.endTime, data.timeZone, data.endAmbiguity);
  } catch (error) {
    throw new ProjectTimeError((error as Error).message);
  }
  const durationSeconds = (endedAt.getTime() - startedAt.getTime()) / 1000;
  if (!Number.isInteger(durationSeconds) || durationSeconds <= 0)
    throw new ProjectTimeError('End time must be after start time.');
  return {
    category,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationSeconds,
  };
}

function readEntry(db: Db, entryId: string): TimeEntry | undefined {
  const row = db
    .prepare(
      `SELECT e.*,p.name project_name,t.title task_title,c.name category_name
    FROM time_entries e JOIN projects p ON p.id=e.project_id
    LEFT JOIN tasks t ON t.id=e.task_id JOIN time_categories c ON c.id=e.category_id
    WHERE e.id=?`,
    )
    .get(entryId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    projectName: row.project_name as string,
    ...(row.task_id ? { taskId: row.task_id as string, taskTitle: row.task_title as string } : {}),
    categoryId: row.category_id as string,
    categoryName: row.category_name as string,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string,
    durationSeconds: row.duration_seconds as number,
    notes: row.notes as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revision: row.revision as number,
  };
}

export function listProjectTimeEntries(
  db: Db,
  projectId: string,
  filters: {
    taskId?: string;
    categoryId?: string;
    from?: string;
    to?: string;
    timeZone?: string;
  } = {},
): TimeEntry[] {
  ensureProject(db, projectId);
  const where = ['e.project_id=?'];
  const params: (string | number)[] = [projectId];
  if (filters.taskId) {
    where.push('e.task_id=?');
    params.push(filters.taskId);
  }
  if (filters.categoryId) {
    where.push('e.category_id=?');
    params.push(filters.categoryId);
  }
  const rows = db
    .prepare(
      `SELECT e.id FROM time_entries e WHERE ${where.join(' AND ')} ORDER BY e.started_at DESC,e.id`,
    )
    .all(...params) as { id: string }[];
  const entries = rows.map(({ id: entryId }) => readEntry(db, entryId)!).filter(Boolean);
  if (!filters.from && !filters.to) return entries;
  const zone = filters.timeZone || 'UTC';
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return entries.filter((entry) => {
    const day = dateFormatter.format(new Date(entry.startedAt));
    return (!filters.from || day >= filters.from) && (!filters.to || day <= filters.to);
  });
}

export function projectTimeSummary(db: Db, projectId: string) {
  ensureProject(db, projectId);
  const entries = listProjectTimeEntries(db, projectId);
  const byTask = new Map<
    string,
    { taskId?: string; taskTitle: string; durationSeconds: number; entries: number }
  >();
  const byCategory = new Map<
    string,
    { categoryId: string; categoryName: string; durationSeconds: number; entries: number }
  >();
  for (const entry of entries) {
    const taskKey = entry.taskId ?? 'unassigned';
    const task = byTask.get(taskKey) ?? {
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      taskTitle: entry.taskTitle ?? 'No task',
      durationSeconds: 0,
      entries: 0,
    };
    task.durationSeconds += entry.durationSeconds;
    task.entries += 1;
    byTask.set(taskKey, task);
    const category = byCategory.get(entry.categoryId) ?? {
      categoryId: entry.categoryId,
      categoryName: entry.categoryName,
      durationSeconds: 0,
      entries: 0,
    };
    category.durationSeconds += entry.durationSeconds;
    category.entries += 1;
    byCategory.set(entry.categoryId, category);
  }
  const project = db
    .prepare('SELECT time_budget_minutes FROM projects WHERE id=?')
    .get(projectId) as { time_budget_minutes: number | null };
  const totalSeconds = entries.reduce((total, entry) => total + entry.durationSeconds, 0);
  return {
    projectId,
    totalSeconds,
    entryCount: entries.length,
    budgetMinutes: project.time_budget_minutes ?? null,
    budgetStatus: projectTimeBudgetStatus(totalSeconds, project.time_budget_minutes),
    byTask: [...byTask.values()].sort((a, b) => a.taskTitle.localeCompare(b.taskTitle)),
    byCategory: [...byCategory.values()].sort((a, b) =>
      a.categoryName.localeCompare(b.categoryName),
    ),
  };
}

export function createProjectTimeEntry(db: Db, projectId: string, raw: unknown) {
  const data = entryInput.parse(raw);
  const resolved = validateDraft(db, projectId, data);
  const entryId = id();
  const at = stamp();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO time_entries(id,project_id,task_id,category_id,started_at,ended_at,duration_seconds,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      projectId,
      data.taskId ?? null,
      data.categoryId,
      resolved.startedAt,
      resolved.endedAt,
      resolved.durationSeconds,
      data.notes,
      at,
      at,
    );
    touchProjectActivity(db, projectId, at);
    change(db, 'project.time_entry_created', 'time_entry', entryId, 'Time entry added.', at);
  });
  const entry = readEntry(db, entryId);
  if (!entry) throw new ProjectTimeError('Time entry could not be read after saving.', 500);
  return entry;
}

export function updateProjectTimeEntry(
  db: Db,
  projectId: string,
  entryId: string,
  raw: unknown,
  revision: number,
) {
  const data = entryInput.parse(raw);
  const existing = db
    .prepare('SELECT id,revision,category_id FROM time_entries WHERE id=? AND project_id=?')
    .get(entryId, projectId) as { id: string; revision: number; category_id: string } | undefined;
  if (!existing) throw new ProjectTimeError('Time entry not found.', 404, 'ENTRY_NOT_FOUND');
  if (existing.revision !== revision) throw new RevisionConflictError(existing.revision, []);
  const resolved = validateDraft(db, projectId, data, existing.category_id);
  const at = stamp();
  transaction(db, () => {
    const changed = db
      .prepare(
        `UPDATE time_entries SET task_id=?,category_id=?,started_at=?,ended_at=?,duration_seconds=?,notes=?,updated_at=?,revision=revision+1 WHERE id=? AND project_id=? AND revision=?`,
      )
      .run(
        data.taskId ?? null,
        data.categoryId,
        resolved.startedAt,
        resolved.endedAt,
        resolved.durationSeconds,
        data.notes,
        at,
        entryId,
        projectId,
        revision,
      );
    if (!changed.changes) {
      const latest = db.prepare('SELECT revision FROM time_entries WHERE id=?').get(entryId) as
        { revision: number } | undefined;
      throw new RevisionConflictError(latest?.revision ?? revision + 1, []);
    }
    touchProjectActivity(db, projectId, at);
    change(db, 'project.time_entry_updated', 'time_entry', entryId, 'Time entry updated.', at);
  });
  const entry = readEntry(db, entryId);
  if (!entry) throw new ProjectTimeError('Time entry not found.', 404, 'ENTRY_NOT_FOUND');
  return entry;
}

export function deleteProjectTimeEntry(
  db: Db,
  projectId: string,
  entryId: string,
  revision: number,
) {
  const existing = db
    .prepare('SELECT id,revision FROM time_entries WHERE id=? AND project_id=?')
    .get(entryId, projectId) as { id: string; revision: number } | undefined;
  if (!existing) throw new ProjectTimeError('Time entry not found.', 404, 'ENTRY_NOT_FOUND');
  if (existing.revision !== revision) throw new RevisionConflictError(existing.revision, []);
  transaction(db, () => {
    const deleted = db
      .prepare('DELETE FROM time_entries WHERE id=? AND project_id=? AND revision=?')
      .run(entryId, projectId, revision);
    if (!deleted.changes) {
      const latest = db.prepare('SELECT revision FROM time_entries WHERE id=?').get(entryId) as
        { revision: number } | undefined;
      throw new RevisionConflictError(latest?.revision ?? revision + 1, []);
    }
    const at = stamp();
    touchProjectActivity(db, projectId, at);
    change(db, 'project.time_entry_deleted', 'time_entry', entryId, 'Time entry deleted.', at);
  });
  return { ok: true as const, deleted: 'time-entry' as const };
}

export function updateProjectTimeBudget(db: Db, projectId: string, raw: unknown, revision: number) {
  const data = z.object({ minutes: z.number().int().min(1).max(1_000_000).nullable() }).parse(raw);
  ensureProject(db, projectId);
  const at = stamp();
  transaction(db, () => {
    requireRevision(db, 'project', projectId, revision);
    db.prepare(
      'UPDATE projects SET time_budget_minutes=?,updated_at=?,last_activity_at=? WHERE id=?',
    ).run(data.minutes, at, at, projectId);
    advanceRevision(db, 'project', projectId, revision, ['timeBudgetMinutes'], at);
    change(db, 'project.updated', 'project', projectId, 'Project time budget updated.', at);
  });
  return { budgetMinutes: data.minutes };
}

export function taskTimeSummary(db: Db, taskId: string) {
  const task = db
    .prepare('SELECT id,project_id,time_budget_minutes FROM tasks WHERE id=?')
    .get(taskId) as
    { id: string; project_id: string; time_budget_minutes: number | null } | undefined;
  if (!task) throw new ProjectTimeError('Task not found.', 404, 'TASK_NOT_FOUND');
  const entries = listProjectTimeEntries(db, task.project_id, { taskId });
  const totalSeconds = entries.reduce((total, entry) => total + entry.durationSeconds, 0);
  return {
    taskId,
    entries,
    totalSeconds,
    budgetMinutes: task.time_budget_minutes,
    budgetStatus: projectTimeBudgetStatus(totalSeconds, task.time_budget_minutes),
  };
}

export function updateTaskTimeBudget(db: Db, taskId: string, raw: unknown, revision: number) {
  const data = z.object({ minutes: z.number().int().min(1).max(1_000_000).nullable() }).parse(raw);
  const task = db.prepare('SELECT id,project_id FROM tasks WHERE id=?').get(taskId) as
    { id: string; project_id: string } | undefined;
  if (!task) throw new ProjectTimeError('Task not found.', 404, 'TASK_NOT_FOUND');
  const at = stamp();
  transaction(db, () => {
    requireRevision(db, 'task', taskId, revision);
    db.prepare('UPDATE tasks SET time_budget_minutes=?,updated_at=? WHERE id=?').run(
      data.minutes,
      at,
      taskId,
    );
    advanceRevision(db, 'task', taskId, revision, ['timeBudgetMinutes'], at);
    touchProjectActivity(db, task.project_id, at);
    change(db, 'task.updated', 'task', taskId, 'Task time budget updated.', at);
  });
  return { budgetMinutes: data.minutes };
}
