/* eslint-disable react-refresh/only-export-components -- test helpers are intentionally shared across sliced suites */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, format } from 'date-fns';
import { App } from './App';
import { APP_VERSION, DEFAULT_BRANDING, type Branding } from '../../shared/branding';
import { CANONICAL_VIEW_DEFAULTS, type ViewDefaults } from '../../shared/view-defaults';
import {
  DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS,
  type AgentHubLiveTipsSettings,
} from '../../shared/agent-hub-tips';
import type { Category, Client, DashboardData, Project, Tag, Task } from '../../shared/types';
import { sameTagName } from '../../shared/types';
import {
  DUPLICATE_RULE,
  emptyCounts,
  type ImportReceipt,
  type PlaybookPreview,
} from '../../shared/playbook';
import {
  SIGNAL_IMPORT_DUPLICATE_RULE,
  emptySignalImportCounts,
  type SignalImportPreview,
  type SignalImportReceipt,
} from '../../shared/signal-import';
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
import { urlPostMedia, type SignalPostMedia } from '../../shared/signal-media';
import type { SignalCampaignAnalytics } from '../../shared/signal-campaign-analytics';
import type {
  ProviderReconcilePreview,
  PublishPreview,
  SignalPublication,
} from '../../shared/publish';
import type { CardDelivery, CardDeliverySnapshot } from '../../shared/card-delivery';
import type { PublishVariantRecord } from '../../shared/publish-variants';
import type { PostMetricsSummary } from '../../shared/publish-analytics';
import {
  DEFAULT_QUEUE_HEALTH_CONFIG,
  type QueueHealthAlert,
  type QueueHealthSummary,
} from '../../shared/queue-health';
import type {
  ProviderInventoryEntry,
  ProviderInventorySnapshot,
} from '../../shared/provider-inventory';
import type {
  AnalyticsWindowGroup,
  AnalyticsWindowSnapshot,
} from '../../shared/publish-analytics-window';
import { ANALYTICS_WINDOW_UNVERIFIED_DETAIL } from '../../shared/publish-analytics-window';

export {
  DEFAULT_BRANDING,
  CANONICAL_VIEW_DEFAULTS,
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
  emptySignalImportCounts,
};
export type { Branding, Category, Client, DashboardData, Project, Tag, Task };
export type { ViewDefaults };
export type { ImportReceipt, PlaybookPreview };
export type { DriveFile, DriveListing };
export type { IntegrationEvent };
export type { CalendarRange, SignalPost };

type DriveWriteQueueSummary = {
  pendingCount: number;
  pendingDecodedBytes: number;
  oldestPendingAt: string | null;
  oldestPendingAgeMs: number | null;
  expiredCount: number;
  providerUncertainCount: number;
  limits: {
    pendingCount: number;
    pendingDecodedBytes: number;
    pendingAgeMs: number;
    executionLeaseMs: number;
  };
};

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

/** Lets a suite serve view defaults of its own without rebuilding the whole fetch stub. */
export const setViewDefaults = (overrides: Partial<ViewDefaults> = {}) => {
  testState.viewDefaultsPayload = {
    clients: { ...CANONICAL_VIEW_DEFAULTS.clients, ...overrides.clients },
    projects: { ...CANONICAL_VIEW_DEFAULTS.projects, ...overrides.projects },
    calendar: { ...CANONICAL_VIEW_DEFAULTS.calendar, ...overrides.calendar },
    signal: { ...CANONICAL_VIEW_DEFAULTS.signal, ...overrides.signal },
  };
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
  revision: overrides.revision ?? 1,
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
  revision: overrides.revision ?? 1,
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
  revision: overrides.revision ?? 1,
});

export const testState = {
  projectsPayload: projects,
  clientsPayload: [] as Client[],
  tasksPayload: [] as Task[],
  tagsPayload: [] as Tag[],
  categoriesPayload: [] as Category[],
  dashboardPayload: emptyDashboard as DashboardData,
  brandingPayload: null as Branding | null,
  viewDefaultsPayload: null as ViewDefaults | null,
  liveTipsPayload: null as AgentHubLiveTipsSettings | null,
  commandAiAssistantPayload: null as {
    assistant: import('../../shared/command-ai-assistant').CommandAiAssistantSettings;
    key: import('../../shared/command-ai-assistant').AssistantKeyMetadata;
    ready: boolean;
  } | null,
  manualPayload: null as { version: string; available: boolean; url: string | null } | null,
  taskPatchError: null as string | null,
  taskReorderError: null as string | null,
  dashboardFailures: 0,
  driveSettingsError: null as string | null,
  driveSettingsPayload: null as {
    configured: boolean;
    pickerConfigured: boolean;
    connected: boolean;
    rootFolderId?: string;
    rootFolderUrl?: string;
    picker: {
      clientId: string;
      apiKey: string;
      appId: string;
      scope: string;
    } | null;
  } | null,
  /** Receipts the Import page lists, and what its two writes answer with. */
  importReceiptsPayload: [] as ImportReceipt[],
  importPreviewPayload: null as PlaybookPreview | null,
  importCommitPayload: null as { status: number; body: unknown } | null,
  signalImportPreviewPayload: null as SignalImportPreview | null,
  signalImportCommitPayload: null as { status: number; body: unknown } | null,
  /** The integration activity log the Import page reads, or an error in its place. */
  integrationActivityPayload: [] as IntegrationEvent[],
  integrationActivityError: null as string | null,
  /** Operator coordination inbox (C112). Unset list means empty; detail is answered per open. */
  agentHandoffsPayload: [] as import('../../shared/agent-coordination').AgentHandoff[],
  agentHandoffsError: null as string | null,
  agentHandoffDetailPayload: null as
    import('../../shared/agent-coordination').AgentHandoffDetail | null,
  agentHandoffDetailError: null as string | null,
  agentSchedulesPayload: [] as import('../../shared/agent-schedules').AgentSchedule[],
  agentSchedulesError: null as string | null,
  agentCostPayload: {
    available: true,
    snapshots: [],
  } as import('../../shared/agent-cost').AgentCostSummary,
  agentCostRefreshReason: null as string | null,
  mcpAgentRegistryPayload: {
    enabled: false,
    credentials: [],
  } as {
    enabled: boolean;
    credentials: import('../../shared/mcp-agent-registry').McpAgentCredentialSummary[];
  },
  driveWriteRequestsPayload: [] as {
    id: string;
    agentLabel: string;
    confirmation: string;
    status: string;
    createdAt: string;
    error: string | null;
  }[],
  driveWriteQueueSummary: {
    pendingCount: 0,
    pendingDecodedBytes: 0,
    oldestPendingAt: null,
    oldestPendingAgeMs: null,
    expiredCount: 0,
    providerUncertainCount: 0,
    limits: {
      pendingCount: 20,
      pendingDecodedBytes: 50 * 1024 * 1024,
      pendingAgeMs: 24 * 60 * 60 * 1000,
      executionLeaseMs: 60 * 60 * 1000,
    },
  } as DriveWriteQueueSummary,
  publishConfirmationRequestsPayload: [] as {
    id: string;
    agentLabel: string;
    confirmation: string;
    status: string;
    createdAt: string;
    error: string | null;
  }[],
  publishConfirmationQueueSummary: {
    pendingCount: 0,
    oldestPendingAt: null as string | null,
    oldestPendingAgeMs: null as number | null,
    expiredCount: 0,
    providerUncertainCount: 0,
    limits: { pendingCount: 20, pendingAgeMs: 24 * 60 * 60 * 1000 },
  },
  mcpHealthPanelPayload: {
    enabled: true,
    state: 'never_connected',
    stateReason: null,
    generatedAt: '2026-08-28T12:00:00.000Z',
    agents: [],
    errorSummary: [],
    staleHandoffs: [],
    recentCompletions: [],
    auditEventCount: 0,
  } as import('../../shared/mcp-health').McpHealthPanel,
  mcpHealthTestPayload: {
    ok: true,
    status: {
      ok: true,
      transport: 'operator',
      authenticated: true,
      protocolVersion: '2024-11-05',
      agentLabel: null,
      grantedScopes: ['coordination:read', 'coordination:write'],
      storeId: 'store-fixture-app-test-setup',
      baseUrl: 'https://hcc.example.com',
      serverVersion: APP_VERSION,
      capabilityVersion: 'mcp-test',
      serverClock: '2026-08-28T12:00:00.000Z',
      checks: {
        toolsList: { ok: true, toolCount: 17 },
        resourcesList: { ok: true, resourceCount: 2 },
        resourceRead: { ok: true, uri: 'hcc://workspace/context', byteLength: 100 },
      },
      testedAt: '2026-08-28T12:00:00.000Z',
    },
    workspaceChecksumUnchanged: true,
    lastUsedAt: '2026-08-28T12:00:00.000Z',
    credential: null as import('../../shared/mcp-health').McpHealthDiagnosticCredential | null,
  },
  mcpCredentialVerificationPayload: {
    credentialId: 'credential-issued',
    agentLabel: 'cursor-planning',
    storeId: 'store-fixture-verification',
    status: 'pending',
    verifiedAt: null,
  } as import('../../shared/mcp-health').McpCredentialVerification,
  /**
   * What `GET /api/projects/:id/files` answers, per request, so a suite can vary the page
   * by folder and by cursor the way real Drive does. Unset means a Drive nobody connected.
   */
  driveListingPayload: null as ((projectId: string, query: URLSearchParams) => unknown) | null,
  driveWritePreviewPayload: null as unknown,
  driveWriteCommitPayload: null as unknown,
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
  /**
   * Planner-card delivery answers. Unset means every post in the planner payload is "not
   * submitted", which is what suites that are not about card delivery should see.
   */
  cardDeliveryPayload: null as CardDelivery[] | null,
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
   * What resolving a Drive link answers with, and what a recheck answers with afterwards.
   *
   * Two values rather than one, because the whole point of a recheck is that the file may have
   * moved: a case sets the first to say what a paste finds and the second to say what checking it
   * again finds. Either error stands in for a refusal the server made — a folder link, a type the
   * publisher will not take, a file Drive no longer returns — and the composer has to keep the
   * reference visible when the second one fires.
   */
  driveMediaPayload: null as SignalPostMedia | null,
  driveMediaError: null as string | null,
  driveRecheckPayload: null as SignalPostMedia | null,
  driveRecheckError: null as string | null,
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
  /**
   * The provider inventory the planner reads beside the grid.
   *
   * Unset answers an inventory nobody has refreshed yet, which is what every suite that is not about
   * the inventory should see: a panel that says so and has contacted nothing.
   */
  providerInventoryPayload: null as ProviderInventorySnapshot | null,
  /** What a refresh answers, where a case wants it to differ from what was already on screen. */
  providerInventoryRefreshPayload: null as ProviderInventorySnapshot | null,
  providerInventoryError: null as string | null,
  /** Every inventory request, so a case can prove a page load contacted the provider or did not. */
  providerInventoryRequests: [] as string[],
  /**
   * The provider window the planner reads beside the inventory.
   *
   * Unset answers a window nobody has read yet, with no window offered — which is what a build a
   * person uses actually shows, and therefore what every suite that is not about this panel should
   * see.
   */
  analyticsWindowPayload: null as AnalyticsWindowSnapshot | null,
  /** What a refresh answers, where a case wants it to differ from what was already on screen. */
  analyticsWindowRefreshPayload: null as AnalyticsWindowSnapshot | null,
  analyticsWindowError: null as string | null,
  /** Every window request, so a case can prove a selection change spent nothing. */
  analyticsWindowRequests: [] as string[],
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

/** An inventory nobody has read yet: available, empty, and stamped with no refresh. */
export function emptyProviderInventory(): ProviderInventorySnapshot {
  return { available: true, entries: [], counts: { posts: 0, orphans: 0 } };
}

/**
 * A window nobody has read, with no window offered.
 *
 * The honest default: `ANALYTICS_WINDOW_EVIDENCE` verifies nothing, so the real panel offers no
 * window and explains why. A fixture that offered one would be testing a build nobody runs.
 */
export function emptyAnalyticsWindow(): AnalyticsWindowSnapshot {
  return {
    available: true,
    windows: [],
    platform: 'tiktok',
    window: 'all',
    verified: false,
    meaning: ANALYTICS_WINDOW_UNVERIFIED_DETAIL,
    groups: [],
    unmapped: [],
    counts: { rows: 0, mapped: 0, unmapped: 0 },
  };
}

/** One account's window row, with only the fields a case cares about spelled out. */
export const analyticsWindowGroup = (
  overrides: Partial<AnalyticsWindowGroup> = {},
): AnalyticsWindowGroup => ({
  platform: 'instagram',
  accountId: 901,
  channel: 'ig',
  handle: 'gholmesdesigns',
  deliveries: 1,
  measuredDeliveries: 1,
  totals: { views: 100, likes: 10, comments: 2, shares: 1 },
  ...overrides,
});

/** A window snapshot around a set of groups, with the counts its own rows imply. */
export const analyticsWindowSnapshot = (
  groups: AnalyticsWindowGroup[],
  overrides: Partial<AnalyticsWindowSnapshot> = {},
): AnalyticsWindowSnapshot => {
  const unmapped = overrides.unmapped ?? [];
  const mapped = groups.reduce((sum, group) => sum + group.measuredDeliveries, 0);
  return {
    available: true,
    windows: [],
    platform: 'instagram',
    window: 'all',
    verified: false,
    meaning: ANALYTICS_WINDOW_UNVERIFIED_DETAIL,
    groups,
    unmapped,
    counts: { rows: mapped + unmapped.length, mapped, unmapped: unmapped.length },
    lastRefreshAt: '2026-09-14T12:00:00.000Z',
    ...overrides,
  };
};

/** One listed provider post, with only the fields a case cares about spelled out. */
export const providerInventoryEntry = (
  overrides: Partial<ProviderInventoryEntry> & Pick<ProviderInventoryEntry, 'providerPostId'>,
): ProviderInventoryEntry => ({
  state: 'SCHEDULED',
  scheduledInstant: '2026-09-16T13:00:00.000Z',
  captionExcerpt: 'Scheduled straight in Post Bridge',
  accountIds: [901],
  snapshotAt: '2026-09-14T12:00:00.000Z',
  orphan: true,
  accounts: [{ accountId: 901 }],
  ...overrides,
});

/** A snapshot around a set of entries, with the counts its own rows imply. */
export const providerInventorySnapshot = (
  entries: ProviderInventoryEntry[],
  overrides: Partial<ProviderInventorySnapshot> = {},
): ProviderInventorySnapshot => ({
  available: true,
  entries,
  counts: { posts: entries.length, orphans: entries.filter((entry) => entry.orphan).length },
  lastRefreshAt: '2026-09-14T12:00:00.000Z',
  ...overrides,
});

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

/**
 * Media as the write routes resolve it: a source and an address in, descriptors out.
 *
 * A Drive item the post already carries comes back exactly as it stands — the server does not
 * re-resolve one on an ordinary save, and neither does this — and a new one takes whatever the
 * case staged as `driveMediaPayload`. Both arrays come back, because the API answers with both.
 */
export function resolveMockMedia(
  post: SignalPost,
  items: unknown,
): Pick<SignalPost, 'media' | 'mediaUrls'> {
  const list = Array.isArray(items) ? items : [];
  const media = list.map((raw) => {
    const item = raw as { source?: string; url?: string };
    const url = String(item.url ?? '');
    if (item.source !== 'DRIVE') return urlPostMedia(url);
    return (
      post.media.find((stored) => stored.source === 'DRIVE' && stored.url === url) ??
      testState.driveMediaPayload ??
      urlPostMedia(url)
    );
  });
  return { media, mediaUrls: media.map((item) => item.url) };
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

/**
 * One scheduled post, with only the fields a case cares about spelled out.
 *
 * `media` and `mediaUrls` are the same references twice, exactly as the API answers with them, so a
 * case may state either one: giving `mediaUrls` is the shorthand for a list of public references,
 * and giving `media` is how a case states a Drive reference. Deriving the second from the first
 * here is what stops a fixture describing a post the server could never return.
 */
export const signalPost = (
  id: string,
  text: string,
  date: string | null,
  overrides: Partial<SignalPost> = {},
): SignalPost => {
  const media = overrides.media ?? (overrides.mediaUrls ?? []).map((url) => urlPostMedia(url));
  return {
    id,
    text,
    channels: [],
    date,
    time: SIGNAL_DEFAULT_TIME,
    format: 'TEXT',
    status: 'SCHEDULED',
    lifecycle: 'ACTIVE',
    retiredAt: null,
    deliveryProvenance: 'IN_SIGNAL',
    campaigns: [],
    cta: 'NONE',
    position: 0,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
    revision: overrides.revision ?? 1,
    media,
    mediaUrls: media.map((item) => item.url),
  };
};

/** A calendar range with both halves healthy unless a case says otherwise. */
export const calendarRange = (overrides: Partial<CalendarRange> = {}): CalendarRange => ({
  from: '2026-09-01',
  to: '2026-09-30',
  posts: [],
  tasks: [],
  signal: { available: true, error: null, truncated: false },
  ...overrides,
});

/** Serves the endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/import/receipts')) return testState.importReceiptsPayload;
  if (url.endsWith('/api/dashboard')) return testState.dashboardPayload;
  if (url.endsWith('/api/settings/branding'))
    return { branding: testState.brandingPayload ?? branding };
  if (url.endsWith('/api/settings/view-defaults'))
    return { viewDefaults: testState.viewDefaultsPayload ?? CANONICAL_VIEW_DEFAULTS };
  if (url.endsWith('/api/settings/agent-hub-live-tips'))
    return { liveTips: testState.liveTipsPayload ?? DEFAULT_AGENT_HUB_LIVE_TIPS_SETTINGS };
  if (url.endsWith('/api/settings/command-ai-assistant'))
    return (
      testState.commandAiAssistantPayload ?? {
        assistant: {
          enabled: false,
          provider: 'openai',
          model: 'gpt-4o-mini',
          dailyTurnCap: 100,
          dailyTokenCap: 300_000,
          scopes: ['workspace:read', 'workspace:write'],
        },
        key: { provider: 'openai', hasKey: false, keyLast4: null },
        ready: false,
      }
    );
  if (url.endsWith('/api/settings/manual'))
    return (
      testState.manualPayload ?? {
        version: APP_VERSION,
        available: true,
        url: `/api/manual/${encodeURIComponent(APP_VERSION)}`,
      }
    );
  if (url.endsWith('/api/settings/drive'))
    return (
      testState.driveSettingsPayload ?? {
        configured: false,
        pickerConfigured: false,
        connected: false,
        picker: null,
      }
    );
  if (url.endsWith('/api/auth/mcp-agents')) return testState.mcpAgentRegistryPayload;
  if (url.endsWith('/api/drive-write-requests'))
    return {
      requests: testState.driveWriteRequestsPayload,
      summary: testState.driveWriteQueueSummary,
    };
  if (url.endsWith('/api/signal/publish-confirmations'))
    return {
      requests: testState.publishConfirmationRequestsPayload,
      summary: testState.publishConfirmationQueueSummary,
    };
  if (url.endsWith('/api/mcp/health')) return testState.mcpHealthPanelPayload;
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
  if (url.endsWith('/api/mcp/health/test') && method === 'POST') {
    return testState.mcpHealthTestPayload;
  }
  if (url.includes('/api/mcp/health/verification/') && method === 'GET') {
    return testState.mcpCredentialVerificationPayload;
  }
  const rotateMcpCredential = url.match(/\/api\/auth\/mcp-credentials\/([^/?]+)\/rotate$/);
  if (rotateMcpCredential && method === 'POST') {
    const current = testState.mcpAgentRegistryPayload.credentials.find(
      (credential) => credential.id === rotateMcpCredential[1],
    );
    if (!current) return reply(404, { error: 'Active MCP credential not found.' });
    testState.mcpAgentRegistryPayload.credentials =
      testState.mcpAgentRegistryPayload.credentials.filter(
        (credential) => credential.id !== current.id,
      );
    const credential = {
      ...current,
      id: 'credential-rotated',
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: body.expiresAt,
    };
    testState.mcpAgentRegistryPayload.credentials.push(credential);
    return { ok: true, bearerToken: 'hcc_mcp_rotated-once', credential };
  }
  if (url.endsWith('/api/auth/mcp-agents') && method === 'POST') {
    const credential = {
      id: 'credential-issued',
      agentId: 'agent-issued',
      label: body.label,
      scopes: body.scopes,
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: body.expiresAt,
      lastUsedAt: null,
      lastOrigin: null,
      revokedAt: null,
    };
    testState.mcpAgentRegistryPayload.credentials = [
      ...testState.mcpAgentRegistryPayload.credentials,
      credential,
    ];
    return { ok: true, bearerToken: 'hcc_mcp_shown-once', credential };
  }
  if (url.endsWith('/api/auth/mcp-assistant') && method === 'POST') {
    const credential = {
      id: 'assistant-credential-issued',
      agentId: 'agent-command-ai',
      label: 'command-ai',
      scopes: body.scopes,
      issuedAt: '2026-08-28T12:00:00.000Z',
      expiresAt: body.expiresAt,
      lastUsedAt: null,
      lastOrigin: null,
      revokedAt: null,
    };
    testState.mcpAgentRegistryPayload.credentials = [
      ...testState.mcpAgentRegistryPayload.credentials,
      credential,
    ];
    return { ok: true, bearerToken: 'hcc_mcp_assistant-once', credential };
  }
  const driveWriteDecision = url.match(/\/api\/drive-write-requests\/([^/]+)\/(approve|deny)$/);
  if (driveWriteDecision && method === 'POST') {
    const request = testState.driveWriteRequestsPayload.find(
      (candidate) => candidate.id === driveWriteDecision[1],
    );
    if (!request) return reply(404, { error: 'Drive write request not found.' });
    request.status = driveWriteDecision[2] === 'approve' ? 'APPROVED' : 'DENIED';
    testState.driveWriteRequestsPayload = testState.driveWriteRequestsPayload.filter(
      (candidate) => candidate.id !== request.id,
    );
    return request;
  }
  const publishConfirmationDecision = url.match(
    /\/api\/signal\/publish-confirmations\/([^/]+)\/(approve|deny)$/,
  );
  if (publishConfirmationDecision && method === 'POST') {
    const request = testState.publishConfirmationRequestsPayload.find(
      (candidate) => candidate.id === publishConfirmationDecision[1],
    );
    if (!request) return reply(404, { error: 'Publish confirmation not found.' });
    request.status = publishConfirmationDecision[2] === 'approve' ? 'APPROVED' : 'DENIED';
    testState.publishConfirmationRequestsPayload =
      testState.publishConfirmationRequestsPayload.filter(
        (candidate) => candidate.id !== request.id,
      );
    return request;
  }
  const revokeMcpCredential = url.match(/\/api\/auth\/mcp-credentials\/([^/?]+)\/revoke$/);
  if (revokeMcpCredential && method === 'POST') {
    testState.mcpAgentRegistryPayload.credentials =
      testState.mcpAgentRegistryPayload.credentials.filter(
        (credential) => credential.id !== revokeMcpCredential[1],
      );
    return { ok: true };
  }
  if (url.endsWith('/api/settings/drive/root') && method === 'POST') {
    const current = testState.driveSettingsPayload ?? {
      configured: true,
      pickerConfigured: true,
      connected: true,
      picker: null,
    };
    testState.driveSettingsPayload = {
      ...current,
      rootFolderId: body.folderId,
      rootFolderUrl: `https://drive.test/folder/${body.folderId}`,
    };
    return {
      rootFolderId: body.folderId,
      rootFolderUrl: `https://drive.test/folder/${body.folderId}`,
    };
  }
  if (url.endsWith('/api/settings/drive/disconnect') && method === 'POST') {
    testState.driveSettingsPayload = {
      configured: true,
      pickerConfigured: Boolean(testState.driveSettingsPayload?.pickerConfigured),
      connected: false,
      picker: testState.driveSettingsPayload?.picker ?? null,
    };
    return {
      ok: true,
      googleRevocationRequired: true,
      googlePermissionsUrl: 'https://myaccount.google.com/permissions',
    };
  }
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
  if (url.includes('/api/signal/card-delivery?') && method === 'GET') {
    const query = new URL(url, 'http://localhost').searchParams;
    const from = query.get('from') ?? '';
    const to = query.get('to') ?? '';
    const deliveries =
      testState.cardDeliveryPayload ??
      testState.signalPostsPayload.map((post): CardDelivery => ({
        postId: post.id,
        state: 'NONE',
        label: 'Not submitted',
      }));
    return { from, to, deliveries } satisfies CardDeliverySnapshot;
  }
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
  /**
   * The provider inventory. A read answers stored rows and a refresh answers whatever the case set
   * up for it, so a suite can prove that mounting the panel is a read and only the button is a
   * refresh.
   */
  if (url.includes('/api/signal/analytics/window') && method === 'GET') {
    testState.analyticsWindowRequests.push('read');
    return testState.analyticsWindowError
      ? reply(503, { error: testState.analyticsWindowError })
      : (testState.analyticsWindowPayload ?? emptyAnalyticsWindow());
  }
  if (url.endsWith('/api/signal/analytics/window/refresh') && method === 'POST') {
    testState.analyticsWindowRequests.push('refresh');
    if (testState.analyticsWindowRefreshPayload)
      testState.analyticsWindowPayload = testState.analyticsWindowRefreshPayload;
    return testState.analyticsWindowPayload ?? emptyAnalyticsWindow();
  }
  if (url.endsWith('/api/signal/provider-inventory') && method === 'GET') {
    testState.providerInventoryRequests.push('read');
    return testState.providerInventoryError
      ? reply(503, { error: testState.providerInventoryError })
      : (testState.providerInventoryPayload ?? emptyProviderInventory());
  }
  if (url.endsWith('/api/signal/provider-inventory/refresh') && method === 'POST') {
    testState.providerInventoryRequests.push('refresh');
    if (testState.providerInventoryRefreshPayload)
      testState.providerInventoryPayload = testState.providerInventoryRefreshPayload;
    return testState.providerInventoryPayload ?? emptyProviderInventory();
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
    const lifecycle = query.get('lifecycle') ?? 'active';
    return {
      from,
      to,
      posts: testState.signalPostsPayload.filter((post) => {
        if (post.date === null || post.date < from || post.date > to) return false;
        if (lifecycle === 'all') return true;
        if (lifecycle === 'retired') return post.lifecycle === 'RETIRED';
        return post.lifecycle === 'ACTIVE';
      }),
      truncated: testState.signalPostsTruncated,
    };
  }
  if (url.endsWith('/api/signal/drive-media/resolve') && method === 'POST') {
    if (testState.driveMediaError) return reply(400, { error: testState.driveMediaError });
    if (!testState.driveMediaPayload) return reply(400, { error: 'No Drive file was staged.' });
    return testState.driveMediaPayload;
  }
  const recheckPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/media\/recheck$/);
  if (recheckPath && method === 'POST') {
    if (testState.driveRecheckError) return reply(400, { error: testState.driveRecheckError });
    const next = testState.driveRecheckPayload ?? testState.driveMediaPayload;
    if (!next) return reply(400, { error: 'No Drive file was staged.' });
    testState.signalPostsPayload = testState.signalPostsPayload.map((post) => {
      if (post.id !== recheckPath[1]) return post;
      const media = post.media.map((item) =>
        item.source === 'DRIVE' && item.driveFileId === body.driveFileId ? next : item,
      );
      // The recheck writes through the ordinary edit, so the post moves — which is what makes an
      // open preview stale, and what the composer has to reload the draft from.
      return {
        ...post,
        media,
        mediaUrls: media.map((item) => item.url),
        updatedAt: '2026-08-20T10:00:00.000Z',
      };
    });
    return testState.signalPostsPayload.find((post) => post.id === recheckPath[1]) ?? {};
  }
  if (url.split('?')[0]!.endsWith('/api/signal/queue') && method === 'GET') {
    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const lifecycle = query.get('lifecycle') ?? 'active';
    return testState.signalPostsPayload.filter((post) => {
      if (post.date !== null) return false;
      if (lifecycle === 'all') return true;
      if (lifecycle === 'retired') return post.lifecycle === 'RETIRED';
      return post.lifecycle === 'ACTIVE';
    });
  }
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
  const variantRecheckPath = url.match(/\/api\/signal\/posts\/([^/?]+)\/variants\/media\/recheck$/);
  if (variantRecheckPath && method === 'POST') {
    if (testState.driveRecheckError) return reply(400, { error: testState.driveRecheckError });
    const next = testState.driveRecheckPayload ?? testState.driveMediaPayload;
    if (!next) return reply(400, { error: 'No Drive file was staged.' });
    // The role recheck answers with the whole layer set, the way the route does: it writes through
    // the ordinary variant replacement rather than a path of its own.
    testState.signalVariantsPayload = testState.signalVariantsPayload.map((layer) =>
      layer.platform === body.platform && (layer.accountId ?? null) === (body.accountId ?? null)
        ? { ...layer, [body.role === 'COVER_IMAGE' ? 'coverImage' : 'thumbnail']: next }
        : layer,
    );
    return testState.signalVariantsPayload;
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
            // The route takes a source and an address and answers with descriptors: a Drive item
            // the post already carries comes back untouched, and only a new one is resolved. The
            // stub does the same, so a case can prove an unrelated edit left a fingerprint alone.
            ...(body.media === undefined ? {} : resolveMockMedia(post, body.media)),
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
  const retirePath = url.match(/\/api\/signal\/posts\/([^/?]+)\/retire$/);
  if (retirePath && method === 'POST') {
    if (testState.signalMutationError) return reply(400, { error: testState.signalMutationError });
    const retiredAt = '2026-08-20T12:00:00.000Z';
    testState.signalPostsPayload = testState.signalPostsPayload.map((post) =>
      post.id === retirePath[1]
        ? { ...post, lifecycle: 'RETIRED' as const, retiredAt, updatedAt: retiredAt }
        : post,
    );
    return testState.signalPostsPayload.find((post) => post.id === retirePath[1]) ?? {};
  }
  if (url.includes('/api/integrations/activity'))
    return testState.integrationActivityError
      ? reply(503, { error: testState.integrationActivityError })
      : testState.integrationActivityPayload;
  if (url.endsWith('/api/agent-handoffs') && method === 'GET')
    return testState.agentHandoffsError
      ? reply(503, { error: testState.agentHandoffsError })
      : {
          handoffs: testState.agentHandoffsPayload,
          limit: 50,
          offset: 0,
          truncated: false,
        };
  if (url.endsWith('/api/agents/cost') && method === 'GET') return testState.agentCostPayload;
  if (url.endsWith('/api/agents/cost/refresh') && method === 'POST') {
    if (testState.agentCostRefreshReason) {
      testState.agentCostPayload = {
        ...testState.agentCostPayload,
        reason: testState.agentCostRefreshReason,
      };
    }
    return testState.agentCostPayload;
  }
  if (url.endsWith('/api/agent-schedules') && method === 'GET')
    return testState.agentSchedulesError
      ? reply(503, { error: testState.agentSchedulesError })
      : { schedules: testState.agentSchedulesPayload };
  const agentSchedulePause = url.match(/\/api\/agent-schedules\/([^/?]+)$/);
  if (agentSchedulePause && method === 'PATCH') {
    const target = testState.agentSchedulesPayload.find((row) => row.id === agentSchedulePause[1]);
    if (!target) return reply(404, { error: 'Schedule not found.' });
    const updated = { ...target, paused: Boolean(body?.paused) };
    testState.agentSchedulesPayload = testState.agentSchedulesPayload.map((row) =>
      row.id === updated.id ? updated : row,
    );
    return updated;
  }
  const agentScheduleRunNow = url.match(/\/api\/agent-schedules\/([^/?]+)\/run-now$/);
  if (agentScheduleRunNow && method === 'POST') {
    const target = testState.agentSchedulesPayload.find((row) => row.id === agentScheduleRunNow[1]);
    if (!target) return reply(404, { error: 'Schedule not found.' });
    const updated = {
      ...target,
      lastRunStatus: 'SUCCEEDED' as const,
      lastRunAt: '2026-09-11T12:00:00.000Z',
      lastHandoffId: 'scheduled-handoff',
      lastError: null,
    };
    testState.agentSchedulesPayload = testState.agentSchedulesPayload.map((row) =>
      row.id === updated.id ? updated : row,
    );
    return updated;
  }
  if (url.endsWith('/api/agent-schedules/run-due') && method === 'POST') {
    const due = testState.agentSchedulesPayload.filter((row) => !row.paused && row.nextRunAt);
    testState.agentSchedulesPayload = testState.agentSchedulesPayload.map((row) =>
      due.some((candidate) => candidate.id === row.id)
        ? { ...row, lastRunStatus: 'SUCCEEDED' as const, lastHandoffId: 'scheduled-handoff' }
        : row,
    );
    return { runs: due.map((row) => ({ scheduleId: row.id, status: 'SUCCEEDED' })) };
  }
  const agentHandoffCancel = url.match(/\/api\/agent-handoffs\/([^/?]+)\/cancel$/);
  if (agentHandoffCancel && method === 'POST') {
    const target = testState.agentHandoffsPayload.find((row) => row.id === agentHandoffCancel[1]);
    if (!target) return reply(404, { error: 'Handoff not found.' });
    const cancelled = {
      ...target,
      state: 'CANCELLED' as const,
      cancelledAt: new Date().toISOString(),
      cancelReason: String(body?.reason ?? ''),
      updatedAt: '2026-08-26T15:30:00.000Z',
    };
    testState.agentHandoffsPayload = testState.agentHandoffsPayload.map((row) =>
      row.id === cancelled.id ? cancelled : row,
    );
    testState.agentHandoffDetailPayload = { ...cancelled, notes: [] };
    return cancelled;
  }
  const agentHandoffDetail = url.match(/\/api\/agent-handoffs\/([^/?]+)$/);
  if (agentHandoffDetail && method === 'GET') {
    if (testState.agentHandoffDetailError)
      return reply(503, { error: testState.agentHandoffDetailError });
    if (testState.agentHandoffDetailPayload?.id === agentHandoffDetail[1])
      return testState.agentHandoffDetailPayload;
    const listed = testState.agentHandoffsPayload.find((row) => row.id === agentHandoffDetail[1]);
    return listed ? { ...listed, notes: [] } : reply(404, { error: 'Handoff not found.' });
  }
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
  if (url.endsWith('/api/import/signal/preview') && method === 'POST')
    return (
      testState.signalImportPreviewPayload ?? reply(400, { error: 'No Signal preview was set up.' })
    );
  if (url.endsWith('/api/import/signal') && method === 'POST') {
    const answer = testState.signalImportCommitPayload;
    if (!answer) return reply(400, { error: 'No Signal commit was set up.' });
    return reply(answer.status, answer.body);
  }
  const files = url.match(/\/api\/projects\/([^/?]+)\/files(?:\?(.*))?$/);
  const driveWritePreview = url.match(
    /\/api\/projects\/([^/?]+)\/drive-write\/(folder|upload)\/preview$/,
  );
  if (driveWritePreview && method === 'POST')
    return (
      testState.driveWritePreviewPayload ??
      reply(400, { error: 'No Drive write preview was set up.' })
    );
  const driveWriteCommit = url.match(/\/api\/projects\/([^/?]+)\/drive-write\/(folder|upload)$/);
  if (driveWriteCommit && method === 'POST')
    return (
      testState.driveWriteCommitPayload ??
      reply(400, { error: 'No Drive write commit was set up.' })
    );
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
  if (url.endsWith('/api/settings/view-defaults') && method === 'PUT') {
    testState.viewDefaultsPayload = body as ViewDefaults;
    return { viewDefaults: testState.viewDefaultsPayload };
  }
  if (url.endsWith('/api/settings/agent-hub-live-tips') && method === 'PUT') {
    testState.liveTipsPayload = body as AgentHubLiveTipsSettings;
    return { liveTips: testState.liveTipsPayload };
  }
  if (url.endsWith('/api/settings/command-ai-assistant/key') && method === 'PUT') {
    const input = body as { provider: 'openai' | 'anthropic'; key: string };
    const keyMeta = {
      provider: input.provider,
      hasKey: true,
      keyLast4: input.key.slice(-4),
    };
    testState.commandAiAssistantPayload = {
      assistant: testState.commandAiAssistantPayload?.assistant ?? {
        enabled: false,
        provider: input.provider,
        model: 'gpt-4o-mini',
        dailyTurnCap: 100,
        dailyTokenCap: 300_000,
        scopes: ['workspace:read', 'workspace:write'],
      },
      key: keyMeta,
      ready: Boolean(testState.commandAiAssistantPayload?.assistant.enabled),
    };
    return { key: keyMeta };
  }
  if (url.endsWith('/api/settings/command-ai-assistant') && method === 'PUT') {
    const assistant =
      body as import('../../shared/command-ai-assistant').CommandAiAssistantSettings;
    const key =
      testState.commandAiAssistantPayload?.key ??
      ({ provider: assistant.provider, hasKey: false, keyLast4: null } as const);
    testState.commandAiAssistantPayload = {
      assistant,
      key,
      ready: assistant.enabled && key.hasKey,
    };
    if (assistant.enabled) testState.liveTipsPayload = { enabled: true };
    return { assistant, key };
  }
  if (url.endsWith('/api/settings/branding') && method === 'PUT') {
    testState.brandingPayload = body as Branding;
    return { branding: testState.brandingPayload };
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

/** A Signal import dry run in the shape the server answers with, varied per case. */
export const signalPreview = (
  overrides: Partial<SignalImportPreview> = {},
): SignalImportPreview => ({
  schemaVersion: 1,
  ok: true,
  creates: { ...emptySignalImportCounts(), SignalPosts: 1, SignalMedia: 1 },
  updates: emptySignalImportCounts(),
  skips: emptySignalImportCounts(),
  failures: emptySignalImportCounts(),
  created: [{ sheet: 'SignalPosts', row: 2, key: 'POST-1', label: 'Imported copy' }],
  updated: [],
  skipped: [],
  issues: [],
  resolvedMedia: [
    {
      sheet: 'SignalMedia',
      row: 2,
      postKey: 'POST-1',
      order: 1,
      source: 'URL',
      url: 'https://example.com/image.jpg',
      resolved: true,
    },
  ],
  driveNamed: 0,
  driveResolved: 0,
  capabilitySummary: {
    postsEvaluated: 0,
    postsClean: 0,
    postsWithWarnings: 0,
    durableCount: 0,
    momentaryCount: 0,
  },
  capabilityVerdicts: [],
  duplicateRule: SIGNAL_IMPORT_DUPLICATE_RULE,
  fingerprint: 'b'.repeat(64),
  ...overrides,
});

export type { SignalImportPreview, SignalImportReceipt };
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
  testState.viewDefaultsPayload = null;
  testState.liveTipsPayload = null;
  testState.commandAiAssistantPayload = null;
  testState.manualPayload = null;
  testState.taskPatchError = null;
  testState.taskReorderError = null;
  testState.dashboardFailures = 0;
  testState.driveSettingsError = null;
  testState.driveSettingsPayload = null;
  testState.importReceiptsPayload = [];
  testState.importPreviewPayload = null;
  testState.importCommitPayload = null;
  testState.signalImportPreviewPayload = null;
  testState.signalImportCommitPayload = null;
  testState.integrationActivityPayload = [];
  testState.integrationActivityError = null;
  testState.agentHandoffsPayload = [];
  testState.agentHandoffsError = null;
  testState.agentHandoffDetailPayload = null;
  testState.agentHandoffDetailError = null;
  testState.agentSchedulesPayload = [];
  testState.agentSchedulesError = null;
  testState.mcpAgentRegistryPayload = { enabled: false, credentials: [] };
  testState.driveWriteRequestsPayload = [];
  testState.driveWriteQueueSummary = {
    pendingCount: 0,
    pendingDecodedBytes: 0,
    oldestPendingAt: null,
    oldestPendingAgeMs: null,
    expiredCount: 0,
    providerUncertainCount: 0,
    limits: {
      pendingCount: 20,
      pendingDecodedBytes: 50 * 1024 * 1024,
      pendingAgeMs: 24 * 60 * 60 * 1000,
      executionLeaseMs: 60 * 60 * 1000,
    },
  };
  testState.publishConfirmationRequestsPayload = [];
  testState.publishConfirmationQueueSummary = {
    pendingCount: 0,
    oldestPendingAt: null,
    oldestPendingAgeMs: null,
    expiredCount: 0,
    providerUncertainCount: 0,
    limits: { pendingCount: 20, pendingAgeMs: 24 * 60 * 60 * 1000 },
  };
  testState.mcpCredentialVerificationPayload = {
    credentialId: 'credential-issued',
    agentLabel: 'cursor-planning',
    storeId: 'store-fixture-verification',
    status: 'pending',
    verifiedAt: null,
  };
  testState.mcpHealthPanelPayload = {
    enabled: true,
    state: 'never_connected',
    stateReason: null,
    generatedAt: '2026-08-28T12:00:00.000Z',
    agents: [],
    errorSummary: [],
    staleHandoffs: [],
    recentCompletions: [],
    auditEventCount: 0,
  };
  testState.driveListingPayload = null;
  testState.driveWritePreviewPayload = null;
  testState.driveWriteCommitPayload = null;
  testState.calendarPayload = null;
  testState.signalPostsPayload = [];
  testState.signalPostsTruncated = false;
  testState.signalMutationError = null;
  testState.publishPreviewPayload = null;
  testState.publicationsPayload = [];
  testState.cardDeliveryPayload = null;
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
  testState.driveMediaPayload = null;
  testState.driveMediaError = null;
  testState.driveRecheckPayload = null;
  testState.driveRecheckError = null;
  testState.clientMergePreviewError = null;
  testState.clientMergeCommitError = null;
  testState.clientImportAliases = [];
  testState.queueHealthSummary = clearQueueHealth();
  testState.queueHealthError = null;
  testState.signalCampaignsPayload = [];
  testState.signalCampaignAnalyticsPayload = null;
  testState.signalCampaignAnalyticsError = null;
  testState.signalCampaignAnalyticsRequests = [];
  testState.providerInventoryPayload = null;
  testState.providerInventoryRefreshPayload = null;
  testState.providerInventoryError = null;
  testState.providerInventoryRequests = [];
  testState.analyticsWindowPayload = null;
  testState.analyticsWindowRefreshPayload = null;
  testState.analyticsWindowError = null;
  testState.analyticsWindowRequests = [];
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
