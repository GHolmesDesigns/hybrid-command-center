import { describe, expect, it } from 'vitest';
import { formatDuration, projectTimeBudgetStatus, resolveLocalDateTime } from './project-time.ts';

describe('project time rules', () => {
  it('uses exact seconds for the 80 and 100 percent budget boundaries', () => {
    expect(projectTimeBudgetStatus(609 * 60, 762)).toBe('NORMAL');
    expect(projectTimeBudgetStatus(610 * 60, 762)).toBe('WARNING');
    expect(projectTimeBudgetStatus(762 * 60, 762)).toBe('WARNING');
    expect(projectTimeBudgetStatus(762 * 60 + 1, 762)).toBe('OVER');
    expect(projectTimeBudgetStatus(20, null)).toBe('UNSET');
  });

  it('refuses nonexistent daylight-saving times and requires a choice for repeated times', () => {
    expect(() => resolveLocalDateTime('2026-03-08', '02:30', 'America/New_York')).toThrow(
      /does not exist/,
    );
    expect(() => resolveLocalDateTime('2026-11-01', '01:30', 'America/New_York')).toThrow(
      /occurs twice/,
    );
    const earlier = resolveLocalDateTime('2026-11-01', '01:30', 'America/New_York', 'earlier');
    const later = resolveLocalDateTime('2026-11-01', '01:30', 'America/New_York', 'later');
    expect((later.getTime() - earlier.getTime()) / 60_000).toBe(60);
    expect(() => resolveLocalDateTime('2026-02-30', '09:00', 'UTC')).toThrow(/valid/);
    expect(() => resolveLocalDateTime('2026-02-02', '25:00', 'UTC')).toThrow(/valid/);
    expect(() => resolveLocalDateTime('2026-02-02', '09:00', 'Not/AZone')).toThrow(/time zone/);
  });

  it('formats non-negative durations as hours and minutes', () => {
    expect(formatDuration(45 * 60)).toBe('0h 45m');
    expect(formatDuration(762 * 60 + 59)).toBe('12h 42m');
  });
});
