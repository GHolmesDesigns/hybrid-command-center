import {
  fireEvent,
  render,
  screen,
  waitFor,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  App,
  type Category,
  project,
  testState,
  requests,
} from './App.test-setup';

describe('Category management in Settings', () => {
  const retainer: Category = { id: 'cat-retainer', name: 'Retainer' };
  const spare: Category = { id: 'cat-spare', name: 'Unused idea' };

  const renderSettings = async () => {
    testState.categoriesPayload = [retainer, spare];
    testState.projectsPayload = [
      project('p1', 'Acme retainer', 'ACTIVE', { categories: [retainer] }),
      project('p2', 'Globex retainer', 'ACTIVE', { categories: [retainer] }),
      project('p3', 'One-off build'),
    ];
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
  const deleteRequests = (confirmed: boolean) =>
    requests.filter(
      (r) =>
        r.method === 'DELETE' &&
        r.url.includes('/api/categories/cat-retainer') &&
        r.url.includes('confirm=true') === confirmed,
    );
  const row = (name: string) =>
    screen.getByRole('button', { name: `Delete category ${name}` }).closest('li')!;

  afterEach(() => vi.restoreAllMocks());

  it('lists each category with how many projects carry it', async () => {
    await renderSettings();

    expect(row('Retainer')).toHaveTextContent('Retainer');
    expect(row('Retainer')).toHaveTextContent('2 projects');
    expect(row('Unused idea')).toHaveTextContent('0 projects');
  });

  it('adds a category from the card itself', async () => {
    await renderSettings();

    fireEvent.change(screen.getByLabelText('New category name'), {
      target: { value: '  Campaign  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.url.endsWith('/api/categories'))).toBe(
        true,
      ),
    );
    const created = requests.find((r) => r.method === 'POST' && r.url.endsWith('/api/categories'));
    // Trimmed before it is sent, so the stored spelling is the one the list will show.
    expect(created?.body).toEqual({ name: 'Campaign' });
    expect(await screen.findByRole('button', { name: 'Delete category Campaign' })).toBeVisible();
  });

  it('will not add a name that is only whitespace', async () => {
    await renderSettings();

    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  });

  it('renames a category once, and the new name reaches every project', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename category Retainer' }));
    fireEvent.change(screen.getByLabelText('New name for Retainer'), {
      target: { value: 'Ongoing retainer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Delete category Ongoing retainer' }),
      ).toBeVisible(),
    );
    const patches = requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('/api/categories/cat-retainer');
    expect(patches[0].body).toEqual({ name: 'Ongoing retainer' });
    expect(screen.getByText(/renamed to “Ongoing retainer” on 2 projects/)).toBeVisible();
  });

  it('keeps the rename open and reports why when the name is already taken', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename category Unused idea' }));
    fireEvent.change(screen.getByLabelText('New name for Unused idea'), {
      target: { value: 'retainer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/already called “retainer”/)).toBeVisible();
    // Still editing, with the rejected name in the field, so it takes one correction.
    expect(screen.getByLabelText('New name for Unused idea')).toHaveValue('retainer');
    // And nothing moved: the category that already held the name still holds it.
    expect(screen.getByRole('button', { name: 'Delete category Retainer' })).toBeVisible();
  });

  it('cancels a rename without sending anything', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename category Retainer' }));
    fireEvent.change(screen.getByLabelText('New name for Retainer'), {
      target: { value: 'Abandoned' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Rename category Retainer' })).toBeVisible();
  });

  it('abandons a rename on Escape, leaving the name as it was', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename category Retainer' }));
    const field = screen.getByLabelText('New name for Retainer');
    fireEvent.change(field, { target: { value: 'Abandoned' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Rename category Retainer' })).toBeVisible();
  });

  it('reports the affected project count and only deletes once confirmed', async () => {
    await renderSettings();
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete category Retainer' }));

    await waitFor(() => expect(deleteRequests(true).length).toBe(1));
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(confirmed.mock.calls[0][0]).toContain('attached to 2 projects');
    expect(confirmed.mock.calls[0][0]).toContain('projects themselves are not deleted');
    // The unconfirmed call is what produced the count, and it changed nothing.
    expect(deleteRequests(false).length).toBe(1);
  });

  it('keeps an attached category when the confirmation is dismissed', async () => {
    await renderSettings();
    const dismissed = vi.spyOn(window, 'confirm').mockReturnValue(false);

    fireEvent.click(screen.getByRole('button', { name: 'Delete category Retainer' }));

    await waitFor(() => expect(dismissed).toHaveBeenCalledTimes(1));
    expect(deleteRequests(true)).toEqual([]);
    expect(screen.getByRole('button', { name: 'Delete category Retainer' })).toBeVisible();
  });

  it('deletes a category no project carries without asking twice', async () => {
    await renderSettings();
    const asked = vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete category Unused idea' }));

    await waitFor(() =>
      expect(
        requests.some((r) => r.method === 'DELETE' && r.url.endsWith('/api/categories/cat-spare')),
      ).toBe(true),
    );
    expect(asked).not.toHaveBeenCalled();
  });

  it('deletes the label without deleting a single project', async () => {
    await renderSettings();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    fireEvent.click(screen.getByRole('button', { name: 'Delete category Retainer' }));

    await waitFor(() => expect(deleteRequests(true).length).toBe(1));
    expect(requests.some((r) => r.method === 'DELETE' && r.url.includes('/api/projects/'))).toBe(
      false,
    );
    expect(testState.projectsPayload.map((p) => p.name)).toEqual([
      'Acme retainer',
      'Globex retainer',
      'One-off build',
    ]);
  });
});
