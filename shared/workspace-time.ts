import type { TimeEntry } from './types.ts';

export type WorkspaceTimeFilterState = {
  from: string;
  to: string;
  projectId: string;
  taskId: string;
  categoryId: string;
};

export function isIsoDay(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function currentWeekRange(now: Date, timeZone: string) {
  const parts = new Map(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value]),
  );
  const localDay = `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
  const [year, month, day] = localDay.split('-').map(Number);
  const shift = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(year, month - 1, day - shift));
  const sunday = new Date(Date.UTC(year, month - 1, day - shift + 6));
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

export function readWorkspaceTimeFilters(
  search: URLSearchParams,
  defaults: { from: string; to: string },
  validIds: { projects: Set<string>; tasks: Set<string>; categories: Set<string> },
) {
  const fromValue = search.get('from');
  const toValue = search.get('to');
  const resolvedFrom = isIsoDay(fromValue) ? fromValue : defaults.from;
  const resolvedTo = isIsoDay(toValue) ? toValue : defaults.to;
  const rangeIsValid = resolvedFrom <= resolvedTo;
  return {
    filters: {
      from: rangeIsValid ? resolvedFrom : defaults.from,
      to: rangeIsValid ? resolvedTo : defaults.to,
      projectId: validIds.projects.has(search.get('project') ?? '') ? search.get('project')! : '',
      taskId: validIds.tasks.has(search.get('task') ?? '') ? search.get('task')! : '',
      categoryId: validIds.categories.has(search.get('category') ?? '')
        ? search.get('category')!
        : '',
    } satisfies WorkspaceTimeFilterState,
    ignored: {
      date:
        (fromValue !== null || toValue !== null) &&
        ((!isIsoDay(fromValue) && fromValue !== null) ||
          (!isIsoDay(toValue) && toValue !== null) ||
          !rangeIsValid),
      project: search.has('project') && !validIds.projects.has(search.get('project') ?? ''),
      task: search.has('task') && !validIds.tasks.has(search.get('task') ?? ''),
      category: search.has('category') && !validIds.categories.has(search.get('category') ?? ''),
    },
  };
}

export function workspaceTimeCsv(entries: TimeEntry[], timeZone: string): string {
  const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const datePart = (value: string, part: 'date' | 'time') => {
    const values = new Map(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        ...(part === 'time'
          ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }
          : {}),
      })
        .formatToParts(new Date(value))
        .map(({ type, value }) => [type, value]),
    );
    return part === 'date'
      ? `${values.get('year')}-${values.get('month')}-${values.get('day')}`
      : `${values.get('hour')}:${values.get('minute')}`;
  };
  const columns = [
    'Date',
    'Start time',
    'End date',
    'End time',
    'Duration (hours)',
    'Project',
    'Task',
    'Category',
    'Notes',
  ];
  const rows = entries.map((entry) =>
    [
      datePart(entry.startedAt, 'date'),
      datePart(entry.startedAt, 'time'),
      datePart(entry.endedAt, 'date'),
      datePart(entry.endedAt, 'time'),
      (entry.durationSeconds / 3600).toFixed(4),
      entry.projectName,
      entry.taskTitle ?? '',
      entry.categoryName,
      entry.notes,
    ]
      .map(csvCell)
      .join(','),
  );
  return [columns.map(csvCell).join(','), ...rows].join('\r\n');
}
