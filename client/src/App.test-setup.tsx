/* eslint-disable react-refresh/only-export-components -- test helpers are intentionally shared across sliced suites */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, format } from 'date-fns';
import { App } from './App';
import { APP_VERSION, DEFAULT_BRANDING, type Branding } from '../../shared/branding';
import type { Category, Client, DashboardData, Project, Tag, Task } from '../../shared/types';
import { sameTagName } from '../../shared/types';
import {
  DUPLICATE_RULE,
  emptyCounts,
  type ImportReceipt,
  type PlaybookPreview,
} from '../../shared/playbook';
import { DRIVE_FOLDER_MIME, type DriveFile, type DriveListing } from '../../shared/drive';
import type { IntegrationEvent } from '../../shared/integration-log';
import type { CalendarRange } from '../../shared/calendar';
import {
  CLIENT_MERGE_FIELDS,
  type ClientMergeFieldPlan,
  type ClientMergeSelections,
} from '../../shared/client-merge';
import {
  SIGNAL_DEFAULT_TIME,
  normalizeSignalCampaignName,
  sameSignalCampaignName,
  suggestNextOpenSignalSlot,
  type SignalCampaign,
  type SignalCampaignSummary,
  type SignalPost,
} from '../../shared/signal';
import type { SignalCampaignAnalytics } from '../../shared/signal-campaign-analytics';
import type {
  ProviderReconcilePreview,
  PublishPreview,
  SignalPublication,
} from '../../shared/publish';
import type { PublishVariantRecord } from '../../shared/publish-variants';
import type { PostMetricsSummary } from '../../shared/publish-analytics';
import {
  DEFAULT_QUEUE_HEALTH_CONFIG,
  type QueueHealthAlert,
  type QueueHealthSummary,
} from '../../shared/queue-health';

export {
  DEFAULT_BRANDING,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  addDays,
  format,
  App,
  APP_VERSION,
  emptyCounts,
};
export type { Branding, Category, Client, DashboardData, Project, Tag, Task };
export type { ImportReceipt, PlaybookPreview };
export type { DriveFile, DriveListing };
export type { IntegrationEvent };
export type { CalendarRange, SignalPost };

export const emptyDashboard: DashboardData = {
  counts: {
    activeClients: 0,
    activeProjects: 0,
    dueToday: 0,
    dueNextSevenDays: 0,
    overdue: 0,
    projectsOverdue: 0,
  },
  overdueTasks: [],
  dueTodayTasks: [],
  upcomingTasks: [],
  recentProjects: [],
};

export const branding: Branding = {
  ...DEFAULT_BRANDING,
  mark: 'TC',
  title: 'Test Command Center',
  subtitle: 'Smoke test workspace',
  tagline: 'Offline',
};

/** Lets a suite serve branding of its own without rebuilding the whole fetch stub. */
export const setBranding = (overrides: Partial<Branding>) => {
  testState.brandingPayload = { ...branding, ...overrides };
};

export const client = (
  id: string,
  name: string,
  status: Client['status'] = 'ACTIVE',
  overrides: Partial<Client> = {},
): Client => ({
  id,
  name,
  slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${id}`,
  status,
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

export const project = (
  id: string,
  name: string,
  status: Project['status'] = 'ACTIVE',
  overrides: Partial<Project> = {},
): Project => ({
  id,
  clientId: `client-${id}`,
  clientName: 'Acme',
  name,
  status,
  priority: 'MEDIUM',
  position: 0,
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  categories: [],
  ...overrides,
});

export const projects: Project[] = [
  project('p1', 'Site refresh'),
  project('p2', 'Brand system'),
  project('p3', 'Old retainer', 'ARCHIVED'),
];

export const task = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
  id,
  projectId: 'p1',
  projectName: 'Site refresh',
  clientId: 'client-p1',
  clientName: 'Acme',
  title,
  status: 'TODO',
  priority: 'MEDIUM',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  checklist: [],
  dependencyIds: [],
  blockingDependencies: [],
  blocked: false,
  overdue: false,
  checklistCompleted: 0,
  checklistTotal: 0,
  ...overrides,
});

export const testState = {
  projectsPayload: projects,
  clientsPayload: [] as Client[],
  tasksPayload: [] as Task[],
  tagsPayload: [] as Tag[],
  categoriesPayload: [] as Category[],
  dashboardPayload: emptyDashboard as DashboardData,
  brandingPayload: null as Branding | null,
  taskPatchError: null as string | null,
  taskReorderError: null as string | null,
  dashboardFailures: 0,
  driveSettingsError: null as string | null,
  /** Receipts the Import page lists, and what its two writes answer with. */
  importReceiptsPayload: [] as ImportReceipt[],
  importPreviewPayload: null as PlaybookPreview | null,
  importCommitPayload: null as { status: number; body: unknown } | null,
  /** The integration activity log the Import page reads, or an error in its place. */
  integrationActivityPayload: [] as IntegrationEvent[],
  integrationActivityError: null as string | null,
  /**
   * What `GET /api/projects/:id/files` answers, per request, so a suite can vary the page
   * by folder and by cursor the way real Drive does. Unset means a Drive nobody connected.
   */
  driveListingPayload: null as ((projectId: string, query: URLSearchParams) => unknown) | null,
  /**
   * What `GET /api/calendar` answers, per range, so a suite can vary a month. Unset means an
   * empty month with a healthy schedule behind it.
   */
  calendarPayload: null as ((from: string, to: string) => unknown) | null,
  /** Planner state. Dated and undated posts are kept together here, then served by each API view. */
  signalPostsPayload: [] as SignalPost[],
  signalPostsTruncated: false,
  signalMutationError: null as string | null,
  publishPreviewPayload: null as PublishPreview | null,
  publicationsPayload: [] as SignalPublication[],
  publishSubmitPayload: null as SignalPublication | null,
  publishReconcilePayload: null as SignalPublication | null,
  publishFinishPayload: null as SignalPublication | null,
  providerReconcilePayload: null as ProviderReconcilePreview | null,
  providerApplyPayload: null as SignalPublication | null,
  providerApplyError: null as string | null,
  providerApplyRequests: [] as { action: string; reconcileHash: string }[],
  /**
   * The figures panel's two routes. Both answer the same shape, because the server does: a stored
   * read and a refresh are one summary, and a refusal comes back as that summary carrying its reason
   * rather than as an error status.
   *
   * Unset means a post with no deliveries to measure, which is what most cases want — the panel
   * renders nothing and no case has to say so.
   */
  postMetricsPayload: null as PostMetricsSummary | null,
  postMetricsRefreshPayload: null as PostMetricsSummary | null,
  postMetricsRefreshError: null as string | null,
  /**
   * The content overrides the composer reads and writes. Held as state rather than answered from a
   * fixture, so a case can assert what a `PUT` stored the way the real route would.
   */
  signalVariantsPayload: [] as PublishVariantRecord[],
  signalVariantsError: null as string | null,
  /**
   * Client merge. Both routes are answered from the client and project state by default — the
   * stub plans the merge the way the server would, and a commit moves the projects, archives the
   * source, and records the alias — so a case only sets one of these to rehearse a refusal.
   */
  clientMergePreviewError: null as { status: number; error: string } | null,
  clientMergeCommitError: null as { status: number; error: string } | null,
  /**
   * Client import identities, the way `client_import_aliases` holds them. The merge stub reads the
   * source's own and retargets them on commit, so a case can prove the dialog lists what moves.
   */
  clientImportAliases: [] as { namespace: string; externalId: string; clientId: string }[],
  /**
   * The queue-health summary the planner loads beside the grid.
   *
   * Held as state rather than answered from a fixture, so acknowledging behaves the way the route
   * does: the alert comes back marked and the counts move, without the case restating the summary.
   * The default is a clear one, which is what every suite that is not about health should see.
   */
  queueHealthSummary: clearQueueHealth() as QueueHealthSummary,
  queueHealthError: null as string | null,
  /**
   * The Signal campaign vocabulary, held as state so a `POST` behaves the way the route does:
   * typing a name that already exists picks it rather than adding a second row. The planner's chip
   * input suggests from this list, and the Settings card manages it.
   */
  signalCampaignsPayload: [] as SignalCampaignSummary[],
  /**
   * The campaign figures panel. Unset answers an empty workspace — no campaigns, no deliveries — so
   * every suite that is not about campaign figures sees the panel say nothing rather than fail.
   */
  signalCampaignAnalyticsPayload: null as SignalCampaignAnalytics | null,
  signalCampaignAnalyticsError: null as string | null,
  /** Every campaign-figures request, so a case can prove which filters reached the API. */
  signalCampaignAnalyticsRequests: [] as string[],
};

/** A summary with nothing on it, which is what an untouched planner suite should be handed. */
export function clearQueueHealth(): QueueHealthSummary {
  return {
    generatedAt: '2026-09-14T12:00:00.000Z',
    config: { ...DEFAULT_QUEUE_HEALTH_CONFIG },
    alerts: [],
    counts: { action: 0, watch: 0, acknowledged: 0 },
  };
}

/** One alert, with only the fields a case cares about spelled out. */
export const queueHealthAlert = (
  overrides: Partial<QueueHealthAlert> & Pick<QueueHealthAlert, 'id' | 'kind'>,
): QueueHealthAlert => ({
  severity: 'ACTION',
  subject: 'A delivered campaign post',
  title: 'Not delivered',
  detail: 'Nothing went out.',
  href: '/signal',
  fingerprint: 'fingerprint-1',
  acknowledged: false,
  ...overrides,
});

/** The counts a summary's own alerts imply, so a stubbed acknowledgement cannot disagree with them. */
const queueHealthCounts = (alerts: QueueHealthAlert[]): QueueHealthSummary['counts'] => ({
  action: alerts.filter((alert) => !alert.acknowledged && alert.severity === 'ACTION').length,
  watch: alerts.filter((alert) => !alert.acknowledged && alert.severity === 'WATCH').length,
  acknowledged: alerts.filter((alert) => alert.acknowledged).length,
});

/** Marks or unmarks one alert and answers with the whole summary, as the route does. */
const setQueueHealthAcknowledged = (alertId: string, acknowledged: boolean) => {
  const alerts = testState.queueHealthSummary.alerts.map((alert) =>
    alert.id === alertId
      ? {
          ...alert,
          acknowledged,
          ...(acknowledged ? { acknowledgedAt: '2026-09-14T12:30:00.000Z' } : {}),
        }
      : alert,
  );
  testState.queueHealthSummary = {
    ...testState.queueHealthSummary,
    alerts,
    counts: queueHealthCounts(alerts),
  };
  return testState.queueHealthSummary;
};

/** The plan the server would answer a preview with, taken from the current client state. */
export const clientMergePlan = (
  sourceId: string,
  destinationId: string,
  selections: ClientMergeSelections = {},
) => {
  const record = (id: string) => testState.clientsPayload.find((candidate) => candidate.id === id);
  const party = (id: string) => {
    const found = record(id);
    return found ? { id: found.id, name: found.name, status: found.status } : null;
  };
  const source = party(sourceId),
    destination = party(destinationId);
  if (!source || !destination) return null;
  /**
   * The six choosable fields, settled the way the planner settles them: `DESTINATION` unless a
   * choice says otherwise, whether or not either value is blank.
   */
  const fields: ClientMergeFieldPlan[] = CLIENT_MERGE_FIELDS.map(({ key }) => {
    const destinationValue = record(destinationId)?.[key] ?? null;
    const sourceValue = record(sourceId)?.[key] ?? null;
    const choice = selections[key]?.choice ?? 'DESTINATION';
    return {
      field: key,
      destination: destinationValue,
      source: sourceValue,
      choice,
      value:
        choice === 'SOURCE'
          ? sourceValue
          : choice === 'CUSTOM'
            ? (selections[key]?.value ?? null) || null
            : destinationValue,
    };
  });
  const survivingName = fields[0].value ?? destination.name;
  const slugOf = (name: string) => `${name.toLowerCase().replace(/\s+/g, '-')}-${destinationId}`;
  const merging = testState.projectsPayload
    .filter((p) => p.clientId === sourceId)
    .map((p) => ({ id: p.id, name: p.name, status: p.status }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const aliases = testState.clientImportAliases
    .filter((alias) => alias.clientId === sourceId)
    .map((alias) => ({ namespace: alias.namespace, externalId: alias.externalId }))
    .sort(
      (a, b) => a.namespace.localeCompare(b.namespace) || a.externalId.localeCompare(b.externalId),
    );
  /**
   * A hash that moves when the plan does, which is all the dialog can observe about the real
   * one: the chosen fields are folded in, so a preview taken under one set of choices cannot be
   * confirmed under another.
   */
  const chosen = fields
    .filter((field) => field.choice !== 'DESTINATION')
    .map((field) => `${field.field}:${field.choice}:${field.value ?? ''}`);
  return {
    source,
    destination,
    projects: merging,
    aliases,
    fields,
    slug: {
      current: record(destinationId)?.slug ?? '',
      next:
        survivingName === destination.name
          ? (record(destinationId)?.slug ?? '')
          : slugOf(survivingName),
    },
    planHash: `hash-${sourceId}-${merging.length}${chosen.length ? `-${chosen.join('-')}` : ''}`,
  };
};

/**
 * Campaign names as the API resolves them: matched case-insensitively against the workspace list,
 * created when new. The write routes take names and answer with records, so the stub has to do the
 * same or the editor's chips would come back as strings.
 */
export function resolveMockCampaigns(names: unknown): SignalCampaign[] {
  if (!Array.isArray(names)) return [];
  const resolved: SignalCampaign[] = [];
  for (const raw of names) {
    const name = normalizeSignalCampaignName(String(raw));
    if (!name || resolved.some((campaign) => sameSignalCampaignName(campaign.name, name))) continue;
    const existing = testState.signalCampaignsPayload.find((campaign) =>
      sameSignalCampaignName(campaign.name, name),
    );
    if (existing) {
      resolved.push({ id: existing.id, name: existing.name });
      continue;
    }
    const created: SignalCampaignSummary = {
      id: `campaign-${testState.signalCampaignsPayload.length + 1}`,
      name,
      postCount: 0,
    };
    testState.signalCampaignsPayload = [...testState.signalCampaignsPayload, created];
    resolved.push({ id: created.id, name: created.name });
  }
  return resolved;
}

/** A workspace with no campaigns and nothing measured: what the panel answers by default. */
export const emptyCampaignAnalytics = (
  overrides: Partial<SignalCampaignAnalytics> = {},
): SignalCampaignAnalytics => ({
  filters: { campaignIds: [], channels: [], accountIds: [], from: null, to: null },
  groups: [],
  scope: { posts: 0, deliveries: 0, measuredDeliveries: 0 },
  trend: [],
  channels: [],
  accounts: [],
  campaigns: [],
  ...overrides,
});

/** One scheduled post, with only the fields a case cares about spelled out. */
export const signalPost = (
  id: string,
  text: string,
  date: string | null,
  overrides: Partial<SignalPost> = {},
): SignalPost => ({
  id,
  text,
  channels: [],
  mediaUrls: [],
  date,
  time: SIGNAL_DEFAULT_TIME,
  format: 'TEXT',
  status: 'SCHEDULED',
  campaigns: [],
  cta: 'NONE',
  position: 0,
  createdAt: '2026-08-01T09:00:00.000Z',
  updatedAt: '2026-08-01T09:00:00.000Z',
  ...overrides,
});

/** A calendar range with both halves healthy unless a case says otherwise. */
export const calendarRange = (overrides: Partial<CalendarRange> = {}): CalendarRange => ({
  from: '2026-09-01',
  to: '2026-09-30',
  posts: [],
  tasks: [],
  signal: { available: true, error: null, truncated: false },
  ...overrides,
});

/** Serves the seven endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/import/receipts')) return testState.importReceiptsPayload;
  if (url.endsWith('/api/dashboard')) return testState.dashboardPayload;
  if (url.endsWith('/api/settings/branding'))
    return { branding: testState.brandingPayload ?? branding };
  if (url.endsWith('/api/projects')) return testState.projectsPayload;
  if (url.endsWith('/api/clients')) return testState.clientsPayload;
  if (url.endsWith('/api/tasks')) return testState.tasksPayload;
  if (url.endsWith('/api/tags')) return testState.tagsPayload;
  if (url.endsWith('/api/categories')) return testState.categoriesPayload;
  return [];
};

/**
 * A post nothing measures: no deliveries, and a connection with nothing to wait for.
 *
 * The default answer for both figures routes, so a case that is not about figures neither sets one up
 * nor has the panel appear in it. It is the shape the server really answers with for a post that has
 * never been published, which is why the panel renders nothing from it rather than an empty table.
 */
const emptyMetrics = (postId: string): PostMetricsSummary => ({
  postId,
  targets: [],
  refresh: { allowed: true, attempts: 0, exhausted: false },
});

export const requests: { url: string; method: string; body: any }[] = [];

/** A reply that is not a plain 200, so refusals like `TAG_IN_USE` can be rehearsed. */
type Reply = { status: number; body: unknown };
const reply = (status: number, body: unknown): Reply => ({ status, body });
const isReply = (value: unknown): value is Reply =>
  typeof value === 'object' && value !== null && 'status' in value && 'body' in value;

/**
 * Records every call and stands in for the server where a response actually feeds the next
 * step: reorder (so a reorder survives its `refresh()`), tag and category creation (so an
 * existing name is reused rather than duplicated), tag and category deletion (so an attached
 * one is refused first), and category renames and attachments (so the projects a later
 * `refresh()` serves carry what was just written).
 */
const respondTo = (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ url, method, body });
  if (url.endsWith('/api/dashboard') && testState.dashboardFailures > 0) {
    testState.dashboardFailures -= 1;
    return reply(503, { error: 'Dashboard refresh is temporarily unavailable.' });
  }
  if (url.endsWith('/api/settings/drive') && testState.driveSettingsError)
    return reply(503, { error: testState.driveSettingsError });
  if (url.includes('/api/calendar')) {
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const from = query.get('from') ?? '';
    const to = query.get('to') ?? '';
    return testState.calendarPayload
      ? testState.calendarPayload(from, to)
      : calendarRange({ from, to });
  }
  /**
   * Queue health. The summary is derived on the server, so the stub answers with whatever the case
   * set up and moves it the way the route would: an acknowledgement marks the alert and the counts
   * follow from the alerts rather than being restated.
   */
  if (url.endsWith('/api/signal/health') && method === 'GET')
    return testState.queueHealthError
      ? reply(503, { error: testState.queueHealthError })
      : testState.queueHealthSummary;
  if (url.endsWith('/api/signal/health/config') && method === 'PUT') {
    testState.queueHealthSummary = {
      ...testState.queueHealthSummary,
      config: { ...testState.queueHealthSummary.config, ...body },
    };
    return testState.queueHealthSummary;
  }
  const acknowledgePath = url.match(/\/api\/signal\/health\/alerts\/([^/]+)\/acknowledge$/);
  if (acknowledgePath && (method === 'POST' || method === 'DELETE')) {
    const alertId = decodeURIComponent(acknowledgePath[1] as string);
    if (!testState.queueHealthSummary.alerts.some((alert) => alert.id === alertId))
      return reply(404, { error: 'That alert is not in the current summary.' });
    return setQueueHealthAcknowledged(alertId, method === 'POST');
  }
  if (url.endsWith('/api/signal/campaigns') && method === 'GET')
    return testState.signalCampaignsPayload;
  if (url.endsWith('/api/signal/campaigns') && method === 'POST') {
    const name = normalizeSignalCampaignName(String(body.name ?? ''));
    const existing = testState.signalCampaignsPayload.find((campaign) =>
      sameSignalCampaignName(campaign.name, name),
    );
    // The route reuses an existing name rather than refusing it, and answers 200 rather than 201
    // when it does — which is the difference the Settings card's message is written from.
    if (existing) return existing;
    const created: SignalCampaignSummary = {
      id: `campaign-${testState.signalCampaignsPayload.length + 1}`,
      name,
      postCount: 0,
    };
    testState.signalCampaignsPayload = [...testState.signalCampaignsPayload, created];
    return reply(201, created);
  }
  const campaignPath = url.match(/\/api\/signal\/campaigns\/([^/?]+)(?:\?|$)/);
  if (campaignPath && method === 'PATCH') {
    const target = testState.signalCampaignsPayload.find(
      (campaign) => campaign.id === campaignPath[1],
    );
    if (!target) return reply(404, { error: 'Signal campaign not found.' });
    const name = normalizeSignalCampaignName(String(body.name ?? target.name));
    const clash = testState.signalCampaignsPayload.find(
      (campaign) => campaign.id !== target.id && sameSignalCampaignName(campaign.name, name),
    );
    // The clashing campaign's own spelling, as the route reports it: a reader looking for what is
    // in the way needs the name it is listed under, not the one they just typed.
    if (clash)
      return reply(409, {
        error: `Another campaign is already called “${clash.name}”.`,
        code: 'SIGNAL_CAMPAIGN_NAME_TAKEN',
      });
    const renamed = { ...target, name };
    testState.signalCampaignsPayload = testState.signalCampaignsPayload.map((campaign) =>
      campaign.id === target.id ? renamed : campaign,
    );
    return renamed;
  }
  if (campaignPath && method === 'DELETE') {
    const target = testState.signalCampaignsPayload.find(
      (campaign) => campaign.id === campaignPath[1],
    );
    if (!target) return reply(404, { error: 'Signal campaign not found.' });
    const confirmed = new URLSearchParams(url.split('?')[1] ?? '').get('confirm') === 'true';
    if (target.postCount > 0 && !confirmed)
      return reply(409, {
        error: 'This campaign is attached to posts. Confirm deletion to detach it everywhere.',
        code: 'SIGNAL_CAMPAIGN_IN_USE',
        attachedPostCount: target.postCount,
      });
    testState.signalCampaignsPayload = testState.signalCampaignsPayload.filter(
      (campaign) => campaign.id !== target.id,
    );
    return {
      ok: true,
      deleted: 'signalCampaign',
      name: target.name,
      detachedFromPosts: target.postCount,
    };
  }
  if (url.includes('/api/signal/analytics/campaigns') && method === 'GET') {
    testState.signalCampaignAnalyticsRequests.push(url.split('?')[1] ?? '');
    if (testState.signalCampaignAnalyticsError)
      return reply(400, { error: testState.signalCampaignAnalyticsError });
    return testState.signalCampaignAnalyticsPayload ?? emptyCampaignAnalytics();
  }
  if (url.includes('/api/signal/posts?') && method === 'GET') {
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const from = query.get('from') ?? '';
    const to = query.get('to') ?? '';
    return {
      from,
      to,
      posts: testState.signalPostsPayload.filter(
        (post) => post.date !== null && post.date >= from && post.date <= to,
      ),
      truncated: testState.signalPostsTruncated,
    };
  }
  if (url.endsWith('/api/signal/queue') && method === 'GET')
    return testState.signalPostsPayload.filter((post) => post.date === null);
  if (url.endsWith('/api/signal/posts') && method === 'POST') {
    if (testState.signalMutationError) return reply(400, { error: testState.signalMutationError });
    const created = signalPost('created-signal-post', body.text, body.date ?? null, {
      status: body.status ?? 'DRAFT',
      channels: body.channels ?? [],
      mediaUrls: body.mediaUrls ?? [],
      time: body.time ?? SIGNAL_DEFAULT_TIME,
      format: body.format ?? 'TEXT',
      campaigns: resolveMockCampaigns(body.campaigns),
      cta: body.cta ?? 'NONE',
      position: testState.signalPostsPayload.filter((post) => post.date === null).length,
    });
    testState.signalPostsPayload = [...testState.signalPostsPayload, created];
    return created;
  }
  const variantsPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/variants$/);
  if (variantsPath && method === 'GET') return testState.signalVariantsPayload;
  if (variantsPath && method === 'PUT') {
    if (testState.signalVariantsError) return reply(400, { error: testState.signalVariantsError });
    testState.signalVariantsPayload = (body.variants ?? []) as PublishVariantRecord[];
    return testState.signalVariantsPayload;
  }
  const duplicatePath = url.match(/\/api\/signal\/posts\/([^/?]+)\/duplicate$/);
  if (duplicatePath && method === 'POST') {
    const source = testState.signalPostsPayload.find((post) => post.id === duplicatePath[1]);
    if (!source) return reply(404, { error: 'Signal post not found.' });
    const copy = signalPost(`copy-${source.id}`, source.text, null, {
      channels: [...source.channels],
      mediaUrls: [...source.mediaUrls],
      time: source.time,
      format: source.format,
      status: 'DRAFT',
      campaigns: source.campaigns,
      cta: source.cta,
      position: testState.signalPostsPayload.filter((post) => post.date === null).length,
    });
    testState.signalPostsPayload = [...testState.signalPostsPayload, copy];
    return copy;
  }
  const nextSlotPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/next-slot(?:\?|$)/);
  if (nextSlotPath && method === 'GET') {
    const post = testState.signalPostsPayload.find((candidate) => candidate.id === nextSlotPath[1]);
    if (!post) return reply(404, { error: 'Signal post not found.' });
    const from = new URLSearchParams(url.split('?')[1] ?? '').get('from') ?? '';
    const occupied = testState.signalPostsPayload
      .filter((candidate) => candidate.id !== post.id && candidate.date !== null)
      .map((candidate) => ({ date: candidate.date as string, time: candidate.time }));
    const suggestion = suggestNextOpenSignalSlot({
      occupied,
      time: post.time,
      fromDate: from,
      skip: post.date ? { date: post.date, time: post.time } : null,
    });
    return suggestion
      ? suggestion
      : reply(409, {
          error: 'No open slot was found in the next two years.',
          code: 'NO_OPEN_SLOT',
          suggestion: null,
        });
  }
  const applySlotPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/slot$/);
  if (applySlotPath && method === 'POST') {
    const post = testState.signalPostsPayload.find(
      (candidate) => candidate.id === applySlotPath[1],
    );
    if (!post) return reply(404, { error: 'Signal post not found.' });
    const occupied = testState.signalPostsPayload
      .filter((candidate) => candidate.id !== post.id && candidate.date !== null)
      .map((candidate) => ({ date: candidate.date as string, time: candidate.time }));
    const confirmed = { date: body.date as string, time: body.time as string };
    if (occupied.some((slot) => slot.date === confirmed.date && slot.time === confirmed.time)) {
      return reply(409, {
        error: 'That slot is no longer open.',
        code: 'SLOT_TAKEN',
        suggestion: suggestNextOpenSignalSlot({
          occupied,
          time: post.time,
          fromDate: body.from,
          skip: post.date ? { date: post.date, time: post.time } : null,
        }),
      });
    }
    testState.signalPostsPayload = testState.signalPostsPayload.map((candidate) =>
      candidate.id === post.id
        ? { ...candidate, date: confirmed.date, time: confirmed.time }
        : candidate,
    );
    return testState.signalPostsPayload.find((candidate) => candidate.id === post.id) ?? {};
  }
  const publishPreviewPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/publish\/preview$/);
  if (publishPreviewPath && method === 'POST')
    return (
      testState.publishPreviewPayload ?? reply(400, { error: 'No publish preview was set up.' })
    );
  const publishPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/publish$/);
  if (publishPath && method === 'POST') {
    const created = testState.publishSubmitPayload;
    return created ?? reply(400, { error: 'No publication was set up.' });
  }
  const publicationsPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/publications$/);
  if (publicationsPath && method === 'GET') return testState.publicationsPayload;
  const reconcilePath = url.match(/\/api\/signal\/publications\/([^/?]+)\/reconcile$/);
  if (reconcilePath && method === 'POST')
    return (
      testState.publishReconcilePayload ?? reply(400, { error: 'No reconciliation was set up.' })
    );
  const providerPreviewPath = url.match(
    /\/api\/signal\/publications\/([^/?]+)\/provider\/preview$/,
  );
  if (providerPreviewPath && method === 'POST')
    return testState.providerReconcilePayload ?? reply(400, { error: 'No comparison was set up.' });
  const providerApplyPath = url.match(/\/api\/signal\/publications\/([^/?]+)\/provider\/apply$/);
  if (providerApplyPath && method === 'POST') {
    if (testState.providerApplyError) return reply(409, { error: testState.providerApplyError });
    // The request body is kept so a case can prove which action, and which token, went out.
    testState.providerApplyRequests.push(body as { action: string; reconcileHash: string });
    return testState.providerApplyPayload ?? reply(400, { error: 'No result was set up.' });
  }
  const metricsRefreshPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/metrics\/refresh$/);
  if (metricsRefreshPath && method === 'POST') {
    if (testState.postMetricsRefreshError)
      return reply(500, { error: testState.postMetricsRefreshError });
    // A refresh answers with the refreshed summary where a case set one, and otherwise with whatever
    // is stored — the same thing the route does when the provider had nothing new to say.
    return (
      testState.postMetricsRefreshPayload ??
      testState.postMetricsPayload ??
      emptyMetrics(metricsRefreshPath[1] as string)
    );
  }
  const metricsPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/metrics$/);
  if (metricsPath && method === 'GET')
    return testState.postMetricsPayload ?? emptyMetrics(metricsPath[1] as string);
  const finishPath = url.match(/\/api\/signal\/publications\/([^/?]+)\/targets\/(\d+)\/finish$/);
  if (finishPath && method === 'POST')
    return testState.publishFinishPayload ?? reply(409, { error: 'Nothing to finish here.' });
  const signalPostPath = url.match(/\/api\/signal\/posts\/([^/?]+)$/);
  // One post by id, which is how the planner opens the post an address names.
  if (signalPostPath && method === 'GET')
    return (
      testState.signalPostsPayload.find((post) => post.id === signalPostPath[1]) ??
      reply(404, { error: 'Signal post not found.' })
    );
  if (signalPostPath && method === 'PATCH') {
    if (testState.signalMutationError) return reply(400, { error: testState.signalMutationError });
    testState.signalPostsPayload = testState.signalPostsPayload.map((post) =>
      post.id === signalPostPath[1]
        ? {
            ...post,
            ...body,
            // The route takes campaign **names** and answers with the resolved records, creating the
            // ones that are new — which is what the editor's chip input depends on.
            ...(body.campaigns === undefined
              ? {}
              : { campaigns: resolveMockCampaigns(body.campaigns) }),
          }
        : post,
    );
    return testState.signalPostsPayload.find((post) => post.id === signalPostPath[1]) ?? {};
  }
  if (signalPostPath && method === 'DELETE') {
    if (testState.signalMutationError) return reply(400, { error: testState.signalMutationError });
    testState.signalPostsPayload = testState.signalPostsPayload.filter(
      (post) => post.id !== signalPostPath[1],
    );
    return { ok: true };
  }
  if (url.includes('/api/integrations/activity'))
    return testState.integrationActivityError
      ? reply(503, { error: testState.integrationActivityError })
      : testState.integrationActivityPayload;
  // The import routes answer with whatever the case set up: the dry run is a plain 200 even
  // when the playbook is unimportable, and a refused commit is a 409 carrying the reasons.
  if (url.endsWith('/api/import/playbook/preview') && method === 'POST')
    return testState.importPreviewPayload ?? reply(400, { error: 'No preview was set up.' });
  if (url.endsWith('/api/import/playbook') && method === 'POST') {
    const answer = testState.importCommitPayload;
    if (!answer) return reply(400, { error: 'No commit was set up.' });
    const written = (answer.body as { receipt?: ImportReceipt }).receipt;
    if (written) {
      testState.importReceiptsPayload = [written, ...testState.importReceiptsPayload];
      // The server writes the receipt and its activity row together, so the stub does too:
      // reloading the page after a commit finds both, correlated.
      testState.integrationActivityPayload = [
        activityEvent({
          id: `event-${written.id}`,
          correlationId: written.id,
          outcome: written.outcome === 'COMMITTED' ? 'SUCCESS' : 'FAILURE',
          summary:
            written.outcome === 'COMMITTED'
              ? `Imported ${written.createdCount} records from a pasted playbook, skipping ${written.skippedCount} already here.`
              : 'Refused a pasted playbook: nothing was written.',
          entityCount: written.createdCount,
          entities: written.created.map((created) => ({
            type: 'client',
            id: `${created.key}-id`,
            label: created.label,
          })),
        }),
        ...testState.integrationActivityPayload,
      ];
    }
    return reply(answer.status, answer.body);
  }
  const files = url.match(/\/api\/projects\/([^/?]+)\/files(?:\?(.*))?$/);
  if (files && method === 'GET') {
    const query = new URLSearchParams(files[2] ?? '');
    return (
      testState.driveListingPayload?.(files[1], query) ??
      driveListing({ state: 'NOT_CONNECTED', projectId: files[1] })
    );
  }
  if (url.endsWith('/api/tasks/reorder')) {
    if (testState.taskReorderError) return reply(409, { error: testState.taskReorderError });
    // The endpoint writes positions within the one status it was handed, which is what makes a
    // reorder survive the `refresh()` that follows it.
    const order: string[] = body.orderedIds;
    testState.tasksPayload = testState.tasksPayload.map((current) =>
      order.includes(current.id)
        ? { ...current, status: body.status, position: order.indexOf(current.id) }
        : current,
    );
    return testState.tasksPayload.find((current) => current.id === body.taskId) ?? {};
  }
  if (url.endsWith('/api/projects/reorder')) {
    const order: string[] = body.orderedIds;
    testState.projectsPayload = [...testState.projectsPayload]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((p, position) => ({ ...p, position }));
    return testState.projectsPayload;
  }
  const mergePreview = url.match(/\/api\/clients\/([^/]+)\/merge\/preview$/);
  if (mergePreview && method === 'POST') {
    if (testState.clientMergePreviewError)
      return reply(testState.clientMergePreviewError.status, {
        error: testState.clientMergePreviewError.error,
      });
    const plan = clientMergePlan(mergePreview[1], body.destinationId, body.fields);
    return plan ?? reply(404, { error: 'Client not found.' });
  }
  const mergeCommit = url.match(/\/api\/clients\/([^/]+)\/merge$/);
  if (mergeCommit && method === 'POST') {
    if (testState.clientMergeCommitError)
      return reply(testState.clientMergeCommitError.status, {
        error: testState.clientMergeCommitError.error,
      });
    const sourceId = mergeCommit[1];
    const plan = clientMergePlan(sourceId, body.destinationId, body.fields);
    if (!plan) return reply(404, { error: 'Client not found.' });
    const mergedAt = '2026-08-16T12:00:00.000Z';
    // The chosen values, which the survivor takes along with the work, under whichever name.
    const chosen = Object.fromEntries(plan.fields.map((field) => [field.field, field.value]));
    const survivor = { ...plan.destination, name: chosen.name ?? plan.destination.name };
    // The same writes the server makes, so the `refresh()` that follows serves a workspace
    // where the projects moved, the source is archived, and the alias is reported.
    testState.projectsPayload = testState.projectsPayload.map((p) =>
      p.clientId === sourceId ? { ...p, clientId: survivor.id, clientName: survivor.name } : p,
    );
    testState.clientsPayload = testState.clientsPayload.map((candidate) => {
      if (candidate.id === sourceId)
        return {
          ...candidate,
          status: 'ARCHIVED' as const,
          mergedInto: { id: survivor.id, name: survivor.name, mergedAt },
        };
      if (candidate.id !== survivor.id) return candidate;
      return {
        ...candidate,
        name: survivor.name,
        slug: plan.slug.next,
        contactName: chosen.contactName ?? undefined,
        email: chosen.email ?? undefined,
        phone: chosen.phone ?? undefined,
        website: chosen.website ?? undefined,
        notes: chosen.notes ?? undefined,
      };
    });
    testState.clientImportAliases = testState.clientImportAliases.map((alias) =>
      alias.clientId === sourceId ? { ...alias, clientId: plan.destination.id } : alias,
    );
    return {
      source: { ...plan.source, status: 'ARCHIVED' },
      destination: survivor,
      projects: plan.projects,
      aliases: plan.aliases,
      fields: plan.fields,
      movedProjectCount: plan.projects.length,
      mergedAt,
    };
  }
  const clientStatus = url.match(/\/api\/clients\/([^/]+)\/(archive|unarchive)$/);
  if (clientStatus && method === 'POST') {
    testState.clientsPayload = testState.clientsPayload.map((current) =>
      current.id === clientStatus[1]
        ? { ...current, status: clientStatus[2] === 'archive' ? 'ARCHIVED' : 'ACTIVE' }
        : current,
    );
    return { ok: true };
  }
  if (url.endsWith('/api/tasks') && method === 'POST') return task('created-task', body.title);
  // Both project writes answer with the saved project, because the form reads its id back to
  // attach categories to it — a new project has no id until this reply arrives.
  if (url.endsWith('/api/projects') && method === 'POST') {
    const created = project('created-project', body.name, body.status || 'ACTIVE', {
      clientId: body.clientId,
    });
    testState.projectsPayload = [...testState.projectsPayload, created];
    return created;
  }
  if (method === 'PATCH' && /\/api\/projects\/[^/]+$/.test(url)) {
    const id = url.split('/api/projects/')[1];
    testState.projectsPayload = testState.projectsPayload.map((current) =>
      current.id === id ? { ...current, ...body } : current,
    );
    return testState.projectsPayload.find((current) => current.id === id) ?? {};
  }
  if (method === 'PATCH' && /\/api\/tasks\/[^/]+$/.test(url)) {
    if (testState.taskPatchError) return reply(500, { error: testState.taskPatchError });
    const id = url.split('/api/tasks/')[1];
    testState.tasksPayload = testState.tasksPayload.map((current) => {
      if (current.id !== id) return current;
      const next = { ...current, ...body };
      for (const field of ['description', 'dueDate', 'startDate', 'notes', 'taskType'] as const) {
        if (body?.[field] === '') delete next[field];
      }
      return next;
    });
    return testState.tasksPayload.find((current) => current.id === id) ?? {};
  }
  if (url.endsWith('/api/tags') && method === 'POST') {
    const existing = testState.tagsPayload.find((tag) => sameTagName(tag.name, body.name));
    if (existing) return existing;
    const created: Tag = { id: `tag-${testState.tagsPayload.length + 1}`, name: body.name };
    testState.tagsPayload = [...testState.tagsPayload, created];
    return created;
  }
  if (method === 'DELETE' && /\/api\/tags\/[^/]+/.test(url)) {
    const id = url.split('/api/tags/')[1].split('?')[0];
    const attached = testState.tasksPayload.filter((t) =>
      t.tags.some((tag) => tag.id === id),
    ).length;
    if (attached && !url.includes('confirm=true'))
      return reply(409, {
        error: 'This tag is attached to tasks.',
        code: 'TAG_IN_USE',
        attachedTaskCount: attached,
      });
    testState.tagsPayload = testState.tagsPayload.filter((tag) => tag.id !== id);
    testState.tasksPayload = testState.tasksPayload.map((t) => ({
      ...t,
      tags: t.tags.filter((tag) => tag.id !== id),
    }));
    return { ok: true, detachedFromTasks: attached };
  }
  if (url.endsWith('/api/categories') && method === 'POST') {
    const existing = testState.categoriesPayload.find((c) => sameTagName(c.name, body.name));
    if (existing) return existing;
    const created: Category = {
      id: `category-${testState.categoriesPayload.length + 1}`,
      name: body.name,
    };
    testState.categoriesPayload = [...testState.categoriesPayload, created];
    return created;
  }
  const categoryPatch = url.match(/\/api\/categories\/([^/?]+)$/);
  if (categoryPatch && method === 'PATCH') {
    const id = categoryPatch[1];
    if (testState.categoriesPayload.some((c) => c.id !== id && sameTagName(c.name, body.name)))
      return reply(409, {
        error: `Another category is already called “${body.name}”.`,
        code: 'CATEGORY_NAME_TAKEN',
      });
    const renamed = { ...testState.categoriesPayload.find((c) => c.id === id)!, name: body.name };
    testState.categoriesPayload = testState.categoriesPayload.map((c) =>
      c.id === id ? renamed : c,
    );
    // One rename, every project: the join is what makes this a single write server-side.
    testState.projectsPayload = testState.projectsPayload.map((p) => ({
      ...p,
      categories: p.categories.map((c) => (c.id === id ? renamed : c)),
    }));
    return renamed;
  }
  if (method === 'DELETE' && /\/api\/categories\/[^/]+/.test(url)) {
    const id = url.split('/api/categories/')[1].split('?')[0];
    const attached = testState.projectsPayload.filter((p) =>
      p.categories.some((c) => c.id === id),
    ).length;
    if (attached && !url.includes('confirm=true'))
      return reply(409, {
        error: 'This category is attached to projects.',
        code: 'CATEGORY_IN_USE',
        attachedProjectCount: attached,
      });
    testState.categoriesPayload = testState.categoriesPayload.filter((c) => c.id !== id);
    testState.projectsPayload = testState.projectsPayload.map((p) => ({
      ...p,
      categories: p.categories.filter((c) => c.id !== id),
    }));
    return { ok: true, detachedFromProjects: attached };
  }
  const attachCategory = url.match(/\/api\/projects\/([^/]+)\/categories$/);
  if (attachCategory && method === 'POST') {
    const category = testState.categoriesPayload.find((c) => c.id === body.categoryId);
    testState.projectsPayload = testState.projectsPayload.map((p) =>
      p.id !== attachCategory[1] || !category || p.categories.some((c) => c.id === category.id)
        ? p
        : { ...p, categories: [...p.categories, category] },
    );
    return testState.projectsPayload.find((p) => p.id === attachCategory[1]) ?? {};
  }
  const detachCategory = url.match(/\/api\/projects\/([^/]+)\/categories\/([^/]+)$/);
  if (detachCategory && method === 'DELETE') {
    testState.projectsPayload = testState.projectsPayload.map((p) =>
      p.id === detachCategory[1]
        ? { ...p, categories: p.categories.filter((c) => c.id !== detachCategory[2]) }
        : p,
    );
    return testState.projectsPayload.find((p) => p.id === detachCategory[1]) ?? {};
  }
  return payloadFor(url);
};

/** The topbar action is rendered before any page-level "New task" button. */
export const clickTopbarNewTask = () =>
  fireEvent.click(screen.getAllByRole('button', { name: /new task/i })[0]);

export const projectSelect = () => screen.getByLabelText('Project') as HTMLSelectElement;

const LAST_PROJECT_KEY = 'hcc-last-project';

/** Visiting a project records it in an effect, so wait for that before opening the form. */
export const remembered = (id: string) =>
  waitFor(() => expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe(id));

/** A due date `offset` days from today, so no fixture expires. */
export const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');

/** A dry run in the shape the server answers with, varied per case. */
export const preview = (overrides: Partial<PlaybookPreview> = {}): PlaybookPreview => ({
  schemaVersion: 1,
  ok: true,
  creates: { ...emptyCounts(), Clients: 1, Projects: 1, Tasks: 2 },
  skips: emptyCounts(),
  failures: emptyCounts(),
  created: [
    { sheet: 'Clients', row: 2, key: 'CLI-A', label: 'Acme Studio' },
    { sheet: 'Projects', row: 2, key: 'PRJ-A', label: 'Spring Campaign' },
    { sheet: 'Tasks', row: 2, key: 'TSK-1', label: 'Week 1 blog post' },
    { sheet: 'Tasks', row: 3, key: 'TSK-2', label: 'Week 1 social set' },
  ],
  skipped: [],
  issues: [],
  duplicateRule: DUPLICATE_RULE,
  fingerprint: 'a'.repeat(64),
  ...overrides,
});

/** One Drive item in the shape the files endpoint answers with, varied per case. */
export const driveFile = (
  id: string,
  name: string,
  overrides: Partial<DriveFile> = {},
): DriveFile => ({
  id,
  name,
  mimeType: 'application/pdf',
  url: `https://drive.test/file/${id}`,
  modifiedAt: '2026-03-01T12:00:00.000Z',
  size: 4096,
  ...overrides,
});

/** A folder row, which is the one kind of row that can be opened inside the app. */
export const driveFolder = (id: string, name: string): DriveFile =>
  driveFile(id, name, { mimeType: DRIVE_FOLDER_MIME, size: null });

/** A listing in the shape the files endpoint answers with, varied per case. */
export const driveListing = (overrides: Partial<DriveListing> = {}): DriveListing => ({
  state: 'READY',
  projectId: 'p1',
  projectName: 'Site refresh',
  folder: { id: 'folder-p1', name: 'Project folder', url: 'https://drive.test/folder-p1' },
  scopes: [
    { id: 'folder-p1', name: 'Project folder', url: 'https://drive.test/folder-p1' },
    { id: 'folder-p1-admin', name: '01_Admin', url: 'https://drive.test/folder-p1-admin' },
  ],
  files: [],
  nextPageToken: null,
  error: null,
  ...overrides,
});

/** One activity-log row in the shape the server answers with, varied per case. */
export const activityEvent = (overrides: Partial<IntegrationEvent> = {}): IntegrationEvent => ({
  id: 'event-1',
  source: 'campaign-playbook',
  operation: 'playbook.import',
  outcome: 'SUCCESS',
  summary: 'Imported 4 records from a pasted playbook, skipping 0 already here.',
  entities: [{ type: 'client', id: 'client-imported', label: 'Acme Studio' }],
  entityCount: 1,
  correlationId: 'receipt-1',
  createdAt: '2026-03-01T15:04:00.000Z',
  ...overrides,
});

/** A receipt in the shape the server answers with, varied per case. */
export const receipt = (overrides: Partial<ImportReceipt> = {}): ImportReceipt => ({
  id: 'receipt-1',
  source: 'campaign-playbook',
  inputKind: 'text',
  outcome: 'COMMITTED',
  createdCount: 4,
  skippedCount: 0,
  failedCount: 0,
  creates: { ...emptyCounts(), Clients: 1, Projects: 1, Tasks: 2 },
  skips: emptyCounts(),
  created: [{ sheet: 'Clients', row: 2, key: 'CLI-A', label: 'Acme Studio' }],
  skipped: [],
  issues: [],
  createdAt: '2026-03-01T15:04:00.000Z',
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  testState.projectsPayload = projects;
  testState.clientsPayload = [];
  testState.tasksPayload = [];
  testState.tagsPayload = [];
  testState.categoriesPayload = [];
  testState.dashboardPayload = emptyDashboard;
  testState.brandingPayload = null;
  testState.taskPatchError = null;
  testState.taskReorderError = null;
  testState.dashboardFailures = 0;
  testState.driveSettingsError = null;
  testState.importReceiptsPayload = [];
  testState.importPreviewPayload = null;
  testState.importCommitPayload = null;
  testState.integrationActivityPayload = [];
  testState.integrationActivityError = null;
  testState.driveListingPayload = null;
  testState.calendarPayload = null;
  testState.signalPostsPayload = [];
  testState.signalPostsTruncated = false;
  testState.signalMutationError = null;
  testState.publishPreviewPayload = null;
  testState.publicationsPayload = [];
  testState.publishSubmitPayload = null;
  testState.publishReconcilePayload = null;
  testState.publishFinishPayload = null;
  testState.providerReconcilePayload = null;
  testState.providerApplyPayload = null;
  testState.providerApplyError = null;
  testState.providerApplyRequests = [];
  testState.postMetricsPayload = null;
  testState.postMetricsRefreshPayload = null;
  testState.postMetricsRefreshError = null;
  testState.signalVariantsPayload = [];
  testState.signalVariantsError = null;
  testState.clientMergePreviewError = null;
  testState.clientMergeCommitError = null;
  testState.clientImportAliases = [];
  testState.queueHealthSummary = clearQueueHealth();
  testState.queueHealthError = null;
  testState.signalCampaignsPayload = [];
  testState.signalCampaignAnalyticsPayload = null;
  testState.signalCampaignAnalyticsError = null;
  testState.signalCampaignAnalyticsRequests = [];
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const result = respondTo(String(input), init);
      const { status, body } = isReply(result) ? result : reply(200, result);
      return Promise.resolve({
        ok: status < 400,
        status,
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
