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

  it('does not add a segment when task detail opens as a modal', async () => {
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
});
