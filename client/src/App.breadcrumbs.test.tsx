import {
  fireEvent,
  render,
  screen,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  testState,
  task,
} from './App.test-setup';
import type { Client } from '../../shared/types';

const acme: Client = {
  id: 'client-p1',
  name: 'Acme',
  slug: 'acme',
  status: 'ACTIVE',
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
};

const trail = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

describe('Breadcrumb trail', () => {
  it('renders client detail with the loaded client name', async () => {
    testState.clientsPayload = [acme];
    render(
      <MemoryRouter initialEntries={['/clients/client-p1']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Acme' })).toBeVisible();
    const nav = trail();
    expect(within(nav).getByRole('link', { name: 'Command Center' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Clients' })).toHaveAttribute('href', '/clients');
    expect(within(nav).getByText('Acme')).toHaveAttribute('aria-current', 'page');
    expect(within(nav).queryByRole('link', { name: 'Acme' })).toBeNull();
  });

  it('renders project detail with the loaded project name', async () => {
    testState.clientsPayload = [acme];
    render(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Site refresh' })).toBeVisible();
    const nav = trail();
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(within(nav).getByText('Site refresh')).toHaveAttribute('aria-current', 'page');
  });

  it('renders a filtered Status trail through the loaded live project', async () => {
    testState.clientsPayload = [acme];
    render(
      <MemoryRouter initialEntries={['/status?project=p1&filter=week']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    const nav = trail();
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
    expect(within(nav).getByRole('link', { name: 'Site refresh' })).toHaveAttribute(
      'href',
      '/projects/p1',
    );
    expect(within(nav).getByText('Status')).toHaveAttribute('aria-current', 'page');
  });

  it('navigates an ancestor by click', async () => {
    testState.clientsPayload = [acme];
    render(
      <MemoryRouter initialEntries={['/clients/client-p1']}>
        <App />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { level: 1, name: 'Acme' });
    fireEvent.click(within(trail()).getByRole('link', { name: 'Clients' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Clients' })).toBeVisible();
    expect(within(trail()).getByText('Clients')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps task detail modal behavior outside the board route', async () => {
    testState.tasksPayload = [task('t1', 'Recap post')];
    render(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Site refresh' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Recap post/ }));
    expect(await screen.findByRole('heading', { name: 'Task details' })).toBeVisible();
    expect(within(trail()).getByText('Site refresh')).toHaveAttribute('aria-current', 'page');
    expect(within(trail()).queryByText('Recap post')).toBeNull();
  });

  it('renders a task detail route after reload with client and project context', async () => {
    testState.tasksPayload = [task('t1', 'Reloadable task')];
    render(
      <MemoryRouter initialEntries={['/tasks/t1']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Reloadable task' })).toBeVisible();
    expect(within(trail()).getAllByRole('link', { name: 'Tasks' })[0]).toHaveAttribute(
      'href',
      '/tasks',
    );
    expect(within(trail()).getByText('Reloadable task')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: /Edit details/ }));
    expect(await screen.findByRole('dialog')).toBeVisible();
  });

  it('shows a readable page when a bookmarked task no longer exists', async () => {
    testState.tasksPayload = [];
    render(
      <MemoryRouter initialEntries={['/tasks/gone']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Task not found' })).toBeVisible();
    expect(screen.getByRole('button', { name: '← All tasks' })).toBeVisible();
  });

  it('returns from a task detail route to the task list', async () => {
    testState.tasksPayload = [task('t1', 'Closable task')];
    render(
      <MemoryRouter initialEntries={['/tasks/t1']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Closable task' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeVisible();
  });
});
