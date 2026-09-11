import { describe, expect, it } from 'vitest';
import {
  agentScheduleInputSchema,
  isValidCronExpression,
  nextCronRun,
  scheduleErrorText,
  scheduleRunWindow,
} from './agent-schedules';

describe('scheduled agent run timing', () => {
  it('validates five-field cron and finds the next UTC minute', () => {
    expect(isValidCronExpression('0 9 * * 1')).toBe(true);
    expect(isValidCronExpression('not cron')).toBe(false);
    expect(nextCronRun('0 9 * * 1', new Date('2026-09-11T12:05:00.000Z'))?.toISOString()).toBe(
      '2026-09-14T09:00:00.000Z',
    );
  });

  it('normalizes a due instant to its dedupe window', () => {
    expect(scheduleRunWindow('2026-09-11T12:05:42.000Z')).toBe('2026-09-11T12:05:00.000Z');
  });

  it('rejects invalid fields and freeform ids, and handles impossible schedules safely', () => {
    expect(isValidCronExpression('60 * * * *')).toBe(false);
    expect(nextCronRun('bad', new Date('2026-09-11T12:05:00.000Z'))).toBeNull();
    expect(nextCronRun('0 0 31 2 *', new Date('2026-09-11T12:05:00.000Z'))).toBeNull();
    expect(() =>
      agentScheduleInputSchema.parse({
        ownerAgentLabel: 'cursor',
        subjectType: 'freeform',
        subjectId: 'unexpected-id',
        nextRunAt: '2026-09-11T12:05:00.000Z',
        messageTemplate: 'Review.',
        dedupeKey: 'test',
      }),
    ).toThrow('Freeform subjects have no id.');
    expect(scheduleErrorText('not an Error')).toBe('The scheduled run failed.');
  });
});
