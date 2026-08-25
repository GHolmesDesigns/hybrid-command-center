import { describe, expect, it } from 'vitest';
import {
  CANONICAL_VIEW_DEFAULTS,
  CLIENT_VISIBILITIES,
  PROJECT_SORTS,
  isCurrentTimePeriod,
  isViewDefaults,
  resolveViewChoice,
  viewDefaultsIssues,
  type ViewDefaults,
} from './view-defaults.ts';

const defaults = (overrides: Partial<ViewDefaults> = {}): ViewDefaults => ({
  clients: { ...CANONICAL_VIEW_DEFAULTS.clients, ...overrides.clients },
  projects: { ...CANONICAL_VIEW_DEFAULTS.projects, ...overrides.projects },
  calendar: { ...CANONICAL_VIEW_DEFAULTS.calendar, ...overrides.calendar },
  signal: { ...CANONICAL_VIEW_DEFAULTS.signal, ...overrides.signal },
});

describe('viewDefaultsIssues', () => {
  it('accepts the shipped canonical defaults', () => {
    expect(viewDefaultsIssues(CANONICAL_VIEW_DEFAULTS)).toEqual([]);
    expect(isViewDefaults(CANONICAL_VIEW_DEFAULTS)).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(viewDefaultsIssues(null)).toEqual([
      { path: '', message: 'Expected a view-defaults object.' },
    ]);
    expect(viewDefaultsIssues('month')).toEqual([
      { path: '', message: 'Expected a view-defaults object.' },
    ]);
  });

  it('rejects an unknown page rather than silently dropping it', () => {
    const issues = viewDefaultsIssues({ ...CANONICAL_VIEW_DEFAULTS, status: { view: 'board' } });
    expect(issues).toContainEqual({ path: 'status', message: 'Unknown page "status".' });
  });

  it('rejects an unknown field on a known page', () => {
    const issues = viewDefaultsIssues({
      ...CANONICAL_VIEW_DEFAULTS,
      clients: { visibility: 'active', sort: 'name' },
    });
    expect(issues).toContainEqual({
      path: 'clients.sort',
      message: 'Unknown clients field "sort".',
    });
  });

  it('rejects a value outside the settled vocabulary', () => {
    expect(
      viewDefaultsIssues(
        defaults({ projects: { visibility: 'live', sort: 'popularity' as never } }),
      ),
    ).toContainEqual({
      path: 'projects.sort',
      message: `Expected one of ${PROJECT_SORTS.join(', ')}.`,
    });
    expect(viewDefaultsIssues(defaults({ calendar: { view: 'year' as never } }))).toContainEqual({
      path: 'calendar.view',
      message: 'Expected one of today, week, month.',
    });
  });

  it('reports every missing page at once', () => {
    const issues = viewDefaultsIssues({ clients: { visibility: 'active' } });
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['projects', 'calendar', 'signal']),
    );
  });
});

describe('resolveViewChoice', () => {
  it('lets an explicit allowed URL value win over the configured default', () => {
    expect(resolveViewChoice('archived', CLIENT_VISIBILITIES, 'active')).toBe('archived');
    expect(resolveViewChoice('name-ascending', PROJECT_SORTS, 'recently-updated')).toBe(
      'name-ascending',
    );
  });

  it('falls back to the configured default when the URL omits or retires a value', () => {
    expect(resolveViewChoice(null, CLIENT_VISIBILITIES, 'archived')).toBe('archived');
    expect(resolveViewChoice('retired', CLIENT_VISIBILITIES, 'all')).toBe('all');
    expect(resolveViewChoice('', PROJECT_SORTS, 'priority')).toBe('priority');
  });
});

describe('isCurrentTimePeriod', () => {
  it('recognises today, the current month, and the Monday–Sunday week of today', () => {
    expect(isCurrentTimePeriod('today', '2026-08-25', '2026-08-25')).toBe(true);
    expect(isCurrentTimePeriod('today', '2026-08-24', '2026-08-25')).toBe(false);
    expect(isCurrentTimePeriod('month', '2026-08-01', '2026-08-25')).toBe(true);
    expect(isCurrentTimePeriod('month', '2026-07-31', '2026-08-25')).toBe(false);
    // Tuesday 25 Aug 2026 sits in the week Monday 24 – Sunday 30.
    expect(isCurrentTimePeriod('week', '2026-08-24', '2026-08-25')).toBe(true);
    expect(isCurrentTimePeriod('week', '2026-08-30', '2026-08-25')).toBe(true);
    expect(isCurrentTimePeriod('week', '2026-08-31', '2026-08-25')).toBe(false);
  });
});
