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
  testState,
  requests,
} from './App.test-setup';

/**
 * Signal campaign management, beside the other two label lists in Settings.
 *
 * The two acceptance criteria a card can show are here: renaming reaches every post because the
 * request is one `PATCH` on the campaign rather than a write per post, and deleting names how many
 * posts it would detach before anything is lost — and says the posts themselves survive.
 */
describe('Signal campaign management in Settings', () => {
  const renderSettings = async () => {
    testState.signalCampaignsPayload = [
      { id: 'campaign-clarity', name: 'Clarity Campaign', postCount: 2 },
      { id: 'campaign-spare', name: 'Unused idea', postCount: 0 },
    ];
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/signal/campaigns'))).toBe(true),
    );
  };
  const row = (name: string) =>
    screen.getByRole('button', { name: `Delete campaign ${name}` }).closest('li')!;
  const deleteRequests = (confirmed: boolean) =>
    requests.filter(
      (request) =>
        request.method === 'DELETE' &&
        request.url.includes('/api/signal/campaigns/campaign-clarity') &&
        request.url.includes('confirm=true') === confirmed,
    );

  afterEach(() => vi.restoreAllMocks());

  it('lists each campaign with how many posts carry it', async () => {
    await renderSettings();

    expect(row('Clarity Campaign')).toHaveTextContent('2 posts');
    expect(row('Unused idea')).toHaveTextContent('0 posts');
  });

  it('adds a campaign from the card itself, trimmed before it is sent', async () => {
    await renderSettings();

    fireEvent.change(screen.getByLabelText('New campaign name'), {
      target: { value: '  Explain It Clearly  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add campaign' }));

    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.method === 'POST' && request.url.endsWith('/api/signal/campaigns'),
        ),
      ).toBe(true),
    );
    const created = requests.find(
      (request) => request.method === 'POST' && request.url.endsWith('/api/signal/campaigns'),
    );
    expect(created?.body).toEqual({ name: 'Explain It Clearly' });
    expect(
      await screen.findByRole('button', { name: 'Delete campaign Explain It Clearly' }),
    ).toBeVisible();
  });

  it('says a name already in the list was picked rather than added again', async () => {
    await renderSettings();

    fireEvent.change(screen.getByLabelText('New campaign name'), {
      target: { value: 'clarity campaign' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add campaign' }));

    expect(await screen.findByText('“Clarity Campaign” is already in the list.')).toBeVisible();
    // And no second row appeared under the other spelling.
    expect(screen.getAllByRole('button', { name: /^Delete campaign / })).toHaveLength(2);
  });

  it('will not add a name that is only whitespace', async () => {
    await renderSettings();

    fireEvent.change(screen.getByLabelText('New campaign name'), { target: { value: '   ' } });

    expect(screen.getByRole('button', { name: 'Add campaign' })).toBeDisabled();
  });

  it('renames a campaign once, and the new name reaches every post', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename campaign Clarity Campaign' }));
    fireEvent.change(screen.getByLabelText('New name for Clarity Campaign'), {
      target: { value: 'Clarity' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH')).toBe(true));
    const renames = requests.filter((request) => request.method === 'PATCH');
    // One write, on the campaign. Nothing is written per post — that is the whole point of the
    // name living on the campaign row.
    expect(renames).toHaveLength(1);
    expect(renames[0]!.url).toContain('/api/signal/campaigns/campaign-clarity');
    expect(renames[0]!.body).toEqual({ name: 'Clarity' });
    expect(await screen.findByText('Campaign renamed to “Clarity” on 2 posts.')).toBeVisible();
  });

  it('reports a rename onto a name another campaign holds, and keeps the field open', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename campaign Clarity Campaign' }));
    fireEvent.change(screen.getByLabelText('New name for Clarity Campaign'), {
      target: { value: 'unused idea' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Another campaign is already called “Unused idea”.'),
    ).toBeVisible();
    // Still editing, with the typed name in place, so the correction is one edit away.
    expect(screen.getByLabelText('New name for Clarity Campaign')).toHaveValue('unused idea');
  });

  it('abandons a rename on Escape', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Rename campaign Clarity Campaign' }));
    const field = screen.getByLabelText('New name for Clarity Campaign');
    fireEvent.change(field, { target: { value: 'Something else' } });
    fireEvent.keyDown(field, { key: 'Escape' });

    expect(screen.queryByLabelText('New name for Clarity Campaign')).toBeNull();
    expect(requests.some((request) => request.method === 'PATCH')).toBe(false);
  });

  it('deletes a campaign nothing carries without asking', async () => {
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Delete campaign Unused idea' }));

    expect(await screen.findByText('Campaign “Unused idea” deleted.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete campaign Unused idea' })).toBeNull();
  });

  it('names the posts a deletion would detach, and says the posts themselves survive', async () => {
    const confirmed = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Delete campaign Clarity Campaign' }));

    await waitFor(() => expect(deleteRequests(true)).toHaveLength(1));
    expect(deleteRequests(false)).toHaveLength(1);
    const asked = confirmed.mock.calls[0]![0] as string;
    expect(asked).toContain('2 posts');
    expect(asked).toContain('posts themselves are not deleted');
    expect(
      await screen.findByText('Campaign “Clarity Campaign” deleted from 2 posts.'),
    ).toBeVisible();
  });

  it('leaves the campaign alone when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Delete campaign Clarity Campaign' }));

    await waitFor(() => expect(deleteRequests(false)).toHaveLength(1));
    expect(deleteRequests(true)).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: 'Delete campaign Clarity Campaign' }),
    ).toBeInTheDocument();
  });

  it('says so rather than showing an empty list when the workspace has no campaigns', async () => {
    testState.signalCampaignsPayload = [];
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await screen.findByText('No campaigns yet')).toBeVisible();
  });
});
