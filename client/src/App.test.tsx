import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, format } from 'date-fns';
import { App } from './App';
import { APP_VERSION } from '../../shared/branding';
import type { Client, DashboardData, Project, Tag, Task } from '../../shared/types';
import { sameTagName } from '../../shared/types';

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
  dueTodayTasks: [],
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
  lastActivityAt: '2026-01-01T00:00:00.000Z',
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
let tagsPayload: Tag[] = [];
let dashboardPayload: DashboardData = emptyDashboard;

/** Serves the six endpoints App() requests on mount. */
const payloadFor = (url: string) => {
  if (url.endsWith('/api/dashboard')) return dashboardPayload;
  if (url.endsWith('/api/settings/branding')) return { branding };
  if (url.endsWith('/api/projects')) return projectsPayload;
  if (url.endsWith('/api/clients')) return clientsPayload;
  if (url.endsWith('/api/tasks')) return tasksPayload;
  if (url.endsWith('/api/tags')) return tagsPayload;
  return [];
};

const requests: { url: string; method: string; body: any }[] = [];

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
  if (url.endsWith('/api/projects/reorder')) {
    const order: string[] = body.orderedIds;
    projectsPayload = [...projectsPayload]
      .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
      .map((p, position) => ({ ...p, position }));
    return projectsPayload;
  }
  if (url.endsWith('/api/tasks') && method === 'POST') return task('created-task', body.title);
  if (url.endsWith('/api/tags') && method === 'POST') {
    const existing = tagsPayload.find((tag) => sameTagName(tag.name, body.name));
    if (existing) return existing;
    const created: Tag = { id: `tag-${tagsPayload.length + 1}`, name: body.name };
    tagsPayload = [...tagsPayload, created];
    return created;
  }
  if (method === 'DELETE' && /\/api\/tags\/[^/]+/.test(url)) {
    const id = url.split('/api/tags/')[1].split('?')[0];
    const attached = tasksPayload.filter((t) => t.tags.some((tag) => tag.id === id)).length;
    if (attached && !url.includes('confirm=true'))
      return reply(409, {
        error: 'This tag is attached to tasks.',
        code: 'TAG_IN_USE',
        attachedTaskCount: attached,
      });
    tagsPayload = tagsPayload.filter((tag) => tag.id !== id);
    tasksPayload = tasksPayload.map((t) => ({ ...t, tags: t.tags.filter((tag) => tag.id !== id) }));
    return { ok: true, detachedFromTasks: attached };
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
  tagsPayload = [];
  dashboardPayload = emptyDashboard;
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

describe('Dashboard momentum panel', () => {
  // Midday UTC, so the rendered day is the same one either side of the date line.
  const EDITED = '2026-01-05T12:00:00.000Z';
  const WORKED = '2026-03-09T12:00:00.000Z';

  it('dates each project by its activity, not by the last edit to its record', async () => {
    dashboardPayload = {
      ...emptyDashboard,
      recentProjects: [
        project('p1', 'Site refresh', 'ACTIVE', { updatedAt: EDITED, lastActivityAt: WORKED }),
      ],
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    const panel = (
      await screen.findByRole('heading', { level: 2, name: 'Recently updated' })
    ).closest('section')!;
    expect(panel).toHaveTextContent('Mar 9, 2026');
    expect(panel).not.toHaveTextContent('Jan 5, 2026');
  });
});

/** A due date `offset` days from today, so no fixture expires. */
const day = (offset: number) => format(addDays(new Date(), offset), 'yyyy-MM-dd');

describe('Dashboard deadlines panel', () => {
  const overdueTask = task('t-late', 'Late artwork', { overdue: true, dueDate: day(-3) });
  const todayTask = task('t-today', 'Ship the newsletter', { dueDate: day(0) });
  const weekTask = task('t-week', 'Draft the recap', { dueDate: day(3) });

  const renderDashboard = async (payload: Partial<DashboardData>) => {
    dashboardPayload = { ...emptyDashboard, ...payload };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    return (await screen.findByText('Deadlines')).closest('section')!;
  };
  const bucketButton = (name: RegExp) => screen.getByRole('button', { name });

  it('shows each deadline state, its list, and its own empty state', async () => {
    // Today's task is in both buckets, which is what "Next 7 days" including today means.
    const panel = await renderDashboard({
      counts: {
        ...emptyDashboard.counts,
        overdue: 1,
        projectsOverdue: 1,
        dueToday: 1,
        dueNextSevenDays: 2,
      },
      overdueTasks: [overdueTask],
      dueTodayTasks: [todayTask],
      upcomingTasks: [todayTask, weekTask],
    });

    // Overdue leads, because it is the state that already cost something.
    expect(panel).toHaveTextContent('1 overdue task');
    expect(panel).toHaveTextContent('Late artwork');
    expect(panel).not.toHaveTextContent('Draft the recap');

    fireEvent.click(bucketButton(/^Due today 1$/));
    expect(panel).toHaveTextContent('1 task due today');
    expect(panel).toHaveTextContent('Ship the newsletter');
    expect(panel).not.toHaveTextContent('Late artwork');

    fireEvent.click(bucketButton(/^Next 7 days 2$/));
    expect(panel).toHaveTextContent('2 tasks due in the next 7 days');
    expect(panel).toHaveTextContent('Ship the newsletter');
    expect(panel).toHaveTextContent('Draft the recap');
  });

  it('gives each empty bucket a message of its own', async () => {
    const panel = await renderDashboard({});

    expect(panel).toHaveTextContent('Nothing overdue');

    fireEvent.click(bucketButton(/^Due today 0$/));
    expect(panel).toHaveTextContent('Nothing due today');
    expect(panel).not.toHaveTextContent('Nothing overdue');

    fireEvent.click(bucketButton(/^Next 7 days 0$/));
    expect(panel).toHaveTextContent('A clear week ahead');
    expect(panel).not.toHaveTextContent('Nothing due today');
  });

  it('sends the Open board button to the bucket on screen', async () => {
    tasksPayload = [weekTask];
    await renderDashboard({
      counts: { ...emptyDashboard.counts, dueNextSevenDays: 1 },
      upcomingTasks: [weekTask],
    });

    fireEvent.click(bucketButton(/^Next 7 days 1$/));
    fireEvent.click(screen.getByRole('button', { name: /open board/i }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(screen.getByText('Draft the recap')).toBeVisible();
  });

  it('marks the selected state for assistive tech, not by color alone', async () => {
    await renderDashboard({});

    expect(bucketButton(/^Overdue 0$/)).toHaveAttribute('aria-pressed', 'true');
    expect(bucketButton(/^Due today 0$/)).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(bucketButton(/^Due today 0$/));
    expect(bucketButton(/^Overdue 0$/)).toHaveAttribute('aria-pressed', 'false');
    expect(bucketButton(/^Due today 0$/)).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Board deadline filters', () => {
  const renderBoard = async (filter: string) => {
    render(
      <MemoryRouter initialEntries={[`/kanban?filter=${filter}`]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  };

  // Titles avoid the words on the filter dropdown, so a match means a card, not an option.
  beforeEach(() => {
    tasksPayload = [
      task('b-today', 'Newsletter goes out', { dueDate: day(0) }),
      task('b-week', 'Recap draft', { dueDate: day(3) }),
      task('b-far', 'Retro deck', { dueDate: day(8) }),
      task('b-done', 'Signed off already', { dueDate: day(0), status: 'COMPLETE' }),
      task('b-none', 'Someday idea'),
    ];
  });

  it('shows the same set the Next 7 days tile counts', async () => {
    await renderBoard('week');

    // Today counts, day 8 does not, and finished work is not pending work.
    expect(screen.getByText('Newsletter goes out')).toBeVisible();
    expect(screen.getByText('Recap draft')).toBeVisible();
    expect(screen.queryByText('Retro deck')).toBeNull();
    expect(screen.queryByText('Signed off already')).toBeNull();
    expect(screen.queryByText('Someday idea')).toBeNull();
  });

  it('narrows the today filter to today, finished work aside', async () => {
    await renderBoard('today');

    expect(screen.getByText('Newsletter goes out')).toBeVisible();
    expect(screen.queryByText('Recap draft')).toBeNull();
    expect(screen.queryByText('Signed off already')).toBeNull();
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
      lastActivityAt: '2026-01-03T00:00:00.000Z',
    }),
    project('sort-alpha', 'Alpha', 'ACTIVE', {
      clientId: 'client-two',
      clientName: 'Bravo',
      priority: 'URGENT',
      targetDeadline: '2026-02-01',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    }),
    // Archived, and worked on more recently than the active Alpha: Recently updated ranks
    // it above Alpha, which the old ACTIVE-first grouping made impossible.
    project('sort-middle', 'Middle', 'ARCHIVED', {
      clientId: 'client-one',
      clientName: 'Acme',
      priority: 'HIGH',
      targetDeadline: '2026-01-01',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastActivityAt: '2026-01-02T00:00:00.000Z',
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
    expect(renderedProjectNames()).toEqual(['Zulu', 'Middle', 'Alpha']);

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
    expect(renderedProjectNames()).toEqual(['Zulu', 'Middle', 'Alpha']);
  });

  it('ranks every status purely by recency under Recently updated', async () => {
    projectsPayload = [
      project('rank-active', 'Active long ago', 'ACTIVE', {
        lastActivityAt: '2026-01-01T00:00:00.000Z',
      }),
      project('rank-hold', 'On hold yesterday', 'ON_HOLD', {
        lastActivityAt: '2026-03-01T00:00:00.000Z',
      }),
      project('rank-planning', 'Planning today', 'PLANNING', {
        lastActivityAt: '2026-03-02T00:00:00.000Z',
      }),
    ];
    clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

    expect(renderedProjectNames()).toEqual([
      'Planning today',
      'On hold yesterday',
      'Active long ago',
    ]);
  });

  it('breaks equal activity timestamps by name and keeps that order across re-renders', async () => {
    const tied = '2026-02-02T00:00:00.000Z';
    projectsPayload = [
      project('tied-c', 'Cobalt', 'ACTIVE', { lastActivityAt: tied }),
      project('tied-a', 'Amber', 'ON_HOLD', { lastActivityAt: tied }),
      project('tied-b', 'Beryl', 'PLANNING', { lastActivityAt: tied }),
    ];
    clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

    expect(renderedProjectNames()).toEqual(['Amber', 'Beryl', 'Cobalt']);

    // Re-render through a state change that does not touch the data: the order must hold.
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: '' } });
    expect(renderedProjectNames()).toEqual(['Amber', 'Beryl', 'Cobalt']);
  });

  it('renders a single-project list under Recently updated', async () => {
    projectsPayload = [project('only', 'Lone project', 'ON_HOLD')];
    clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

    expect(renderedProjectNames()).toEqual(['Lone project']);
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

describe('Tag chip input', () => {
  const tagField = () => screen.getByLabelText('Add a tag');
  const type = (value: string) => fireEvent.change(tagField(), { target: { value } });
  const enter = () => fireEvent.keyDown(tagField(), { key: 'Enter' });
  const chipNames = () =>
    screen
      .getAllByRole('button', { name: /^Remove tag / })
      .map((button) => button.getAttribute('aria-label')?.replace('Remove tag ', ''));

  const openNewTaskForm = async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(branding.title);
    clickTopbarNewTask();
  };
  const createTaskNamed = (title: string) => {
    fireEvent.change(projectSelect(), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: title } });
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  };
  const attachRequests = () =>
    requests.filter((r) => r.method === 'POST' && /\/api\/tasks\/[^/]+\/tags$/.test(r.url));

  it('turns a typed name into a chip and creates the tag when the task is saved', async () => {
    await openNewTaskForm();
    type('Client review');
    enter();

    expect(chipNames()).toEqual(['Client review']);
    expect(tagField()).toHaveValue('');

    createTaskNamed('Draft the recap');

    await waitFor(() => expect(attachRequests().length).toBe(1));
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/tags'));
    expect(created?.body).toEqual({ name: 'Client review' });
    expect(attachRequests()[0].url).toBe('/api/tasks/created-task/tags');
    expect(attachRequests()[0].body).toEqual({ tagId: 'tag-1' });
  });

  it('reuses an existing global tag whatever the case or surrounding whitespace', async () => {
    tagsPayload = [{ id: 'tag-brand', name: 'Brand system' }];
    await openNewTaskForm();
    type('   brand   SYSTEM  ');
    enter();

    // The stored spelling wins, so the shared tag is recognisable wherever it appears.
    expect(chipNames()).toEqual(['Brand system']);

    createTaskNamed('Refresh the deck');

    await waitFor(() => expect(attachRequests().length).toBe(1));
    expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/tags'))).toBe(false);
    expect(attachRequests()[0].body).toEqual({ tagId: 'tag-brand' });
  });

  it('ignores a repeat of a tag already chosen, in any case', async () => {
    await openNewTaskForm();
    type('Launch');
    enter();
    type('  launch ');
    enter();

    expect(chipNames()).toEqual(['Launch']);
  });

  it('commits on a comma and on blur, so a typed name is never quietly dropped', async () => {
    await openNewTaskForm();
    type('Video');
    fireEvent.keyDown(tagField(), { key: ',' });
    expect(chipNames()).toEqual(['Video']);

    type('Print');
    fireEvent.blur(tagField());
    expect(chipNames()).toEqual(['Video', 'Print']);
  });

  it('removes chips with the remove button and with Backspace on an empty field', async () => {
    await openNewTaskForm();
    for (const name of ['Video', 'Print', 'Social']) {
      type(name);
      enter();
    }

    fireEvent.click(screen.getByRole('button', { name: 'Remove tag Print' }));
    expect(chipNames()).toEqual(['Video', 'Social']);

    fireEvent.keyDown(tagField(), { key: 'Backspace' });
    expect(chipNames()).toEqual(['Video']);
  });

  it('leaves an existing task alone when its tags are untouched', async () => {
    tagsPayload = [{ id: 'tag-brand', name: 'Brand system' }];
    tasksPayload = [
      task('t1', 'Recap post', { tags: [{ id: 'tag-brand', name: 'Brand system' }] }),
    ];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit details' }));
    expect(chipNames()).toEqual(['Brand system']);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PATCH' && r.url.endsWith('/api/tasks/t1'))).toBe(
        true,
      ),
    );
    // Only the mount-time `GET /api/tags` touched the tag endpoints; nothing was rewritten.
    expect(requests.filter((r) => r.method !== 'GET' && r.url.includes('/tags'))).toEqual([]);
  });

  it('detaches a tag straight from the task detail view', async () => {
    tagsPayload = [{ id: 'tag-brand', name: 'Brand system' }];
    tasksPayload = [
      task('t1', 'Recap post', { tags: [{ id: 'tag-brand', name: 'Brand system' }] }),
    ];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove tag Brand system' }));

    await waitFor(() =>
      expect(
        requests.some(
          (r) => r.method === 'DELETE' && r.url.endsWith('/api/tasks/t1/tags/tag-brand'),
        ),
      ).toBe(true),
    );
  });
});

describe('Board tag filtering and search', () => {
  const brand: Tag = { id: 'tag-brand', name: 'Brand system' };
  const urgent: Tag = { id: 'tag-urgent', name: 'Client review' };

  const renderBoard = async () => {
    tagsPayload = [brand, urgent];
    tasksPayload = [
      task('t1', 'Recap post', { tags: [brand] }),
      task('t2', 'Deck refresh', { tags: [brand, urgent] }),
      task('t3', 'Invoice chase', { tags: [] }),
    ];
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  };
  const cardTitles = () =>
    [...document.querySelectorAll('.kanban-card .card-title strong')].map((n) => n.textContent);
  /** The filter toggles are the only buttons named after a tag; cards render chips as text. */
  const tagFilter = (name: string) =>
    within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name });

  it('names every tag on the card it belongs to', async () => {
    await renderBoard();

    expect(screen.getByRole('list', { name: 'Tags on Deck refresh' })).toHaveTextContent(
      'Brand system',
    );
    expect(screen.getByRole('list', { name: 'Tags on Deck refresh' })).toHaveTextContent(
      'Client review',
    );
    expect(screen.queryByRole('list', { name: 'Tags on Invoice chase' })).toBeNull();
  });

  it('narrows the board to tasks carrying every selected tag', async () => {
    await renderBoard();

    fireEvent.click(tagFilter('Brand system'));
    expect(cardTitles()).toEqual(['Recap post', 'Deck refresh']);
    expect(tagFilter('Brand system')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(tagFilter('Client review'));
    expect(cardTitles()).toEqual(['Deck refresh']);

    fireEvent.click(screen.getByRole('button', { name: 'Clear tags' }));
    expect(cardTitles()).toEqual(['Recap post', 'Deck refresh', 'Invoice chase']);
  });

  it('composes a tag filter with the existing priority filter', async () => {
    await renderBoard();

    fireEvent.click(tagFilter('Brand system'));
    expect(cardTitles()).toEqual(['Recap post', 'Deck refresh']);

    // Every seeded task is MEDIUM, so the two filters together can only be empty.
    fireEvent.change(screen.getByRole('combobox', { name: 'Priority' }), {
      target: { value: 'URGENT' },
    });
    expect(cardTitles()).toEqual([]);
  });

  it('matches tag names as well as titles from the board search', async () => {
    await renderBoard();
    const search = screen.getByRole('textbox', { name: 'Search' });

    fireEvent.change(search, { target: { value: 'client rev' } });
    expect(cardTitles()).toEqual(['Deck refresh']);

    fireEvent.change(search, { target: { value: 'invoice' } });
    expect(cardTitles()).toEqual(['Invoice chase']);

    fireEvent.change(search, { target: { value: 'nothing here' } });
    expect(cardTitles()).toEqual([]);
  });
});

describe('Tag deletion from Settings', () => {
  const brand: Tag = { id: 'tag-brand', name: 'Brand system' };
  const spare: Tag = { id: 'tag-spare', name: 'Unused idea' };

  const renderSettings = async () => {
    tagsPayload = [brand, spare];
    tasksPayload = [
      task('t1', 'Recap post', { tags: [brand] }),
      task('t2', 'Deck', { tags: [brand] }),
    ];
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  };
  const deleteRequests = (confirmed: boolean) =>
    requests.filter(
      (r) =>
        r.method === 'DELETE' &&
        r.url.includes('/api/tags/tag-brand') &&
        r.url.includes('confirm=true') === confirmed,
    );

  afterEach(() => vi.restoreAllMocks());

  it('lists each tag with how many tasks carry it', async () => {
    await renderSettings();

    const row = screen.getByRole('button', { name: 'Delete tag Brand system' }).closest('li')!;
    expect(row).toHaveTextContent('Brand system');
    expect(row).toHaveTextContent('2 tasks');
  });

  it('reports the affected task count and only deletes once confirmed', async () => {
    await renderSettings();
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete tag Brand system' }));

    await waitFor(() => expect(deleteRequests(true).length).toBe(1));
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(confirmed.mock.calls[0][0]).toContain('attached to 2 tasks');
    // The unconfirmed call is what produced the count, and it changed nothing.
    expect(deleteRequests(false).length).toBe(1);
  });

  it('keeps an attached tag when the confirmation is dismissed', async () => {
    await renderSettings();
    const dismissed = vi.spyOn(window, 'confirm').mockReturnValue(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete tag Brand system' }));

    await waitFor(() => expect(dismissed).toHaveBeenCalledTimes(1));
    expect(deleteRequests(true)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Delete tag Brand system' })).toBeVisible();
  });

  it('deletes a tag no task carries without asking twice', async () => {
    await renderSettings();
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete tag Unused idea' }));

    await waitFor(() =>
      expect(
        requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/tags/tag-spare')),
      ).toBe(true),
    );
    expect(asked).not.toHaveBeenCalled();
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
