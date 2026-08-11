import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { APP_VERSION } from '../../shared/branding';
import type { Client, DashboardData, Project } from '../../shared/types';

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

const project = (
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
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const projects: Project[] = [
  project('p1', 'Site refresh'),
  project('p2', 'Brand system'),
  project('p3', 'Old retainer', 'ARCHIVED'),
];

let projectsPayload = projects;
let clientsPayload: Client[] = [];

/** Serves the five endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/dashboard')) return emptyDashboard;
  if (url.endsWith('/api/settings/branding')) return { branding };
  if (url.endsWith('/api/projects')) return projectsPayload;
  if (url.endsWith('/api/clients')) return clientsPayload;
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
  projectsPayload = projects;
  clientsPayload = [];
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

describe('Projects sorting', () => {
  const sortableProjects: Project[] = [
    project('sort-zulu', 'Zulu', 'ACTIVE', {
      clientId: 'client-one',
      clientName: 'Acme',
      priority: 'LOW',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }),
    project('sort-alpha', 'Alpha', 'ACTIVE', {
      clientId: 'client-two',
      clientName: 'Bravo',
      priority: 'URGENT',
      targetDeadline: '2026-02-01',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    project('sort-middle', 'Middle', 'ARCHIVED', {
      clientId: 'client-one',
      clientName: 'Acme',
      priority: 'HIGH',
      targetDeadline: '2026-01-01',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }),
  ];
  const sortableClients: Client[] = [
    {
      id: 'client-one',
      name: 'Acme',
      slug: 'acme',
      status: 'ACTIVE',
      driveStatus: 'DISCONNECTED',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'client-two',
      name: 'Bravo',
      slug: 'bravo',
      status: 'ACTIVE',
      driveStatus: 'DISCONNECTED',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  const renderProjects = async () => {
    projectsPayload = sortableProjects;
    clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  };
  const renderedProjectNames = () =>
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

  it('offers each sort mode and orders projects correctly', async () => {
    await renderProjects();
    const sort = screen.getByRole('combobox', { name: 'Sort projects by' });

    expect(sort).toHaveValue('recently-updated');
    expect(renderedProjectNames()).toEqual(['Zulu', 'Alpha', 'Middle']);

    fireEvent.change(sort, { target: { value: 'recently-created' } });
    expect(renderedProjectNames()).toEqual(['Alpha', 'Middle', 'Zulu']);

    fireEvent.change(sort, { target: { value: 'name-ascending' } });
    expect(renderedProjectNames()).toEqual(['Alpha', 'Middle', 'Zulu']);

    fireEvent.change(sort, { target: { value: 'name-descending' } });
    expect(renderedProjectNames()).toEqual(['Zulu', 'Middle', 'Alpha']);

    fireEvent.change(sort, { target: { value: 'deadline' } });
    expect(renderedProjectNames()).toEqual(['Middle', 'Alpha', 'Zulu']);

    fireEvent.change(sort, { target: { value: 'priority' } });
    expect(renderedProjectNames()).toEqual(['Alpha', 'Middle', 'Zulu']);

    fireEvent.change(sort, { target: { value: 'recently-updated' } });
    expect(renderedProjectNames()).toEqual(['Zulu', 'Alpha', 'Middle']);
  });

  it('composes sorting with search and client filters', async () => {
    await renderProjects();

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort projects by' }), {
      target: { value: 'name-ascending' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by client' }), {
      target: { value: 'client-one' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'l' },
    });

    expect(renderedProjectNames()).toEqual(['Middle', 'Zulu']);
  });
});

describe('Import module placeholder', () => {
  it('lists Import in the sidebar Coming next group without linking anywhere', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.getByText('Import')).toHaveClass('nav-disabled');
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  });

  it('hides Import when the sidebar is collapsed, like Calendar and Files', async () => {
    localStorage.setItem('hcc-sidebar-collapsed', '1');
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.queryByText('Import')).toBeNull();
    expect(screen.queryByText('Calendar')).toBeNull();
    expect(screen.queryByText('Files')).toBeNull();
  });

  it('lists an Import entry in the Settings future modules card', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(screen.getByText('Campaign playbook import')).toBeVisible();
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
