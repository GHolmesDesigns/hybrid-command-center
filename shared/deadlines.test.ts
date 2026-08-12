import { describe, expect, it } from 'vitest';
import { isDueNextSevenDays, isDueToday, isDueWithinDays, isOverdue } from './deadlines.ts';

const now = new Date('2026-08-09T14:00:00-04:00');
/** A task is a due date plus a status; every rule here needs both. */
const due = (dueDate?: string | null, status = 'TODO') => ({ dueDate, status });

describe('deadline rules', () => {
  it('marks only incomplete tasks before today overdue', () => {
    expect(isOverdue(due('2026-08-08'), now)).toBe(true);
    expect(isOverdue(due('2026-08-08', 'COMPLETE'), now)).toBe(false);
    expect(isOverdue(due('2026-08-09'), now)).toBe(false);
  });

  it('counts a task due today in both Due today and Next 7 days', () => {
    expect(isDueToday(due('2026-08-09'), now)).toBe(true);
    // The defect this card exists for: the old window started tomorrow.
    expect(isDueNextSevenDays(due('2026-08-09'), now)).toBe(true);
  });

  it('includes both ends of the seven-day window and nothing past it', () => {
    expect(isDueNextSevenDays(due('2026-08-12'), now)).toBe(true);
    expect(isDueNextSevenDays(due('2026-08-16'), now)).toBe(true);
    expect(isDueNextSevenDays(due('2026-08-17'), now)).toBe(false);
    expect(isDueNextSevenDays(due('2026-08-18'), now)).toBe(false);
    // Day 0 is the last day in at a window of 0, day 1 the first day out.
    expect(isDueWithinDays(due('2026-08-09'), 0, now)).toBe(true);
    expect(isDueWithinDays(due('2026-08-10'), 0, now)).toBe(false);
  });

  it('excludes work that is already finished from every bucket', () => {
    expect(isDueToday(due('2026-08-09', 'COMPLETE'), now)).toBe(false);
    expect(isDueNextSevenDays(due('2026-08-12', 'COMPLETE'), now)).toBe(false);
    expect(isDueWithinDays(due('2026-08-12', 'COMPLETE'), 7, now)).toBe(false);
  });

  it('puts a task with no due date in no bucket at all', () => {
    for (const empty of [undefined, null, '']) {
      expect(isOverdue(due(empty), now)).toBe(false);
      expect(isDueToday(due(empty), now)).toBe(false);
      expect(isDueNextSevenDays(due(empty), now)).toBe(false);
    }
  });

  it('reads the local calendar day on either side of midnight', () => {
    // One minute before and one minute after local midnight, the same due date changes
    // bucket exactly once — at local midnight, not at UTC midnight four hours earlier.
    const beforeMidnight = new Date('2026-08-09T23:59:00-04:00');
    const afterMidnight = new Date('2026-08-10T00:01:00-04:00');
    expect(isDueToday(due('2026-08-09'), beforeMidnight)).toBe(true);
    expect(isOverdue(due('2026-08-09'), beforeMidnight)).toBe(false);
    expect(isDueToday(due('2026-08-09'), afterMidnight)).toBe(false);
    expect(isOverdue(due('2026-08-09'), afterMidnight)).toBe(true);

    // 21:00 local on Aug 9 is already Aug 10 in UTC; the day must still read Aug 9.
    const lateEvening = new Date('2026-08-09T21:00:00-04:00');
    expect(lateEvening.toISOString().slice(0, 10)).toBe('2026-08-10');
    expect(isDueToday(due('2026-08-09'), lateEvening)).toBe(true);
  });

  it('measures the window in calendar days across a DST transition', () => {
    // US DST ends 2026-11-01, so the week from Oct 30 contains a 25-hour day. Counting
    // hours rather than days would pull Nov 6 out of the window by an hour.
    const beforeTheChange = new Date('2026-10-30T09:00:00-04:00');
    expect(isDueToday(due('2026-10-30'), beforeTheChange)).toBe(true);
    expect(isDueNextSevenDays(due('2026-11-06'), beforeTheChange)).toBe(true);
    expect(isDueNextSevenDays(due('2026-11-07'), beforeTheChange)).toBe(false);

    // And from the other side of the change, looking back over it.
    const afterTheChange = new Date('2026-11-02T09:00:00-05:00');
    expect(isOverdue(due('2026-10-30'), afterTheChange)).toBe(true);
    expect(isDueToday(due('2026-11-02'), afterTheChange)).toBe(true);
    expect(isDueNextSevenDays(due('2026-11-09'), afterTheChange)).toBe(true);
    expect(isDueNextSevenDays(due('2026-11-10'), afterTheChange)).toBe(false);
  });

  it('pins a full timestamp to the local day it falls on', () => {
    expect(isDueToday(due('2026-08-09T22:00:00-04:00'), now)).toBe(true);
    expect(isDueToday(due('2026-08-10T00:30:00-04:00'), now)).toBe(false);
  });
});
