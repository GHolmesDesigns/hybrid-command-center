/**
 * Scheduled agent-run persistence (C215 / #601).
 *
 * This service owns schedule rows and run-window idempotency. A successful run inserts one ordinary
 * OPEN handoff through the coordination service; it never claims work or calls an integration.
 */
import crypto from 'node:crypto';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { redactSecrets } from '../integration-log.ts';
import { insertHandoff } from '../agent-coordination/service.ts';
import {
  agentScheduleInputSchema,
  agentSchedulePauseSchema,
  scheduleErrorText,
  scheduleRunWindow,
  nextCronRun,
  type AgentSchedule,
  type AgentScheduleInput,
  type AgentScheduleRun,
} from '../../shared/agent-schedules.ts';

export class AgentScheduleError extends Error {
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = 'AgentScheduleError';
    this.status = status;
  }
}

type Row = Record<string, unknown>;
const id = () => crypto.randomUUID();

function rowToSchedule(row: Row): AgentSchedule {
  return {
    id: row.id as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ownerAgentLabel: row.owner_agent_label as string,
    cronExpression: (row.cron_expression as string | null) ?? null,
    nextRunAt: (row.next_run_at as string | null) ?? null,
    toAgentLabel: (row.to_agent_label as string | null) ?? null,
    subjectType: row.subject_type as AgentSchedule['subjectType'],
    subjectId: (row.subject_id as string | null) ?? null,
    messageTemplate: row.message_template as string,
    dedupeKey: row.dedupe_key as string,
    paused: Boolean(row.paused),
    failurePolicy: row.failure_policy as AgentSchedule['failurePolicy'],
    lastRunStatus: (row.last_run_status as AgentSchedule['lastRunStatus']) ?? null,
    lastRunAt: (row.last_run_at as string | null) ?? null,
    lastRunWindow: (row.last_run_window as string | null) ?? null,
    lastHandoffId: (row.last_handoff_id as string | null) ?? null,
    lastError: (row.last_error as string | null) ?? null,
  };
}

function rowToRun(row: Row): AgentScheduleRun {
  return {
    id: row.id as string,
    scheduleId: row.schedule_id as string,
    runWindow: row.run_window as string,
    status: row.status as AgentScheduleRun['status'],
    handoffId: (row.handoff_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

function getRow(db: Db, scheduleId: string): Row | undefined {
  return db.prepare('SELECT * FROM agent_schedules WHERE id=?').get(scheduleId) as Row | undefined;
}

function requireSchedule(db: Db, scheduleId: string): AgentSchedule {
  const row = getRow(db, scheduleId);
  if (!row) throw new AgentScheduleError('Schedule not found.', 404);
  return rowToSchedule(row);
}

export function listSchedules(db: Db): AgentSchedule[] {
  return (
    db
      .prepare('SELECT * FROM agent_schedules ORDER BY paused ASC, next_run_at ASC, id ASC')
      .all() as Row[]
  ).map(rowToSchedule);
}

export function getSchedule(db: Db, scheduleId: string): AgentSchedule {
  return requireSchedule(db, scheduleId);
}

export function createSchedule(db: Db, raw: AgentScheduleInput, now = new Date()): AgentSchedule {
  const input = agentScheduleInputSchema.parse(raw);
  const instant = now.toISOString();
  const scheduleId = id();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO agent_schedules(
        id,created_at,updated_at,owner_agent_label,cron_expression,next_run_at,to_agent_label,
        subject_type,subject_id,message_template,dedupe_key,paused,failure_policy
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      scheduleId,
      instant,
      instant,
      input.ownerAgentLabel,
      input.cronExpression ?? null,
      input.nextRunAt,
      input.toAgentLabel ?? null,
      input.subjectType,
      input.subjectId ?? null,
      redactSecrets(input.messageTemplate),
      input.dedupeKey,
      input.paused ? 1 : 0,
      input.failurePolicy,
    );
  });
  return requireSchedule(db, scheduleId);
}

export function setSchedulePaused(
  db: Db,
  scheduleId: string,
  raw: unknown,
  now = new Date(),
): AgentSchedule {
  const { paused } = agentSchedulePauseSchema.parse(raw);
  const instant = now.toISOString();
  transaction(db, () => {
    requireSchedule(db, scheduleId);
    db.prepare('UPDATE agent_schedules SET paused=?,updated_at=? WHERE id=?').run(
      paused ? 1 : 0,
      instant,
      scheduleId,
    );
  });
  return requireSchedule(db, scheduleId);
}

function runClientRequestId(scheduleId: string, runWindow: string): string {
  return crypto.createHash('sha256').update(`${scheduleId}:${runWindow}`).digest('hex');
}

function markFailed(
  db: Db,
  schedule: AgentSchedule,
  runWindow: string,
  startedAt: string,
  finishedAt: string,
  error: unknown,
) {
  const message = redactSecrets(scheduleErrorText(error));
  transaction(db, () => {
    const existing = db
      .prepare('SELECT id FROM agent_schedule_runs WHERE schedule_id=? AND run_window=?')
      .get(schedule.id, runWindow) as { id: string } | undefined;
    const runId = existing?.id ?? id();
    if (existing) {
      db.prepare('UPDATE agent_schedule_runs SET status=?,error=?,finished_at=? WHERE id=?').run(
        'FAILED',
        message,
        finishedAt,
        runId,
      );
    } else {
      db.prepare(
        `INSERT INTO agent_schedule_runs(id,schedule_id,run_window,status,handoff_id,error,started_at,finished_at)
         VALUES(?,?,?,'FAILED',NULL,?,?,?)`,
      ).run(runId, schedule.id, runWindow, message, startedAt, finishedAt);
    }
    db.prepare(
      `UPDATE agent_schedules SET last_run_status='FAILED',last_run_at=?,last_run_window=?,last_handoff_id=NULL,
       last_error=?,paused=CASE WHEN failure_policy='PAUSE' THEN 1 ELSE paused END,updated_at=? WHERE id=?`,
    ).run(finishedAt, runWindow, message, finishedAt, schedule.id);
  });
  return message;
}

function runSchedule(
  db: Db,
  scheduleId: string,
  now: Date,
  force: boolean,
): { schedule: AgentSchedule; handoffId: string | null; skipped: boolean } {
  const schedule = requireSchedule(db, scheduleId);
  if (!force && schedule.paused) return { schedule, handoffId: null, skipped: true };
  if (!force && (!schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now.getTime()))
    return { schedule, handoffId: null, skipped: true };

  const runWindow = scheduleRunWindow(force ? now.toISOString() : schedule.nextRunAt!);
  const startedAt = now.toISOString();
  try {
    return transaction(db, () => {
      const existing = db
        .prepare('SELECT * FROM agent_schedule_runs WHERE schedule_id=? AND run_window=?')
        .get(schedule.id, runWindow) as Row | undefined;
      if (existing?.status === 'SUCCEEDED')
        return {
          schedule: requireSchedule(db, schedule.id),
          handoffId: existing.handoff_id as string,
          skipped: true,
        };
      if (existing?.status === 'RUNNING')
        throw new AgentScheduleError('This schedule run is already in progress.', 409);
      const runId = existing?.id as string | undefined;
      if (runId) {
        db.prepare(
          "UPDATE agent_schedule_runs SET status='RUNNING',error=NULL,finished_at=NULL WHERE id=?",
        ).run(runId);
      } else {
        db.prepare(
          `INSERT INTO agent_schedule_runs(id,schedule_id,run_window,status,handoff_id,error,started_at,finished_at)
           VALUES(?,?,?,'RUNNING',NULL,NULL,?,NULL)`,
        ).run(id(), schedule.id, runWindow, startedAt);
      }
      const handoff = insertHandoff(
        db,
        {
          fromAgentLabel: schedule.ownerAgentLabel,
          toAgentLabel: schedule.toAgentLabel,
          subjectType: schedule.subjectType,
          subjectId: schedule.subjectId,
          message: schedule.messageTemplate,
          clientRequestId: runClientRequestId(schedule.id, runWindow),
        },
        startedAt,
      );
      const nextRunAt = force
        ? schedule.nextRunAt
        : schedule.cronExpression
          ? (nextCronRun(schedule.cronExpression, new Date(runWindow))?.toISOString() ?? null)
          : null;
      const finishedAt = new Date().toISOString();
      db.prepare(
        `UPDATE agent_schedule_runs SET status='SUCCEEDED',handoff_id=?,error=NULL,finished_at=?
         WHERE schedule_id=? AND run_window=?`,
      ).run(handoff.id, finishedAt, schedule.id, runWindow);
      db.prepare(
        `UPDATE agent_schedules SET next_run_at=?,last_run_status='SUCCEEDED',last_run_at=?,last_run_window=?,
         last_handoff_id=?,last_error=NULL,updated_at=? WHERE id=?`,
      ).run(nextRunAt, finishedAt, runWindow, handoff.id, finishedAt, schedule.id);
      return { schedule: requireSchedule(db, schedule.id), handoffId: handoff.id, skipped: false };
    });
  } catch (error) {
    const message = markFailed(db, schedule, runWindow, startedAt, now.toISOString(), error);
    if (force)
      throw new AgentScheduleError(
        message,
        error instanceof AgentScheduleError ? error.status : 500,
      );
    return { schedule: requireSchedule(db, schedule.id), handoffId: null, skipped: false };
  }
}

export function runScheduleNow(db: Db, scheduleId: string, now = new Date()): AgentSchedule {
  return runSchedule(db, scheduleId, now, true).schedule;
}

export interface DueScheduleResult {
  scheduleId: string;
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
  handoffId: string | null;
  error: string | null;
}

export function runDueSchedules(db: Db, now = new Date()): DueScheduleResult[] {
  const due = (
    db
      .prepare(
        'SELECT id FROM agent_schedules WHERE paused=0 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC',
      )
      .all(now.toISOString()) as Array<{ id: string }>
  ).map((row) => row.id);
  return due.map((scheduleId) => {
    const result = runSchedule(db, scheduleId, now, false);
    return {
      scheduleId,
      status: result.skipped
        ? 'SKIPPED'
        : result.schedule.lastRunStatus === 'FAILED'
          ? 'FAILED'
          : 'SUCCEEDED',
      handoffId: result.handoffId,
      error: result.schedule.lastError,
    };
  });
}

export function listScheduleRuns(db: Db, scheduleId: string): AgentScheduleRun[] {
  requireSchedule(db, scheduleId);
  return (
    db
      .prepare(
        'SELECT * FROM agent_schedule_runs WHERE schedule_id=? ORDER BY started_at DESC, id DESC LIMIT 20',
      )
      .all(scheduleId) as Row[]
  ).map(rowToRun);
}
