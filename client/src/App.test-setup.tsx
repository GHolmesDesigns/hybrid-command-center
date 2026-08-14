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
import { SIGNAL_DEFAULT_TIME, type SignalPost } from '../../shared/signal';

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
  signalMutationError: null as string | null,
};

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
  campaign: null,
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
      truncated: false,
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
      campaign: body.campaign ?? null,
      cta: body.cta ?? 'NONE',
      position: testState.signalPostsPayload.filter((post) => post.date === null).length,
    });
    testState.signalPostsPayload = [...testState.signalPostsPayload, created];
    return created;
  }
  const signalPostPath = url.match(/\/api\/signal\/posts\/([^/?]+)$/);
  if (signalPostPath && method === 'PATCH') {
    if (testState.signalMutationError) return reply(400, { error: testState.signalMutationError });
    testState.signalPostsPayload = testState.signalPostsPayload.map((post) =>
      post.id === signalPostPath[1] ? { ...post, ...body } : post,
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
  if (url.endsWith('/api/projects/reorder')) {
    const order: string[] = body.orderedIds;
    testState.projectsPayload = [...testState.projectsPayload]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((p, position) => ({ ...p, position }));
    return testState.projectsPayload;
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
  testState.signalMutationError = null;
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
