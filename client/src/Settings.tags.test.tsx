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
  type Tag,
  task,
  testState,
  requests,
} from './App.test-setup';

describe('Tag deletion from Settings', () => {
  const brand: Tag = { id: 'tag-brand', name: 'Brand system' };
  const spare: Tag = { id: 'tag-spare', name: 'Unused idea' };

  const renderSettings = async () => {
    testState.tagsPayload = [brand, spare];
    testState.tasksPayload = [
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
