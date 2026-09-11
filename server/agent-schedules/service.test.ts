import { describe, expect, it } from 'vitest';
import { createDb } from '../db';
import {
  createSchedule,
  listScheduleRuns,
  runDueSchedules,
  runScheduleNow,
  setSchedulePaused,
} from './service';

const NOW = new Date('2026-09-11T12:05:42.000Z');
const input = {
  ownerAgentLabel: 'cursor',
  toAgentLabel: 'claude',
  subjectType: 'freeform' as const,
  subjectId: null,
  messageTemplate: 'Review the latest draft.',
  dedupeKey: 'weekly-review',
  cronExpression: '*/5 * * * *',
  nextRunAt: '2026-09-11T12:05:00.000Z',
  failurePolicy: 'RETRY' as const,
  paused: false,
};

describe('scheduled agent run service', () => {
  it('creates one handoff per due window and advances recurring schedules', () => {
    const db = createDb(':memory:');
    const schedule = createSchedule(db, input, NOW);
    const first = runDueSchedules(db, NOW);
    const second = runDueSchedules(db, NOW);
    expect(first).toEqual([
      expect.objectContaining({ scheduleId: schedule.id, status: 'SUCCEEDED' }),
    ]);
    expect(second).toEqual([]);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM agent_handoffs WHERE from_agent_label='cursor'")
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      runScheduleNow(db, schedule.id, new Date('2026-09-11T13:00:00.000Z')).lastRunStatus,
    ).toBe('SUCCEEDED');
    expect(listScheduleRuns(db, schedule.id)).toHaveLength(2);
    db.close();
  });

  it('does not run a paused schedule but allows an explicit run-now', () => {
    const db = createDb(':memory:');
    const schedule = createSchedule(db, { ...input, paused: true }, NOW);
    expect(runDueSchedules(db, NOW)).toEqual([]);
    setSchedulePaused(db, schedule.id, { paused: false }, NOW);
    expect(runDueSchedules(db, NOW)[0]?.status).toBe('SUCCEEDED');
    const paused = setSchedulePaused(db, schedule.id, { paused: true }, NOW);
    expect(paused.paused).toBe(true);
    expect(
      runScheduleNow(db, schedule.id, new Date('2026-09-11T12:10:00.000Z')).lastRunStatus,
    ).toBe('SUCCEEDED');
    db.close();
  });

  it('records a failed run and leaves the schedule due for retry', () => {
    const db = createDb(':memory:');
    const schedule = createSchedule(db, input, NOW);
    db.prepare('UPDATE agent_schedules SET message_template=? WHERE id=?').run(
      'Bearer test-token',
      schedule.id,
    );
    const result = runDueSchedules(db, NOW);
    expect(result[0]).toMatchObject({ scheduleId: schedule.id, status: 'FAILED' });
    const stored = db
      .prepare('SELECT paused,last_run_status,next_run_at FROM agent_schedules WHERE id=?')
      .get(schedule.id) as {
      paused: number;
      last_run_status: string;
      next_run_at: string;
    };
    expect(stored).toMatchObject({
      paused: 0,
      last_run_status: 'FAILED',
      next_run_at: input.nextRunAt,
    });
    expect(listScheduleRuns(db, schedule.id)[0]?.status).toBe('FAILED');
    db.close();
  });
});
