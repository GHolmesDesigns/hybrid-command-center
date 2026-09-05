import { describe, expect, it } from 'vitest';
import { calendarMonthGridRange, calendarViewRange, shiftCalendarAnchor } from './calendar.ts';

describe('calendar agenda ranges', () => {
  it('keeps Today on exactly the supplied local-date label', () => {
    expect(calendarViewRange('today', '2026-09-14')).toEqual({
      from: '2026-09-14',
      to: '2026-09-14',
    });
  });

  it('defines a week as Monday through Sunday across a month boundary', () => {
    expect(calendarViewRange('week', '2026-09-30')).toEqual({
      from: '2026-09-28',
      to: '2026-10-04',
    });
  });

  it('keeps Monday-through-Sunday boundaries across a year boundary', () => {
    expect(calendarViewRange('week', '2027-01-01')).toEqual({
      from: '2026-12-28',
      to: '2027-01-03',
    });
  });

  it('uses the full calendar month, including leap day', () => {
    expect(calendarViewRange('month', '2028-02-12')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it.each([
    ['a month already spanning complete weeks', '2015-02-12', '2015-02-01', '2015-02-28'],
    ['a leap February', '2020-02-12', '2020-01-26', '2020-02-29'],
    ['a month needing days on both sides', '2026-09-14', '2026-08-30', '2026-10-03'],
    ['a year boundary', '2026-12-14', '2026-11-29', '2027-01-02'],
  ])('defines the Sunday-through-Saturday month grid for %s', (_, anchor, from, to) => {
    expect(calendarMonthGridRange(anchor)).toEqual({ from, to });
  });

  it('steps each view by its own span and clamps short months', () => {
    expect(shiftCalendarAnchor('today', '2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftCalendarAnchor('week', '2026-12-28', 1)).toBe('2027-01-04');
    expect(shiftCalendarAnchor('month', '2026-01-31', 1)).toBe('2026-02-28');
  });
});
