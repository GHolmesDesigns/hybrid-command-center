import { describe, expect, it } from 'vitest';
import type { TimeEntry } from './types.ts';
import {
  currentWeekRange,
  isIsoDay,
  readWorkspaceTimeFilters,
  workspaceTimeCsv,
} from './workspace-time.ts';

const entry: TimeEntry = {
  id: 'entry',
  projectId: 'project',
  projectName: 'North, Inc.',
  taskId: 'task',
  taskTitle: 'Research',
  categoryId: 'category',
  categoryName: 'Design',
  startedAt: '2026-11-08T05:30:00.000Z',
  endedAt: '2026-11-08T06:30:00.000Z',
  durationSeconds: 3600,
  notes: 'Said "ready"',
  createdAt: '',
  updatedAt: '',
  revision: 1,
};

describe('workspace time report rules', () => {
  it('uses Monday through Sunday in the operator time zone', () => {
    expect(currentWeekRange(new Date('2026-11-09T02:00:00.000Z'), 'America/New_York')).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
  });

  it('ignores invalid and backward URL ranges and unavailable entity filters', () => {
    expect(isIsoDay(null)).toBe(false);
    expect(isIsoDay('bad')).toBe(false);
    expect(isIsoDay('2026-11-08')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    const result = readWorkspaceTimeFilters(
      new URLSearchParams('from=2026-11-09&to=2026-11-02&project=retired'),
      { from: '2026-11-02', to: '2026-11-08' },
      { projects: new Set(), tasks: new Set(), categories: new Set() },
    );
    expect(result.filters).toMatchObject({ from: '2026-11-02', to: '2026-11-08', projectId: '' });
    expect(result.ignored).toEqual({ date: true, project: true, task: false, category: false });
  });

  it('accepts a one-sided date and known filters while omitting false warnings', () => {
    const result = readWorkspaceTimeFilters(
      new URLSearchParams('from=2026-11-03&project=p&task=t&category=c'),
      { from: '2026-11-02', to: '2026-11-08' },
      {
        projects: new Set(['p']),
        tasks: new Set(['t']),
        categories: new Set(['c']),
      },
    );
    expect(result.filters).toEqual({
      from: '2026-11-03',
      to: '2026-11-08',
      projectId: 'p',
      taskId: 't',
      categoryId: 'c',
    });
    expect(result.ignored).toEqual({ date: false, project: false, task: false, category: false });
  });

  it('uses the configured week when filters are absent and falls back per invalid date', () => {
    const ids = {
      projects: new Set<string>(),
      tasks: new Set<string>(),
      categories: new Set<string>(),
    };
    const defaults = { from: '2026-11-02', to: '2026-11-08' };
    expect(readWorkspaceTimeFilters(new URLSearchParams(), defaults, ids)).toEqual({
      filters: { ...defaults, projectId: '', taskId: '', categoryId: '' },
      ignored: { date: false, project: false, task: false, category: false },
    });
    const invalid = readWorkspaceTimeFilters(
      new URLSearchParams('from=invalid&to=2026-11-07'),
      defaults,
      ids,
    );
    expect(invalid.filters).toMatchObject({ from: defaults.from, to: '2026-11-07' });
    expect(invalid.ignored.date).toBe(true);
  });

  it('exports only supplied matching rows in the established column order and four-place hours', () => {
    const csv = workspaceTimeCsv([entry], 'America/New_York');
    expect(csv.split('\r\n')[0]).toBe(
      '"Date","Start time","End date","End time","Duration (hours)","Project","Task","Category","Notes"',
    );
    expect(csv.split('\r\n')[1]).toBe(
      '"2026-11-08","00:30","2026-11-08","01:30","1.0000","North, Inc.","Research","Design","Said ""ready"""',
    );
    const unassigned = workspaceTimeCsv(
      [{ ...entry, taskId: undefined, taskTitle: undefined }],
      'UTC',
    );
    expect(unassigned.split('\r\n')[1]).toContain('"1.0000","North, Inc.","","Design"');
    expect(workspaceTimeCsv([], 'UTC')).toContain('"Duration (hours)"');
  });
});
