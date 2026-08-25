import {
  CANONICAL_VIEW_DEFAULTS,
  MemoryRouter,
  App,
  afterEach,
  describe,
  expect,
  fireEvent,
  it,
  render,
  screen,
  setViewDefaults,
  testState,
  vi,
  waitFor,
  requests,
  project,
  client,
} from './App.test-setup';
import { useLocation } from 'react-router-dom';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>;
}

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await waitFor(() =>
    expect(requests.some((request) => request.url.endsWith('/api/settings/drive'))).toBe(true),
  );
};

const viewsCard = () =>
  screen.getByRole('heading', { name: 'Default views' }).closest('.settings-card')!;
const viewDefaultsPuts = () =>
  requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/api/settings/view-defaults'));

afterEach(() => vi.restoreAllMocks());

describe('default views settings form', () => {
  it('shows the effective choices and saves a configured object', async () => {
    await renderSettings();

    expect(screen.getByText(/Effective: Active clients/)).toBeVisible();
    fireEvent.change(screen.getByLabelText('Projects sort default'), {
      target: { value: 'name-ascending' },
    });
    fireEvent.change(screen.getByLabelText('Calendar view default'), {
      target: { value: 'week' },
    });
    expect(screen.getByText(/Effective:.*Name A–Z/)).toBeVisible();
    expect(screen.getByText(/Effective:.*Calendar Week/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(viewDefaultsPuts()).toHaveLength(1));
    expect(viewDefaultsPuts()[0].body).toMatchObject({
      projects: { sort: 'name-ascending' },
      calendar: { view: 'week' },
    });
  });

  it('resets the form to the canonical defaults before Save', async () => {
    setViewDefaults({
      projects: { visibility: 'all', sort: 'priority' },
      calendar: { view: 'week' },
    });
    await renderSettings();

    expect(screen.getByLabelText('Projects sort default')).toHaveValue('priority');
    fireEvent.click(
      Array.from(viewsCard().querySelectorAll('button.secondary')).find((button) =>
        /reset to defaults/i.test(button.textContent ?? ''),
      )!,
    );
    expect(screen.getByLabelText('Projects sort default')).toHaveValue(
      CANONICAL_VIEW_DEFAULTS.projects.sort,
    );
    expect(screen.getByLabelText('Calendar view default')).toHaveValue(
      CANONICAL_VIEW_DEFAULTS.calendar.view,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));
    await waitFor(() => expect(viewDefaultsPuts()).toHaveLength(1));
    expect(viewDefaultsPuts()[0].body).toEqual(CANONICAL_VIEW_DEFAULTS);
  });
});

describe('configured default views on collection pages', () => {
  it('applies a Projects sort default on a clean URL and lets an explicit sort win', async () => {
    setViewDefaults({ projects: { visibility: 'live', sort: 'name-ascending' } });
    testState.projectsPayload = [
      project('zulu', 'Zulu', 'ACTIVE', { clientId: 'c1', clientName: 'Acme' }),
      project('alpha', 'Alpha', 'ACTIVE', { clientId: 'c1', clientName: 'Acme' }),
    ];
    testState.clientsPayload = [client('c1', 'Acme')];

    const { unmount } = render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('combobox', { name: 'Sort projects by' })).toHaveValue(
      'name-ascending',
    );
    expect(screen.getByLabelText('Current location')).toHaveTextContent('/projects');
    const titles = () =>
      screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(titles().filter((name) => name === 'Alpha' || name === 'Zulu')).toEqual([
      'Alpha',
      'Zulu',
    ]);
    unmount();

    render(
      <MemoryRouter initialEntries={['/projects?sort=name-descending']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('combobox', { name: 'Sort projects by' })).toHaveValue(
      'name-descending',
    );
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/projects?sort=name-descending',
    );
  });

  it('applies a Clients visibility default on a clean URL and lets an explicit URL win', async () => {
    setViewDefaults({ clients: { visibility: 'archived' } });
    const active = client('active', 'Active Client');
    const archived = client('archived', 'Archived Client', 'ARCHIVED');
    testState.clientsPayload = [active, archived];

    const { unmount } = render(
      <MemoryRouter initialEntries={['/clients']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: archived.name })).toBeVisible();
    expect(screen.queryByRole('heading', { name: active.name })).toBeNull();
    expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    unmount();

    render(
      <MemoryRouter initialEntries={['/clients?visibility=active']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: active.name })).toBeVisible();
    expect(screen.queryByRole('heading', { name: archived.name })).toBeNull();
  });

  it('applies a Calendar view default on a clean URL and lets an explicit view win', async () => {
    setViewDefaults({ calendar: { view: 'week' } });
    testState.calendarPayload = (from, to) => ({
      from,
      to,
      posts: [],
      tasks: [],
      signal: { available: true, error: null, truncated: false },
    });

    const { unmount } = render(
      <MemoryRouter initialEntries={['/calendar']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Week', pressed: true })).toBeTruthy();
    unmount();

    render(
      <MemoryRouter initialEntries={['/calendar?view=today']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('button', { name: 'Today', pressed: true })).toBeTruthy();
  });
});
