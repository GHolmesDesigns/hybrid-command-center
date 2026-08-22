import {
  App,
  MemoryRouter,
  branding,
  describe,
  expect,
  fireEvent,
  it,
  providerInventoryEntry,
  providerInventorySnapshot,
  render,
  screen,
  testState,
  waitFor,
  within,
} from './App.test-setup';

/**
 * The provider inventory, as a reader meets it.
 *
 * The rules are not exercised here — which rows are orphans, how a caption is shortened, and what a
 * failed refresh leaves behind are decided on the server and tested in
 * `shared/provider-inventory.test.ts` and `server/publish/inventory.test.ts`. What is checked here is
 * what the page owes those rules: that opening the planner reads and does not refresh, that a post
 * this app did not send is marked in words rather than in colour alone, that a failed refresh still
 * shows the rows it kept, and that the panel offers nothing that writes.
 */

const openSignal = async () => {
  render(
    <MemoryRouter initialEntries={['/signal?month=2026-09']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

const panel = () => screen.getByRole('region', { name: 'What Post Bridge is holding' });

describe('Signal provider inventory', () => {
  it('opens as a read of stored rows and contacts the provider for none of it', async () => {
    await openSignal();
    await within(panel()).findByText('Nothing has been read from the provider yet.');
    expect(testState.providerInventoryRequests).toEqual(['read']);
    expect(
      within(panel()).getByText(/Press Refresh inventory to read every page/),
    ).toBeInTheDocument();
  });

  it('lists what the provider holds, and marks what this app did not send in words', async () => {
    testState.providerInventoryPayload = providerInventorySnapshot([
      providerInventoryEntry({
        providerPostId: 'remote-9',
        captionExcerpt: 'Scheduled straight in Post Bridge',
        accounts: [{ accountId: 901, handle: '@studio', channel: 'ig' }],
        providerUrl: 'https://p.example/remote-9',
      }),
      providerInventoryEntry({
        providerPostId: 'mock-publication',
        captionExcerpt: 'Submitted by this app',
        orphan: false,
        scheduledInstant: null,
      }),
    ]);
    await openSignal();

    const rows = within(panel()).getAllByRole('listitem');
    expect(within(rows[0] as HTMLElement).getByText('Not sent from here')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Scheduled with the provider')).toBeVisible();
    expect(within(rows[0] as HTMLElement).getByText(/@studio \(Instagram\)/)).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: /Open at the provider/ }),
    ).toHaveAttribute('href', 'https://p.example/remote-9');
    expect(within(rows[1] as HTMLElement).getByText('Sent from here')).toBeInTheDocument();
    // The provider held no instant for the second one, which is said rather than left blank.
    expect(within(rows[1] as HTMLElement).getByText(/No scheduled instant/)).toBeInTheDocument();
    expect(
      within(panel()).getByText(/2 posts at the provider, 1 of them not sent from here/),
    ).toBeInTheDocument();
  });

  it('reads the provider only when the button is pressed', async () => {
    testState.providerInventoryRefreshPayload = providerInventorySnapshot([
      providerInventoryEntry({ providerPostId: 'remote-9' }),
    ]);
    await openSignal();
    await within(panel()).findByText('Nothing has been read from the provider yet.');

    fireEvent.click(within(panel()).getByRole('button', { name: /Refresh inventory/ }));
    await within(panel()).findByText(/1 post at the provider, 1 of them not sent from here/);
    expect(testState.providerInventoryRequests).toEqual(['read', 'refresh']);
  });

  it('keeps the rows a failed refresh did not replace, and says why', async () => {
    testState.providerInventoryPayload = providerInventorySnapshot(
      [providerInventoryEntry({ providerPostId: 'remote-9' })],
      {
        reason:
          'The provider inventory could not be read, so nothing was replaced: Post Bridge refused the request (503).',
      },
    );
    await openSignal();
    expect(await within(panel()).findByRole('status')).toHaveTextContent('nothing was replaced');
    expect(within(panel()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('offers nothing that writes — one refresh, and links out', async () => {
    testState.providerInventoryPayload = providerInventorySnapshot([
      providerInventoryEntry({ providerPostId: 'remote-9' }),
    ]);
    await openSignal();
    expect(
      within(panel())
        .getAllByRole('button')
        .map((button) => button.textContent?.trim()),
    ).toEqual(['Refresh inventory']);
    expect(
      within(panel()).getByText(/Nothing here can adopt, edit, reschedule, or withdraw a post/),
    ).toBeInTheDocument();
  });

  it('says what to do about an unconfigured provider instead of offering a button', async () => {
    testState.providerInventoryPayload = { ...providerInventorySnapshot([]), available: false };
    await openSignal();
    expect(within(panel()).queryByRole('button')).toBeNull();
    expect(within(panel()).getByText(/Set POST_BRIDGE_API_KEY/)).toBeInTheDocument();
  });

  it('reports a read that could not be made at all', async () => {
    testState.providerInventoryError = 'The inventory could not be read.';
    await openSignal();
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'The inventory could not be read.',
    );
  });
});
