/**
 * User-configurable default views and sorts (C100 / issue #299).
 *
 * Only pages with a settled view/sort vocabulary appear here. A configured value applies when
 * the URL omits that parameter; an explicit URL value always wins. Canonical defaults match the
 * hard-coded behaviour these pages already shipped with, and Reset restores them.
 *
 * Invalid stored settings fail closed to the canonical object rather than breaking a page load.
 * The same vocabulary validates the Settings form, the API, and every page that consumes a
 * default — one list of allowed values, not three copies.
 */
import { CALENDAR_VIEWS, type CalendarViewMode } from './calendar.ts';

export const VIEW_DEFAULT_PAGES = ['clients', 'projects', 'calendar', 'signal'] as const;
export type ViewDefaultPage = (typeof VIEW_DEFAULT_PAGES)[number];

export const CLIENT_VISIBILITIES = ['active', 'archived', 'all'] as const;
export type ClientVisibility = (typeof CLIENT_VISIBILITIES)[number];

export const PROJECT_VISIBILITIES = ['live', 'archived', 'all'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

export const PROJECT_SORTS = [
  'recently-updated',
  'recently-created',
  'name-ascending',
  'name-descending',
  'deadline',
  'priority',
  'custom',
] as const;
export type ProjectSort = (typeof PROJECT_SORTS)[number];

export interface ViewDefaults {
  clients: { visibility: ClientVisibility };
  projects: { visibility: ProjectVisibility; sort: ProjectSort };
  calendar: { view: CalendarViewMode };
  signal: { view: CalendarViewMode };
}

/** Shipped defaults: live/active collections by recency, month agenda on Calendar and Signal. */
export const CANONICAL_VIEW_DEFAULTS: ViewDefaults = {
  clients: { visibility: 'active' },
  projects: { visibility: 'live', sort: 'recently-updated' },
  calendar: { view: 'month' },
  signal: { view: 'month' },
};

export const VIEW_DEFAULTS_SETTING_KEY = 'view_defaults';

export const CLIENT_VISIBILITY_LABEL: Record<ClientVisibility, string> = {
  active: 'Active',
  archived: 'Archived',
  all: 'All',
};

export const PROJECT_VISIBILITY_LABEL: Record<ProjectVisibility, string> = {
  live: 'Live',
  archived: 'Archived',
  all: 'All',
};

export const PROJECT_SORT_LABEL: Record<ProjectSort, string> = {
  'recently-updated': 'Recently updated',
  'recently-created': 'Recently created',
  'name-ascending': 'Name A–Z',
  'name-descending': 'Name Z–A',
  deadline: 'Deadline',
  priority: 'Priority',
  custom: 'Custom order',
};

export const TIME_VIEW_LABEL: Record<CalendarViewMode, string> = {
  today: 'Today',
  week: 'Week',
  month: 'Month',
};

export type ViewDefaultsIssue = { path: string; message: string };

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

/**
 * Every reason a settings object would be refused. An empty array means it is safe to store.
 * Unknown pages and unknown values are rejected rather than silently dropped, so a stale payload
 * cannot leave half a preference applied.
 */
export function viewDefaultsIssues(value: unknown): ViewDefaultsIssue[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return [{ path: '', message: 'Expected a view-defaults object.' }];
  const record = value as Record<string, unknown>;
  const issues: ViewDefaultsIssue[] = [];
  for (const key of Object.keys(record))
    if (!(VIEW_DEFAULT_PAGES as readonly string[]).includes(key))
      issues.push({ path: key, message: `Unknown page "${key}".` });
  for (const page of VIEW_DEFAULT_PAGES)
    if (!(page in record)) issues.push({ path: page, message: `Missing page "${page}".` });

  const clients = record.clients;
  if (clients !== undefined) {
    if (clients === null || typeof clients !== 'object' || Array.isArray(clients))
      issues.push({ path: 'clients', message: 'Expected a clients defaults object.' });
    else {
      const page = clients as Record<string, unknown>;
      for (const key of Object.keys(page))
        if (key !== 'visibility')
          issues.push({ path: `clients.${key}`, message: `Unknown clients field "${key}".` });
      if (!isOneOf(page.visibility, CLIENT_VISIBILITIES))
        issues.push({
          path: 'clients.visibility',
          message: `Expected one of ${CLIENT_VISIBILITIES.join(', ')}.`,
        });
    }
  }

  const projects = record.projects;
  if (projects !== undefined) {
    if (projects === null || typeof projects !== 'object' || Array.isArray(projects))
      issues.push({ path: 'projects', message: 'Expected a projects defaults object.' });
    else {
      const page = projects as Record<string, unknown>;
      for (const key of Object.keys(page))
        if (key !== 'visibility' && key !== 'sort')
          issues.push({ path: `projects.${key}`, message: `Unknown projects field "${key}".` });
      if (!isOneOf(page.visibility, PROJECT_VISIBILITIES))
        issues.push({
          path: 'projects.visibility',
          message: `Expected one of ${PROJECT_VISIBILITIES.join(', ')}.`,
        });
      if (!isOneOf(page.sort, PROJECT_SORTS))
        issues.push({
          path: 'projects.sort',
          message: `Expected one of ${PROJECT_SORTS.join(', ')}.`,
        });
    }
  }

  for (const page of ['calendar', 'signal'] as const) {
    const entry = record[page];
    if (entry === undefined) continue;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ path: page, message: `Expected a ${page} defaults object.` });
      continue;
    }
    const body = entry as Record<string, unknown>;
    for (const key of Object.keys(body))
      if (key !== 'view')
        issues.push({ path: `${page}.${key}`, message: `Unknown ${page} field "${key}".` });
    if (!isOneOf(body.view, CALENDAR_VIEWS))
      issues.push({
        path: `${page}.view`,
        message: `Expected one of ${CALENDAR_VIEWS.join(', ')}.`,
      });
  }

  return issues;
}

/** True when `value` is a complete, allowed view-defaults object. */
export function isViewDefaults(value: unknown): value is ViewDefaults {
  return viewDefaultsIssues(value).length === 0;
}

/**
 * Picks the effective choice for one durable URL parameter.
 *
 * A present, allowed URL value wins. A missing or retired value falls back to the configured
 * default so a bookmark keeps working and a clean navigation follows Settings.
 */
export function resolveViewChoice<T extends string>(
  requested: string | null,
  allowed: readonly T[],
  configured: T,
): T {
  if (requested !== null && (allowed as readonly string[]).includes(requested))
    return requested as T;
  return configured;
}

/**
 * Whether a time-view URL is the ordinary current period for `view`, so the address can stay
 * short by omitting period parameters. Weeks are Monday–Sunday, matching `calendarViewRange`.
 */
export function isCurrentTimePeriod(
  view: CalendarViewMode,
  anchor: string,
  today: string,
): boolean {
  if (view === 'today') return anchor === today;
  if (view === 'month') return anchor.slice(0, 7) === today.slice(0, 7);
  const sundayFirst = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  };
  const mondayOf = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const offset = -((sundayFirst(iso) + 6) % 7);
    const monday = new Date(Date.UTC(y, m - 1, d + offset));
    return `${String(monday.getUTCFullYear()).padStart(4, '0')}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
  };
  return mondayOf(anchor) === mondayOf(today);
}
