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
  type Category,
  type Client,
  project,
  testState,
  requests,
} from './App.test-setup';

/**
 * Categories on a project are chosen the way tags are chosen on a task: typed as chips,
 * resolved against the shared list, and reconciled once the project has an id to attach to.
 */
describe('Categories on the project form', () => {
  const retainer: Category = { id: 'cat-retainer', name: 'Retainer' };
  const campaign: Category = { id: 'cat-campaign', name: 'Campaign' };
  const acme: Client = {
    id: 'client-acme',
    name: 'Acme',
    slug: 'acme',
    status: 'ACTIVE',
    driveStatus: 'DISCONNECTED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  };

  const openProjects = async () => {
    testState.clientsPayload = [acme];
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  };
  const openNewProject = async () => {
    await openProjects();
    fireEvent.click(screen.getByRole('button', { name: /New project/ }));
    expect(await screen.findByRole('heading', { name: 'New project' })).toBeVisible();
  };
  const openEditOf = async (name: string) => {
    await openProjects();
    fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` }));
    expect(await screen.findByRole('heading', { name: 'Edit project' })).toBeVisible();
  };
  const field = () => screen.getByLabelText('Add a category');
  const typeCategory = (name: string) => {
    fireEvent.change(field(), { target: { value: name } });
    fireEvent.keyDown(field(), { key: 'Enter' });
  };
  const attachments = () =>
    requests.filter(
      (r) => r.method === 'POST' && /\/api\/projects\/[^/]+\/categories$/.test(r.url),
    );
  const detachments = () =>
    requests.filter((r) => r.method === 'DELETE' && r.url.includes('/categories/'));
  const created = () =>
    requests.filter((r) => r.method === 'POST' && r.url.endsWith('/api/categories'));

  it('creates a typed category and attaches it to the new project', async () => {
    testState.projectsPayload = [];
    await openNewProject();

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: acme.id } });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Site refresh' } });
    typeCategory('  Retainer  ');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(attachments()).toHaveLength(1));
    // Normalized on the way out, so the stored category is the one the list will show.
    expect(created()[0].body).toEqual({ name: 'Retainer' });
    // The project is created first: there is nothing to attach a category to before that.
    expect(
      requests.findIndex((r) => r.url.endsWith('/api/projects') && r.method === 'POST'),
    ).toBeLessThan(requests.indexOf(attachments()[0]));
    expect(attachments()[0].url).toContain('/api/projects/created-project/categories');
  });

  it('reuses an existing category rather than creating a second spelling of it', async () => {
    testState.categoriesPayload = [retainer];
    testState.projectsPayload = [];
    await openNewProject();

    fireEvent.change(screen.getByLabelText('Client'), { target: { value: acme.id } });
    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Site refresh' } });
    typeCategory('retainer');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(attachments()).toHaveLength(1));
    expect(attachments()[0].body).toEqual({ categoryId: retainer.id });
    // The chip resolved to the existing category in the browser, so nothing was posted to
    // create one.
    expect(created()).toEqual([]);
  });

  it('will not add the same category to a project twice', async () => {
    testState.categoriesPayload = [retainer];
    testState.projectsPayload = [];
    await openNewProject();

    typeCategory('Retainer');
    typeCategory('retainer');

    expect(screen.getAllByRole('button', { name: /^Remove category/ })).toHaveLength(1);
  });

  it('opens an existing project with its categories already chosen', async () => {
    testState.categoriesPayload = [campaign, retainer];
    testState.projectsPayload = [
      project('p1', 'Acme retainer', 'ACTIVE', { clientId: acme.id, categories: [retainer] }),
    ];
    await openEditOf('Acme retainer');

    expect(screen.getByRole('button', { name: 'Remove category Retainer' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove category Campaign' })).toBeNull();
  });

  it('sends only the difference when a project’s categories are edited', async () => {
    testState.categoriesPayload = [campaign, retainer];
    testState.projectsPayload = [
      project('p1', 'Acme retainer', 'ACTIVE', { clientId: acme.id, categories: [retainer] }),
    ];
    await openEditOf('Acme retainer');

    fireEvent.click(screen.getByRole('button', { name: 'Remove category Retainer' }));
    typeCategory('Campaign');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(attachments()).toHaveLength(1));
    expect(attachments()[0].body).toEqual({ categoryId: campaign.id });
    expect(detachments()).toHaveLength(1);
    expect(detachments()[0].url).toContain(`/api/projects/p1/categories/${retainer.id}`);
  });

  it('leaves untouched categories alone when another field is saved', async () => {
    testState.categoriesPayload = [retainer];
    testState.projectsPayload = [
      project('p1', 'Acme retainer', 'ACTIVE', { clientId: acme.id, categories: [retainer] }),
    ];
    await openEditOf('Acme retainer');

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Acme ongoing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'PATCH' && r.url.endsWith('/api/projects/p1'))).toBe(
        true,
      ),
    );
    expect(attachments()).toEqual([]);
    expect(detachments()).toEqual([]);
  });

  it('removes the last chip on Backspace in an empty field', async () => {
    testState.projectsPayload = [];
    await openNewProject();

    typeCategory('Retainer');
    typeCategory('Campaign');
    fireEvent.keyDown(field(), { key: 'Backspace' });

    expect(screen.getByRole('button', { name: 'Remove category Retainer' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove category Campaign' })).toBeNull();
  });

  it('asks for a category, not a tag, so the two inputs are never confused', async () => {
    testState.projectsPayload = [];
    await openNewProject();

    expect(field()).toHaveAttribute('placeholder', 'Type a category, then press Enter');
    expect(screen.queryByLabelText('Add a tag')).toBeNull();
  });
});
