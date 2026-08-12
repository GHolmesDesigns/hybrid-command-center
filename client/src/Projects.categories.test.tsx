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
  type Category,
  type Client,
  project,
  testState,
} from './App.test-setup';

describe('Filtering projects by category', () => {
  const retainer: Category = { id: 'cat-retainer', name: 'Retainer' };
  const campaign: Category = { id: 'cat-campaign', name: 'Campaign' };
  const internal: Category = { id: 'cat-internal', name: 'Internal' };
  const acme: Client = {
    id: 'client-acme',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    driveStatus: 'DISCONNECTED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  /** One router entry per render: the address is what a reload would come back to. */
  const renderAt = async (path: string) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  };
  const renderProjects = (path = '/projects') => {
    testState.categoriesPayload = [campaign, internal, retainer];
    testState.projectsPayload = [
      project('p-both', 'Both labels', 'ACTIVE', { categories: [campaign, retainer] }),
      project('p-retainer', 'Retainer only', 'ACTIVE', { categories: [retainer] }),
      project('p-none', 'Uncategorized', 'ACTIVE'),
    ];
    return renderAt(path);
  };
  const visibleProjects = () =>
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
  const chip = (name: string) => screen.getByRole('button', { name });

  it('offers every category as a filter and shows all projects until one is chosen', async () => {
    await renderProjects();

    const group = screen.getByRole('group', { name: 'Categories' });
    // Alphabetical, as the API serves them — not the order the projects happen to use.
    expect(
      within(group)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Campaign', 'Internal', 'Retainer']);
    expect(group.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(visibleProjects()).toEqual(['Both labels', 'Retainer only', 'Uncategorized']);
  });

  it('narrows to the projects carrying the chosen category', async () => {
    await renderProjects();

    fireEvent.click(chip('Retainer'));

    expect(chip('Retainer')).toHaveAttribute('aria-pressed', 'true');
    expect(visibleProjects()).toEqual(['Both labels', 'Retainer only']);
  });

  it('requires every selected category rather than any of them', async () => {
    await renderProjects();

    fireEvent.click(chip('Retainer'));
    fireEvent.click(chip('Campaign'));

    expect(visibleProjects()).toEqual(['Both labels']);
    expect(screen.getByText('Showing projects that carry every selected category.')).toBeVisible();
  });

  it('reads its selection back from the address, so a reload keeps the filter', async () => {
    await renderProjects(`/projects?categories=${retainer.id},${campaign.id}`);

    expect(visibleProjects()).toEqual(['Both labels']);
    expect(chip('Retainer')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Campaign')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Internal')).toHaveAttribute('aria-pressed', 'false');
  });

  it('writes the selection into the address as chips are pressed', async () => {
    await renderProjects();

    fireEvent.click(chip('Campaign'));
    // Pressing the same chip again takes it back out rather than adding it twice.
    fireEvent.click(chip('Campaign'));
    fireEvent.click(chip('Retainer'));

    expect(chip('Campaign')).toHaveAttribute('aria-pressed', 'false');
    expect(visibleProjects()).toEqual(['Both labels', 'Retainer only']);
  });

  it('ignores a category id in the address that no longer exists', async () => {
    await renderProjects('/projects?categories=cat-deleted');

    expect(screen.getByText('No projects found')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear categories' }));
    expect(visibleProjects()).toEqual(['Both labels', 'Retainer only', 'Uncategorized']);
  });

  it('clears the whole selection in one action', async () => {
    await renderProjects();
    expect(screen.queryByRole('button', { name: 'Clear categories' })).toBeNull();

    fireEvent.click(chip('Campaign'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear categories' }));

    expect(visibleProjects()).toEqual(['Both labels', 'Retainer only', 'Uncategorized']);
    expect(chip('Campaign')).toHaveAttribute('aria-pressed', 'false');
  });

  it('combines with the client filter and the search box', async () => {
    testState.categoriesPayload = [retainer];
    testState.clientsPayload = [acme];
    testState.projectsPayload = [
      project('p-acme', 'Acme retainer', 'ACTIVE', {
        clientId: acme.id,
        categories: [retainer],
      }),
      project('p-globex', 'Globex retainer', 'ACTIVE', {
        clientId: 'client-globex',
        categories: [retainer],
      }),
    ];
    await renderAt('/projects');

    fireEvent.click(chip('Retainer'));
    expect(visibleProjects()).toEqual(['Acme retainer', 'Globex retainer']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by client' }), {
      target: { value: acme.id },
    });
    expect(visibleProjects()).toEqual(['Acme retainer']);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search' }), {
      target: { value: 'globex' },
    });
    expect(screen.getByText('No projects found')).toBeVisible();
  });

  it('names each project’s categories on its tile', async () => {
    await renderProjects();

    const labels = screen.getByRole('list', { name: 'Categories on Both labels' });
    // Colour is decoration; the tile spells the categories out.
    expect(
      within(labels)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Campaign', 'Retainer']);
    expect(screen.queryByRole('list', { name: 'Categories on Uncategorized' })).toBeNull();
  });

  it('hides the filter row entirely when the workspace has no categories', async () => {
    testState.projectsPayload = [project('p1', 'Only project')];
    await renderAt('/projects');

    expect(screen.queryByRole('group', { name: 'Categories' })).toBeNull();
  });
});
