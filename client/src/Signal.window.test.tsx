import {
  analyticsWindowGroup,
  analyticsWindowSnapshot,
  App,
  MemoryRouter,
  branding,
  describe,
  expect,
  fireEvent,
  it,
  render,
  screen,
  testState,
  waitFor,
  within,
} from './App.test-setup';

/**
 * The provider window panel, as a reader meets it.
 *
 * The rules are not exercised here — which rows are unmapped, how a total is added, and what a failed
 * refresh leaves behind are decided on the server and tested in
 * `shared/publish-analytics-window.test.ts` and `server/publish/analytics-window.test.ts`. What is
 * checked here is what the page owes those rules: that opening the planner reads and never refreshes,
 * that an unverified window is explained rather than offered, that an account with nothing measured
 * shows no total instead of four zeros, that unmapped rows are visible and outside the account rows,
 * and that no control appears that could ask for a window nobody has verified.
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

const panel = () => screen.getByRole('region', { name: 'What the provider reports over a window' });

describe('Signal provider window', () => {
  it('opens as a local read and contacts the provider for none of it', async () => {
    await openSignal();
    await within(panel()).findByText(/never been read/);
    expect(testState.analyticsWindowRequests).toEqual(['read']);
  });

  /**
   * The card's central honesty requirement, on the screen: §14 records the window's meaning as
   * unverified, so the panel says so and offers no window rather than labelling one with a guess.
   */
  it('explains an unverified window instead of offering it', async () => {
    await openSignal();
    const view = within(panel());
    await view.findByText(/Window meaning not verified/);
    expect(view.getByText(/has not been observed/)).toBeInTheDocument();
    // No window control at all while the offered list is empty, and nothing to press.
    expect(view.queryByLabelText('Window')).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Refresh window/ })).not.toBeInTheDocument();
    // The status is words and an icon, never a tint alone (`AGENTS.md`).
    expect(view.getByText(/Window meaning not verified/)).toBeVisible();
  });

  it('says what a window total is and is not, beside the numbers', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([analyticsWindowGroup()]);
    await openSignal();
    const view = within(panel());
    expect(
      view.getByText(/Nothing here is a rate, an average, or a share of anything/),
    ).toBeVisible();
    expect(view.getByText(/a window is not an account total/)).toBeVisible();
  });

  it('shows an account, its coverage, and the provider’s own four counts', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([
      analyticsWindowGroup({ deliveries: 3, measuredDeliveries: 2 }),
    ]);
    await openSignal();
    const row = within(panel()).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(row).getByText('gholmesdesigns')).toBeInTheDocument();
    expect(within(row).getByText('Instagram')).toBeInTheDocument();
    expect(within(row).getByText('2 of 3 deliveries named in this window.')).toBeInTheDocument();
    const figures = within(row).getByLabelText('Window figures for gholmesdesigns (Instagram)');
    expect(within(figures).getByText('100')).toBeInTheDocument();
    expect(within(figures).getByText('10')).toBeInTheDocument();
  });

  /**
   * Nothing measured is *no total*, never a row of zeros — the distinction the whole card turns on.
   */
  it('shows no total for an account the window named nothing for', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([
      analyticsWindowGroup({ deliveries: 4, measuredDeliveries: 0, totals: undefined }),
    ]);
    await openSignal();
    const row = within(panel()).getAllByRole('listitem')[0] as HTMLElement;
    expect(within(row).getByText(/No total for this account in this window/)).toBeInTheDocument();
    expect(within(row).getByText(/different from a total of zero/)).toBeInTheDocument();
    expect(within(row).queryByLabelText(/Window figures/)).not.toBeInTheDocument();
  });

  it('counts rows that match no delivery here and keeps them out of the account rows', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([analyticsWindowGroup()], {
      unmapped: [
        {
          postResultId: 'made-elsewhere',
          platform: 'instagram',
          totals: { views: 9000, likes: 1, comments: 0, shares: 0 },
        },
      ],
    });
    await openSignal();
    const view = within(panel());
    expect(view.getByText(/match no delivery recorded here/)).toBeInTheDocument();
    expect(view.getByText(/result made-elsewhere/)).toBeInTheDocument();
    // The account row still reports its own total, with the nine thousand views outside it.
    const accountFigures = view.getByLabelText('Window figures for gholmesdesigns (Instagram)');
    expect(within(accountFigures).queryByText('9,000')).not.toBeInTheDocument();
    expect(
      within(view.getByLabelText('Unattributed figures for result made-elsewhere')).getByText(
        '9,000',
      ),
    ).toBeInTheDocument();
  });

  it('says nothing has been read, and that a read only happens when asked', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([], { lastRefreshAt: undefined });
    await openSignal();
    expect(
      within(panel()).getByText(
        'This window has never been read. A window refreshes only when you ask.',
      ),
    ).toBeInTheDocument();
  });

  it('reports the last complete read where there has been one', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([analyticsWindowGroup()]);
    await openSignal();
    expect(within(panel()).getByText(/Last complete read/)).toBeInTheDocument();
  });

  /** A failed read leaves the rows it kept on screen with the reason above them. */
  it('shows the reason a refresh replaced nothing, above the rows it did not replace', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([analyticsWindowGroup()], {
      reason: 'The 30d window for instagram could not be read, so nothing was replaced: refused.',
    });
    await openSignal();
    const view = within(panel());
    expect(view.getByText(/nothing was replaced/)).toBeInTheDocument();
    expect(view.getAllByRole('listitem')).toHaveLength(1);
  });

  it('explains an unconfigured provider rather than offering a button', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([], { available: false });
    await openSignal();
    const view = within(panel());
    expect(view.getByText(/Set POST_BRIDGE_API_KEY/)).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /Refresh window/ })).not.toBeInTheDocument();
  });

  it('says why there is nothing to attribute when no delivery is on the platform', async () => {
    await openSignal();
    expect(
      within(panel()).getByText(
        /no delivery on this platform that the provider has given a result/,
      ),
    ).toBeInTheDocument();
  });

  /**
   * Changing the platform is a local read. The panel would be no cheaper than the per-post figures if
   * looking at it spent a provider request.
   */
  it('re-reads locally when the platform changes and spends nothing', async () => {
    await openSignal();
    expect(testState.analyticsWindowRequests).toEqual(['read']);
    fireEvent.change(within(panel()).getByLabelText('Platform'), {
      target: { value: 'instagram' },
    });
    await waitFor(() => expect(testState.analyticsWindowRequests).toEqual(['read', 'read']));
    expect(testState.analyticsWindowRequests).not.toContain('refresh');
  });

  /**
   * The one case where a control exists: a build whose offered list is non-empty. Asserted through a
   * payload rather than by flipping the evidence table, because the table is the production claim.
   */
  it('offers a window and a refresh only where the snapshot says one is verified', async () => {
    testState.analyticsWindowPayload = analyticsWindowSnapshot([analyticsWindowGroup()], {
      windows: ['30d'],
      window: '30d',
      verified: true,
      meaning: 'It selects which posts are included. Verified 2026-09-01.',
    });
    testState.analyticsWindowRefreshPayload = analyticsWindowSnapshot(
      [analyticsWindowGroup({ measuredDeliveries: 1 })],
      { windows: ['30d'], window: '30d', verified: true, meaning: 'It selects posts.' },
    );
    await openSignal();
    const view = within(panel());
    expect(view.getByLabelText('Window')).toBeInTheDocument();
    expect(
      view.getByText(/It selects which posts are included\. Verified 2026-09-01\./),
    ).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: /Refresh window/ }));
    await waitFor(() => expect(testState.analyticsWindowRequests).toContain('refresh'));
  });

  it('surfaces a failed request as an alert without clearing the panel', async () => {
    testState.analyticsWindowError = 'The window could not be read.';
    await openSignal();
    await waitFor(() =>
      expect(within(panel()).getByRole('alert')).toHaveTextContent('The window could not be read.'),
    );
  });
});
