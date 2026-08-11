import { describe, expect, it } from 'vitest';
import { isDueNextSevenDays, isDueToday, isOverdue } from './deadlines.ts';

const now = new Date('2026-08-09T14:00:00-04:00');
describe('deadline rules', () => {
  it('marks only incomplete tasks before today overdue', () => {
    expect(isOverdue('2026-08-08', 'TODO', now)).toBe(true);
    expect(isOverdue('2026-08-08', 'COMPLETE', now)).toBe(false);
    expect(isOverdue('2026-08-09', 'TODO', now)).toBe(false);
  });
  it('calculates today and the next seven days in local time', () => {
    expect(isDueToday('2026-08-09', now)).toBe(true);
    expect(isDueNextSevenDays('2026-08-12', now)).toBe(true);
    expect(isDueNextSevenDays('2026-08-18', now)).toBe(false);
  });
});
