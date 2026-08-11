import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { APP_VERSION } from '../../shared/branding';
import type { Client, DashboardData, Project, Task } from '../../shared/types';

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
  position: 0,
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

const task = (id: string, title: string, overrides: Partial<Task> = {}): Task => ({
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

let projectsPayload = projects;
let clientsPayload: Client[] = [];
let tasksPayload: Task[] = [];

/** Serves the five endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/dashboard')) return emptyDashboard;
  if (url.endsWith('/api/settings/branding')) return { branding };
  if (url.endsWith('/api/projects')) return projectsPayload;
  if (url.endsWith('/api/clients')) return clientsPayload;
  if (url.endsWith('/api/tasks')) return tasksPayload;
  return [];
};

const requests: { url: string; method: string; body: any }[] = [];

/**
 * Records every call and stands in for the server on `POST /api/projects/reorder`, so a
 * reorder survives the `refresh()` that follows it rather than snapping back.
 */
const respondTo = (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ url, method: init?.method ?? 'GET', body });
  if (url.endsWith('/api/projects/reorder')) {
    const order: string[] = body.orderedIds;
    projectsPayload = [...projectsPayload]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((p, position) => ({ ...p, position }));
    return projectsPayload;
  }
  return payloadFor(url);
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
  tasksPayload = [];
  requests.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(respondTo(String(input), init)),
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

  const sortControl = () => screen.getByRole('combobox', { name: 'Sort projects by' });
  const chooseCustom = () => fireEvent.change(sortControl(), { target: { value: 'custom' } });

  it('offers Custom order and starts from the order the API returned', async () => {
    await renderProjects();
    chooseCustom();

    expect(sortControl()).toHaveValue('custom');
    expect(renderedProjectNames()).toEqual(['Zulu', 'Alpha', 'Middle']);
  });

  it('reorders a tile from the keyboard and sends the whole new order', async () => {
    await renderProjects();
    chooseCustom();

    fireEvent.change(screen.getByLabelText('Position of Middle'), { target: { value: '1' } });

    await waitFor(() => expect(renderedProjectNames()).toEqual(['Middle', 'Zulu', 'Alpha']));
    const reorder = requests.find((r) => r.url.endsWith('/api/projects/reorder'));
    expect(reorder?.method).toBe('POST');
    expect(reorder?.body.orderedIds).toEqual(['sort-middle', 'sort-zulu', 'sort-alpha']);
  });

  it('keeps the custom order after switching to another sort mode and back', async () => {
    await renderProjects();
    chooseCustom();
    fireEvent.change(screen.getByLabelText('Position of Middle'), { target: { value: '1' } });
    await waitFor(() => expect(renderedProjectNames()).toEqual(['Middle', 'Zulu', 'Alpha']));

    fireEvent.change(sortControl(), { target: { value: 'name-ascending' } });
    expect(renderedProjectNames()).toEqual(['Alpha', 'Middle', 'Zulu']);

    chooseCustom();
    expect(renderedProjectNames()).toEqual(['Middle', 'Zulu', 'Alpha']);
  });

  it('disables pointer and keyboard reordering outside Custom order', async () => {
    await renderProjects();

    expect(screen.getByRole('button', { name: 'Drag Zulu' })).toBeDisabled();
    expect(screen.getByLabelText('Position of Zulu')).toBeDisabled();
    expect(screen.getByText('Switch to Custom order to arrange tiles by hand.')).toBeVisible();

    chooseCustom();

    expect(screen.getByRole('button', { name: 'Drag Zulu' })).toBeEnabled();
    expect(screen.getByLabelText('Position of Zulu')).toBeEnabled();
  });

  it('leaves the tile link navigable while the grip carries the drag', async () => {
    await renderProjects();
    chooseCustom();

    expect(screen.getByRole('heading', { level: 2, name: 'Zulu' }).closest('a')).toHaveAttribute(
      'href',
      '/projects/sort-zulu',
    );
    expect(screen.getByRole('button', { name: 'Drag Zulu' })).toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
  });
});

describe('Task type selector', () => {
  const typeSelect = () => screen.getByLabelText('Type') as HTMLSelectElement;

  const openNewTaskForm = async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(branding.title);
    clickTopbarNewTask();
  };

  it('starts untyped and offers the studio vocabulary in reading order', async () => {
    await openNewTaskForm();

    expect(typeSelect().value).toBe('');
    expect([...typeSelect().options].map((option) => option.textContent)).toEqual([
      'No type',
      'Blog Post',
      'Video',
      'Social Post',
      'Graphics',
      'Scheduling',
      'QA / Brand Pass',
      'Admin',
      'Other',
    ]);
  });

  it('sends the chosen type when the task is created', async () => {
    await openNewTaskForm();
    fireEvent.change(projectSelect(), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Draft the recap' } });
    fireEvent.change(typeSelect(), { target: { value: 'BLOG_POST' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'))).toBe(true),
    );
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'));
    expect(created?.body.taskType).toBe('BLOG_POST');
  });

  it('posts an empty type rather than omitting the key, so "No type" clears it', async () => {
    await openNewTaskForm();
    fireEvent.change(projectSelect(), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Untyped chore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'))).toBe(true),
    );
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/tasks'));
    expect(created?.body.taskType).toBe('');
  });

  it('opens an existing task in the edit form with its type already selected', async () => {
    tasksPayload = [task('t1', 'Recap post', { taskType: 'BLOG_POST' })];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));

    expect(await screen.findByRole('heading', { name: 'Edit task' })).toBeVisible();
    expect(typeSelect().value).toBe('BLOG_POST');
  });

  it('types a task that has none and sends only the type', async () => {
    tasksPayload = [task('t1', 'Legacy chore')];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Legacy chore/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    expect(typeSelect().value).toBe('');

    fireEvent.change(typeSelect(), { target: { value: 'GRAPHICS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PATCH' && r.url.endsWith('/api/tasks/t1'))).toBe(
        true,
      ),
    );
    const saved = requests.find((r) => r.method === 'PATCH' && r.url.endsWith('/api/tasks/t1'));
    expect(saved?.body.taskType).toBe('GRAPHICS');
  });
});

describe('Task type on the board', () => {
  const renderBoard = async (tasks: Task[]) => {
    tasksPayload = tasks;
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  };

  it('shows the type on the card and again in the task detail', async () => {
    await renderBoard([task('t1', 'Recap post', { taskType: 'QA_BRAND_PASS' })]);

    expect(screen.getByText('QA / Brand Pass')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /^Recap post/ }));

    await waitFor(() => expect(screen.getAllByText('QA / Brand Pass').length).toBe(2));
  });

  it('renders an untyped task with no badge at all', async () => {
    await renderBoard([task('t1', 'Legacy chore')]);

    expect(screen.getByRole('button', { name: /^Legacy chore/ })).toBeVisible();
    expect(document.querySelector('.task-type-badge')).toBeNull();
    // The priority badge beside it still renders, so the row itself is not missing.
    expect(document.querySelector('.priority-badge')).not.toBeNull();
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
