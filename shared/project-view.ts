/**
 * Projects page presentation and live-status filters (C101 / issue #300).
 *
 * Grid and list are two presentations over one filtered result set. Live planning statuses are
 * filtered separately from archive visibility: `statuses` never includes ARCHIVED, and an empty
 * selection means no further narrowing within the current visibility.
 *
 * URL values are read defensively the same way other durable view parameters are — unknown tokens
 * are dropped, and a missing parameter falls back to the canonical default (grid, no status filter).
 * Settings does not yet store these; when it does, `resolveViewChoice` will supply the configured
 * default the same way C100 does for visibility and sort.
 */
export const PROJECT_PRESENTATIONS = ['grid', 'list'] as const;
export type ProjectPresentation = (typeof PROJECT_PRESENTATIONS)[number];

export const CANONICAL_PROJECT_PRESENTATION: ProjectPresentation = 'grid';

/** Live planning statuses a Projects filter may select. Archive scope stays on `visibility`. */
export const LIVE_PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETE'] as const;
export type LiveProjectStatus = (typeof LIVE_PROJECT_STATUSES)[number];

export const LIVE_PROJECT_STATUS_LABEL: Record<LiveProjectStatus, string> = {
  PLANNING: 'Planning',
  ACTIVE: 'Active',
  ON_HOLD: 'On hold',
  COMPLETE: 'Complete',
};

const isLiveProjectStatus = (value: string): value is LiveProjectStatus =>
  (LIVE_PROJECT_STATUSES as readonly string[]).includes(value);

/**
 * Parses a comma-separated `statuses` query value into the allowed live statuses, in canonical
 * order, dropping unknowns and duplicates so a shared link stays stable.
 */
export function parseLiveProjectStatuses(raw: string | null): LiveProjectStatus[] {
  const selected = new Set<LiveProjectStatus>();
  for (const part of (raw || '').split(',')) {
    const token = part.trim();
    if (isLiveProjectStatus(token)) selected.add(token);
  }
  return LIVE_PROJECT_STATUSES.filter((status) => selected.has(status));
}

/** Serializes selected live statuses in canonical order for the address bar. */
export function serializeLiveProjectStatuses(statuses: readonly LiveProjectStatus[]): string {
  return LIVE_PROJECT_STATUSES.filter((status) => statuses.includes(status)).join(',');
}
