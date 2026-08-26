import {
  fireEvent,
  render,
  screen,
  waitFor,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type Client,
  type Project,
  project,
  testState,
  requests,
} from './App.test-setup';
import { useLocation, useNavigate } from 'react-router-dom';

function HistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Current location">{`${location.pathname}${location.search}`}</output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
    </>
  );
}

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

  const renderProjects = async (entry = '/projects?visibility=all') => {
    testState.projectsPayload = sortableProjects;
    testState.clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={[entry]}>
        <App />
        <HistoryProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  };
  const renderedProjectNames = () =>
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);

  it('defaults to live projects and keeps explicit visibility, client, and sort state in history', async () => {
    await renderProjects('/projects');

    expect(renderedProjectNames()).toEqual(['Zulu', 'Alpha']);
    expect(screen.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by client' }), {
      target: { value: 'client-one' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort projects by' }), {
      target: { value: 'name-ascending' },
    });

    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/projects?visibility=all&client=client-one&sort=name-ascending',
    );
    expect(renderedProjectNames()).toEqual(['Middle', 'Zulu']);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('combobox', { name: 'Sort projects by' })).toHaveValue(
      'recently-updated',
    );
    expect(screen.getByRole('combobox', { name: 'Filter by client' })).toHaveValue('client-one');
  });

  it('loads bookmarked state and safely falls back from unsupported values', async () => {
    await renderProjects(
      '/projects?visibility=archived&client=client-one&sort=name-descending&campaign=kept',
    );

    expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('combobox', { name: 'Filter by client' })).toHaveValue('client-one');
    expect(screen.getByRole('combobox', { name: 'Sort projects by' })).toHaveValue(
      'name-descending',
    );
    expect(renderedProjectNames()).toEqual(['Middle']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Sort projects by' }), {
      target: { value: 'recently-updated' },
    });
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/projects?visibility=archived&client=client-one&campaign=kept',
    );
  });

  it('hides clients with no live projects from the Live client filter', async () => {
    await renderProjects('/projects');

    const clientSelect = screen.getByRole('combobox', { name: 'Filter by client' });
    const optionLabels = Array.from(clientSelect.querySelectorAll('option')).map(
      (o) => o.textContent,
    );
    // Both clients have live projects (Zulu, Alpha), so both stay offered.
    expect(optionLabels).toEqual(['All clients', 'Acme', 'Bravo']);
  });

  it('offers only clients with matching projects in each visibility view', async () => {
    testState.projectsPayload = [
      // Bravo's only project is archived, so it should drop out of the Live dropdown
      // while remaining available under Archived and All.
      ...sortableProjects.filter((p) => p.clientId !== 'client-two'),
      project('sort-bravo-archived', 'Bravo Only Archived', 'ARCHIVED', {
        clientId: 'client-two',
        clientName: 'Bravo',
      }),
    ];
    testState.clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

    const clientSelect = screen.getByRole('combobox', { name: 'Filter by client' });
    const optionLabels = () =>
      Array.from(clientSelect.querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels()).toEqual(['All clients', 'Acme']);

    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect(optionLabels()).toEqual(['All clients', 'Acme', 'Bravo']);

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(optionLabels()).toEqual(['All clients', 'Acme', 'Bravo']);
  });

  it('clears a stale client filter when a bookmarked URL names a client hidden by visibility', async () => {
    testState.projectsPayload = [
      ...sortableProjects.filter((p) => p.clientId !== 'client-two'),
      project('sort-bravo-archived', 'Bravo Only Archived', 'ARCHIVED', {
        clientId: 'client-two',
        clientName: 'Bravo',
      }),
    ];
    testState.clientsPayload = sortableClients;
    render(
      <MemoryRouter initialEntries={['/projects?client=client-two']}>
        <App />
        <HistoryProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

    // The invalid selection is ignored on this render, so the list and dropdown resolve
    // immediately rather than waiting on the URL cleanup below.
    expect(screen.getByRole('combobox', { name: 'Filter by client' })).toHaveValue('');
    expect(renderedProjectNames()).toEqual(['Zulu']);

    await waitFor(() => {
      expect(screen.getByLabelText('Current location').textContent).not.toContain('client=');
    });
  });

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
    testState.projectsPayload = [
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
    testState.clientsPayload = sortableClients;
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
    testState.projectsPayload = [
      project('tied-c', 'Cobalt', 'ACTIVE', { lastActivityAt: tied }),
      project('tied-a', 'Amber', 'ON_HOLD', { lastActivityAt: tied }),
      project('tied-b', 'Beryl', 'PLANNING', { lastActivityAt: tied }),
    ];
    testState.clientsPayload = sortableClients;
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
    testState.projectsPayload = [project('only', 'Lone project', 'ON_HOLD')];
    testState.clientsPayload = sortableClients;
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

  it('keeps Custom order in list mode but explains rearranging is grid-only', async () => {
    await renderProjects();
    chooseCustom();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Current location')).toHaveTextContent(
        '/projects?visibility=all&sort=custom&view=list',
      );
    });
    expect(
      screen.getByText(
        'Custom order is kept, but rearranging by hand is available in Grid view only.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Drag Zulu' })).toBeNull();
    expect(screen.getAllByRole('link', { name: 'Open board' }).length).toBeGreaterThan(0);
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

describe('Projects presentation and live-status filters', () => {
  const filterProjects: Project[] = [
    project('filter-planning', 'Planning One', 'PLANNING', {
      clientId: 'client-one',
      clientName: 'Acme',
    }),
    project('filter-active', 'Active One', 'ACTIVE', {
      clientId: 'client-one',
      clientName: 'Acme',
    }),
    project('filter-hold', 'Hold One', 'ON_HOLD', {
      clientId: 'client-two',
      clientName: 'Bravo',
    }),
    project('filter-complete', 'Complete One', 'COMPLETE', {
      clientId: 'client-two',
      clientName: 'Bravo',
    }),
    project('filter-archived', 'Archived One', 'ARCHIVED', {
      clientId: 'client-one',
      clientName: 'Acme',
    }),
  ];
  const filterClients: Client[] = [
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

  const renderFilterProjects = async (entry = '/projects?visibility=all') => {
    testState.projectsPayload = filterProjects;
    testState.clientsPayload = filterClients;
    render(
      <MemoryRouter initialEntries={[entry]}>
        <App />
        <HistoryProbe />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  };
  const gridNames = () =>
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
  const listNames = () =>
    [...document.querySelectorAll('.project-row-link strong')].map((node) => node.textContent);

  it('shows the same filtered projects in grid and list with matching links', async () => {
    await renderFilterProjects('/projects?visibility=all&statuses=ACTIVE,PLANNING');

    expect(gridNames()).toEqual(['Active One', 'Planning One']);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Active One' }).closest('a'),
    ).toHaveAttribute('href', '/projects/filter-active');

    await waitFor(() => {
      expect(screen.getByLabelText('Current location')).toHaveTextContent(
        '/projects?visibility=all&statuses=PLANNING%2CACTIVE',
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Current location')).toHaveTextContent(
        '/projects?visibility=all&statuses=PLANNING%2CACTIVE&view=list',
      );
    });
    expect(listNames()).toEqual(['Active One', 'Planning One']);
    expect(screen.getByText('Active One').closest('a')).toHaveAttribute(
      'href',
      '/projects/filter-active',
    );
    expect(
      screen.getAllByRole('link', { name: 'Open board' }).map((link) => link.getAttribute('href')),
    ).toEqual(['/status?project=filter-active', '/status?project=filter-planning']);
  });

  it('uses OR within statuses and AND with client and search', async () => {
    await renderFilterProjects(
      '/projects?visibility=all&statuses=ACTIVE,ON_HOLD&client=client-two',
    );

    expect(gridNames()).toEqual(['Hold One']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'complete' },
    });
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(gridNames()).toEqual(['Complete One', 'Hold One']);
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      'statuses=ACTIVE%2CON_HOLD%2CCOMPLETE',
    );
  });

  it('clears live-status filters when switching to Archived visibility', async () => {
    await renderFilterProjects('/projects?visibility=all&statuses=ACTIVE');

    expect(gridNames()).toEqual(['Active One']);
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Current location').textContent).not.toContain('statuses=');
    });
    expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'Active' })).toBeNull();
    expect(gridNames()).toEqual(['Archived One']);
    expect(
      screen.getByText(
        'Status filters apply to live projects. Switch to Live or All to narrow by planning status.',
      ),
    ).toBeVisible();
  });

  it('loads bookmarked presentation and statuses and drops unknown status tokens', async () => {
    await renderFilterProjects(
      '/projects?view=list&statuses=ACTIVE,ARCHIVED,nope&visibility=all&campaign=kept',
    );

    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true');
    expect(listNames()).toEqual(['Active One']);
    await waitFor(() => {
      expect(screen.getByLabelText('Current location')).toHaveTextContent(
        '/projects?view=list&statuses=ACTIVE&visibility=all&campaign=kept',
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      '/projects?statuses=ACTIVE&visibility=all&campaign=kept',
    );
    expect(screen.getByLabelText('Current location').textContent).not.toContain('view=');
  });
});
