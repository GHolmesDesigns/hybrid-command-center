import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { APP_VERSION } from '../../shared/branding';
import type { DashboardData, Project } from '../../shared/types';

const emptyDashboard: DashboardData = {
  counts: {
    activeClients: 0,
    activeProjects: 0,
    dueToday: 0,
    dueNextSevenDays: 0,
    overdue: 0,
    projectsOverdue: 0,
  },
  overdueTasks: [],
  upcomingTasks: [],
  recentProjects: [],
};

const branding = {
  mark: 'TC',
  title: 'Test Command Center',
  subtitle: 'Smoke test workspace',
  tagline: 'Offline',
};

const project = (id: string, name: string, status: Project['status'] = 'ACTIVE'): Project => ({
  id,
  clientId: `client-${id}`,
  clientName: 'Acme',
  name,
  status,
  priority: 'MEDIUM',
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const projects: Project[] = [
  project('p1', 'Site refresh'),
  project('p2', 'Brand system'),
  project('p3', 'Old retainer', 'ARCHIVED'),
];

/** Serves the five endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/dashboard')) return emptyDashboard;
  if (url.endsWith('/api/settings/branding')) return { branding };
  if (url.endsWith('/api/projects')) return projects;
  return [];
};

/** The topbar action is rendered before any page-level "New task" button. */
const clickTopbarNewTask = () =>
  fireEvent.click(screen.getAllByRole('button', { name: /new task/i })[0]);

const projectSelect = () => screen.getByLabelText('Project') as HTMLSelectElement;

const LAST_PROJECT_KEY = 'hcc-last-project';

/** Visiting a project records it in an effect, so wait for that before opening the form. */
const remembered = (id: string) =>
  waitFor(() => expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe(id));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(payloadFor(String(input))),
      } as Response),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('App', () => {
  it('renders the sidebar with fetched branding once loading resolves', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(branding.title)).toBeInTheDocument();
    expect(screen.getByText(branding.subtitle)).toBeInTheDocument();
    expect(screen.getByText(`v${APP_VERSION}`)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Status' })).toHaveAttribute('href', '/kanban');
  });

  it('labels the board route Status without exposing the word Kanban', async () => {
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(screen.queryByText(/kanban/i)).toBeNull();
  });
});

describe('New task project default', () => {
  it('pre-selects the project you are viewing for the topbar action', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Site refresh' })).toBeVisible();
    await remembered('p1');
    clickTopbarNewTask();

    expect(projectSelect().value).toBe('p1');
  });

  it('remembers the project across a reload for the dashboard quick action', async () => {
    const visit = render(
      <MemoryRouter initialEntries={['/projects/p2']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Brand system' })).toBeVisible();
    await remembered('p2');
    visit.unmount();

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    // The quick-start action, not the topbar one.
    fireEvent.click((await screen.findAllByRole('button', { name: /new task/i }))[1]);

    expect(projectSelect().value).toBe('p2');
  });

  it('keeps the remembered project overridable from an unrelated page', async () => {
    localStorage.setItem('hcc-last-project', 'p1');
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    clickTopbarNewTask();
    const select = projectSelect();
    expect(select.value).toBe('p1');

    fireEvent.change(select, { target: { value: 'p2' } });
    expect(select.value).toBe('p2');
  });

  it('falls back to the placeholder when the remembered project is archived', async () => {
    localStorage.setItem('hcc-last-project', 'p3');
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    clickTopbarNewTask();

    expect(projectSelect().value).toBe('');
  });

  it('shows the placeholder on a cold start with no history', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    clickTopbarNewTask();

    expect(projectSelect().value).toBe('');
  });
});
