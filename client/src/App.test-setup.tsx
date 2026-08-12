/* eslint-disable react-refresh/only-export-components -- test helpers are intentionally shared across sliced suites */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, format } from 'date-fns';
import { App } from './App';
import { APP_VERSION, DEFAULT_BRANDING, type Branding } from '../../shared/branding';
import type { Client, DashboardData, Project, Tag, Task } from '../../shared/types';
import { sameTagName } from '../../shared/types';

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
};
export type { Branding, Client, DashboardData, Project, Tag, Task };

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
  dashboardPayload: emptyDashboard as DashboardData,
  brandingPayload: null as Branding | null,
  taskPatchError: null as string | null,
  dashboardFailures: 0,
};

/** Serves the six endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/dashboard')) return testState.dashboardPayload;
  if (url.endsWith('/api/settings/branding'))
    return { branding: testState.brandingPayload ?? branding };
  if (url.endsWith('/api/projects')) return testState.projectsPayload;
  if (url.endsWith('/api/clients')) return testState.clientsPayload;
  if (url.endsWith('/api/tasks')) return testState.tasksPayload;
  if (url.endsWith('/api/tags')) return testState.tagsPayload;
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
 * step: reorder (so a reorder survives its `refresh()`), tag creation (so an existing name is
 * reused rather than duplicated), and tag deletion (so an attached tag is refused first).
 */
const respondTo = (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ url, method, body });
  if (url.endsWith('/api/dashboard') && testState.dashboardFailures > 0) {
    testState.dashboardFailures -= 1;
    return reply(503, { error: 'Dashboard refresh is temporarily unavailable.' });
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

beforeEach(() => {
  localStorage.clear();
  testState.projectsPayload = projects;
  testState.clientsPayload = [];
  testState.tasksPayload = [];
  testState.tagsPayload = [];
  testState.dashboardPayload = emptyDashboard;
  testState.brandingPayload = null;
  testState.taskPatchError = null;
  testState.dashboardFailures = 0;
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
  vi.unstubAllGlobals();
  localStorage.clear();
});
