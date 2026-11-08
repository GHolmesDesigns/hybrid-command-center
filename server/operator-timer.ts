import crypto from 'node:crypto';
import type { Db } from './db.ts';
import { transaction } from './db.ts';
import { recordChangeFeedEvent } from './change-feeds.ts';
import { listProjectTimeCategories, ProjectTimeError } from './project-time.ts';
import type { OperatorTimer, TimeEntry } from '../shared/types.ts';

type TimerRow = {
  state: OperatorTimer['state'];
  timer_id: string | null;
  project_id: string | null;
  category_id: string | null;
  task_id: string | null;
  started_at: string | null;
  running_since: string | null;
  accumulated_seconds: number;
  revision: number;
  project_name: string | null;
  category_name: string | null;
  task_title: string | null;
};
const stamp = () => new Date().toISOString();

export class OperatorTimerConflict extends Error {
  readonly status = 409;
  readonly code = 'TIMER_CONFLICT';
  constructor() {
    super('The timer changed in another tab or device. Its latest state has been loaded.');
    this.name = 'OperatorTimerConflict';
  }
}

function readRow(db: Db): TimerRow {
  const row = db
    .prepare(
      `SELECT t.*,p.name project_name,c.name category_name,k.title task_title
       FROM operator_time_timer t LEFT JOIN projects p ON p.id=t.project_id
       LEFT JOIN time_categories c ON c.id=t.category_id LEFT JOIN tasks k ON k.id=t.task_id
       WHERE t.operator_id='operator'`,
    )
    .get() as TimerRow | undefined;
  if (!row) throw new Error('Operator timer was not initialized.');
  return row;
}

function elapsed(row: TimerRow, at: Date) {
  return (
    row.accumulated_seconds +
    (row.running_since
      ? Math.max(0, Math.floor((at.getTime() - Date.parse(row.running_since)) / 1000))
      : 0)
  );
}

export function getOperatorTimer(db: Db): OperatorTimer {
  const at = new Date();
  const row = readRow(db);
  return {
    state: row.state,
    ...(row.timer_id ? { timerId: row.timer_id } : {}),
    ...(row.project_id ? { projectId: row.project_id, projectName: row.project_name! } : {}),
    ...(row.category_id ? { categoryId: row.category_id, categoryName: row.category_name! } : {}),
    ...(row.task_id ? { taskId: row.task_id, taskTitle: row.task_title! } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.running_since ? { runningSince: row.running_since } : {}),
    accumulatedSeconds: row.accumulated_seconds,
    elapsedSeconds: elapsed(row, at),
    serverTime: at.toISOString(),
    revision: row.revision,
  };
}

function assertRevision(db: Db, revision: number): TimerRow {
  const row = readRow(db);
  if (row.revision !== revision) throw new OperatorTimerConflict();
  return row;
}

function change(db: Db, kind: string, timerId: string | undefined, at: string) {
  recordChangeFeedEvent(db, {
    feed: 'workspace',
    kind,
    entityType: 'operator_timer',
    entityId: timerId ?? 'operator',
    summary: kind.replaceAll('_', ' '),
    at,
  });
}

export function startOperatorTimer(
  db: Db,
  input: { projectId: string; categoryId: string; taskId?: string | null; revision: number },
) {
  const categories = listProjectTimeCategories(db, input.projectId);
  if (!categories.some((category) => category.id === input.categoryId && category.selectable))
    throw new ProjectTimeError('Choose an active category for this project.');
  if (input.taskId) {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(input.taskId) as
      { project_id: string } | undefined;
    if (!task || task.project_id !== input.projectId)
      throw new ProjectTimeError('Choose a task that belongs to this project.');
  }
  const timerId = crypto.randomUUID();
  const at = stamp();
  transaction(db, () => {
    const row = assertRevision(db, input.revision);
    if (row.state !== 'READY') throw new OperatorTimerConflict();
    db.prepare(
      `UPDATE operator_time_timer SET state='RUNNING',timer_id=?,project_id=?,category_id=?,task_id=?,started_at=?,running_since=?,accumulated_seconds=0,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
    ).run(timerId, input.projectId, input.categoryId, input.taskId ?? null, at, at, input.revision);
    change(db, 'operator_timer_started', timerId, at);
  });
  return getOperatorTimer(db);
}

export function switchOperatorTimer(
  db: Db,
  input: { projectId: string; categoryId: string; taskId: string; revision: number },
) {
  const categories = listProjectTimeCategories(db, input.projectId);
  if (!categories.some((category) => category.id === input.categoryId && category.selectable))
    throw new ProjectTimeError('Choose an active category for this project.');
  const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(input.taskId) as
    { project_id: string } | undefined;
  if (!task || task.project_id !== input.projectId)
    throw new ProjectTimeError('Choose a task that belongs to this project.');

  const at = new Date();
  const iso = at.toISOString();
  const nextTimerId = crypto.randomUUID();
  const entryId = crypto.randomUUID();
  transaction(db, () => {
    const current = assertRevision(db, input.revision);
    if (current.state === 'READY') {
      db.prepare(
        `UPDATE operator_time_timer SET state='RUNNING',timer_id=?,project_id=?,category_id=?,task_id=?,started_at=?,running_since=?,accumulated_seconds=0,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
      ).run(nextTimerId, input.projectId, input.categoryId, input.taskId, iso, iso, input.revision);
      change(db, 'operator_timer_started', nextTimerId, iso);
      return;
    }
    if (!current.timer_id) throw new OperatorTimerConflict();
    const duration = elapsed(current, at);
    if (duration <= 0)
      throw new ProjectTimeError('Run the current timer for at least one second before switching.');
    db.prepare(
      `INSERT INTO time_entries(id,project_id,task_id,category_id,started_at,ended_at,duration_seconds,notes,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      current.project_id,
      current.task_id,
      current.category_id,
      current.started_at,
      iso,
      duration,
      'Timer entry',
      iso,
      iso,
    );
    db.prepare(
      'INSERT INTO operator_time_timer_stops(timer_id,entry_id,stopped_at) VALUES(?,?,?)',
    ).run(current.timer_id, entryId, iso);
    db.prepare(
      `UPDATE operator_time_timer SET state='RUNNING',timer_id=?,project_id=?,category_id=?,task_id=?,started_at=?,running_since=?,accumulated_seconds=0,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
    ).run(nextTimerId, input.projectId, input.categoryId, input.taskId, iso, iso, input.revision);
    db.prepare('UPDATE projects SET updated_at=?,last_activity_at=? WHERE id=?').run(
      iso,
      iso,
      current.project_id,
    );
    change(db, 'operator_timer_stopped', current.timer_id, iso);
    recordChangeFeedEvent(db, {
      feed: 'workspace',
      kind: 'project.time_entry_created',
      entityType: 'time_entry',
      entityId: entryId,
      summary: 'Timer time entry added.',
      at: iso,
    });
    change(db, 'operator_timer_started', nextTimerId, iso);
  });
  return getOperatorTimer(db);
}

export function pauseOperatorTimer(db: Db, revision: number) {
  const at = new Date();
  const iso = at.toISOString();
  transaction(db, () => {
    const row = assertRevision(db, revision);
    if (row.state !== 'RUNNING' || !row.timer_id) throw new OperatorTimerConflict();
    db.prepare(
      `UPDATE operator_time_timer SET state='PAUSED',running_since=NULL,accumulated_seconds=?,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
    ).run(elapsed(row, at), revision);
    change(db, 'operator_timer_paused', row.timer_id, iso);
  });
  return getOperatorTimer(db);
}

export function resumeOperatorTimer(db: Db, revision: number) {
  const at = stamp();
  transaction(db, () => {
    const row = assertRevision(db, revision);
    if (row.state !== 'PAUSED' || !row.timer_id) throw new OperatorTimerConflict();
    db.prepare(
      `UPDATE operator_time_timer SET state='RUNNING',running_since=?,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
    ).run(at, revision);
    change(db, 'operator_timer_resumed', row.timer_id, at);
  });
  return getOperatorTimer(db);
}

function readStoppedEntry(db: Db, timerId: string): TimeEntry | undefined {
  const receipt = db
    .prepare('SELECT entry_id FROM operator_time_timer_stops WHERE timer_id=?')
    .get(timerId) as { entry_id: string } | undefined;
  if (!receipt) return undefined;
  const row = db
    .prepare(
      `SELECT e.*,p.name project_name,t.title task_title,c.name category_name FROM time_entries e
       JOIN projects p ON p.id=e.project_id LEFT JOIN tasks t ON t.id=e.task_id
       JOIN time_categories c ON c.id=e.category_id WHERE e.id=?`,
    )
    .get(receipt.entry_id) as Record<string, unknown> | undefined;
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

export function stopOperatorTimer(db: Db, timerId: string, revision: number): TimeEntry {
  const existing = readStoppedEntry(db, timerId);
  if (existing) return existing;
  const rowBefore = readRow(db);
  const at = new Date();
  const iso = at.toISOString();
  const duration = elapsed(rowBefore, at);
  if (duration <= 0)
    throw new ProjectTimeError('Run the timer for at least one second before saving.');
  const entryId = crypto.randomUUID();
  transaction(db, () => {
    const row = assertRevision(db, revision);
    if (row.state === 'READY' || row.timer_id !== timerId) throw new OperatorTimerConflict();
    db.prepare(
      `INSERT INTO time_entries(id,project_id,task_id,category_id,started_at,ended_at,duration_seconds,notes,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      entryId,
      row.project_id,
      row.task_id,
      row.category_id,
      row.started_at,
      iso,
      duration,
      'Timer entry',
      iso,
      iso,
    );
    db.prepare(
      `INSERT INTO operator_time_timer_stops(timer_id,entry_id,stopped_at) VALUES(?,?,?)`,
    ).run(timerId, entryId, iso);
    db.prepare(
      `UPDATE operator_time_timer SET state='READY',timer_id=NULL,project_id=NULL,category_id=NULL,task_id=NULL,started_at=NULL,running_since=NULL,accumulated_seconds=0,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
    ).run(revision);
    db.prepare('UPDATE projects SET updated_at=?,last_activity_at=? WHERE id=?').run(
      iso,
      iso,
      row.project_id,
    );
    change(db, 'operator_timer_stopped', timerId, iso);
    recordChangeFeedEvent(db, {
      feed: 'workspace',
      kind: 'project.time_entry_created',
      entityType: 'time_entry',
      entityId: entryId,
      summary: 'Timer time entry added.',
      at: iso,
    });
  });
  const entry = readStoppedEntry(db, timerId);
  if (!entry) throw new ProjectTimeError('Timer entry could not be read after saving.', 500);
  return entry;
}

export function discardOperatorTimer(db: Db, timerId: string, revision: number) {
  const at = stamp();
  transaction(db, () => {
    const row = assertRevision(db, revision);
    if (row.state === 'READY' || row.timer_id !== timerId) throw new OperatorTimerConflict();
    db.prepare(
      `UPDATE operator_time_timer SET state='READY',timer_id=NULL,project_id=NULL,category_id=NULL,task_id=NULL,started_at=NULL,running_since=NULL,accumulated_seconds=0,revision=revision+1 WHERE operator_id='operator' AND revision=?`,
    ).run(revision);
    change(db, 'operator_timer_discarded', timerId, at);
  });
  return getOperatorTimer(db);
}
