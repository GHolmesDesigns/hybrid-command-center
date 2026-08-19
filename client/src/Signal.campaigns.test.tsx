import {
  App,
  MemoryRouter,
  branding,
  calendarRange,
  describe,
  emptyCampaignAnalytics,
  expect,
  fireEvent,
  it,
  render,
  requests,
  screen,
  signalPost,
  testState,
  waitFor,
  within,
} from './App.test-setup';
import {
  SIGNAL_CAMPAIGN_NONE,
  SIGNAL_CAMPAIGN_NONE_LABEL,
  type SignalCampaignAnalyticsGroup,
} from '../../shared/signal-campaign-analytics';

/**
 * Campaigns on the planner: the chips on a post, and the figures grouped by them.
 *
 * The grouping rules are `shared/signal-campaign-analytics.test.ts`'s and the gather is
 * `server/publish/campaign-analytics.test.ts`'s. What is covered here is the browser's half: that a
 * typed campaign is sent as a name, that a filter reaches the address and the API, and that a group
 * with nothing measured says so rather than showing a row of zeros.
 */

const clarity = { id: 'campaign-1', name: 'Clarity Campaign' };
const week = { id: 'campaign-2', name: 'Wk1' };

const openPlanner = async (entry = '/signal?month=2026-09') => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
};

const group = (
  overrides: Partial<SignalCampaignAnalyticsGroup> = {},
): SignalCampaignAnalyticsGroup => ({
  campaignId: clarity.id,
  name: clarity.name,
  posts: 1,
  deliveries: 1,
  measuredDeliveries: 1,
  totals: { views: 4210, likes: 318, comments: 24, shares: 61 },
  trend: [],
  ...overrides,
});

const panel = () => screen.getByRole('region', { name: 'Campaign figures' });
const analyticsRequests = () => testState.signalCampaignAnalyticsRequests;
const lastAnalyticsRequest = () => analyticsRequests().at(-1);

describe('campaigns on a Signal post', () => {
  it('turns a typed campaign into a chip and saves the names, not ids', async () => {
    testState.signalCampaignsPayload = [{ ...clarity, postCount: 3 }];
    testState.signalPostsPayload = [signalPost('post-1', 'The launch post', '2026-09-14')];
    await openPlanner();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The launch post' }));

    const dialog = screen.getByRole('dialog');
    const field = within(dialog).getByLabelText('Add a campaign');
    fireEvent.change(field, { target: { value: '  Clarity Campaign  ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.change(field, { target: { value: 'Wk1' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(
      within(dialog)
        .getAllByRole('button', { name: /^Remove campaign / })
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Remove campaign Clarity Campaign', 'Remove campaign Wk1']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save post' }));
    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH')).toBe(true));
    const patch = requests.find((request) => request.method === 'PATCH');
    // Names, so the server resolves or creates each one inside the same transaction as the post.
    expect(patch?.body.campaigns).toEqual(['Clarity Campaign', 'Wk1']);
  });

  it('offers the workspace’s campaigns and drops one that is already chosen', async () => {
    testState.signalCampaignsPayload = [
      { ...clarity, postCount: 1 },
      { ...week, postCount: 2 },
    ];
    testState.signalPostsPayload = [
      signalPost('post-1', 'The launch post', '2026-09-14', { campaigns: [clarity] }),
    ];
    await openPlanner();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The launch post' }));

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('button', { name: 'Remove campaign Clarity Campaign' }),
    ).toBeInTheDocument();
    // The suggestion list offers only what the post does not already carry.
    const options = Array.from(dialog.querySelectorAll('datalist option')).map((option) =>
      option.getAttribute('value'),
    );
    expect(options).toContain('Wk1');
    expect(options).not.toContain('Clarity Campaign');
  });

  it('sends an empty set when every chip is removed, which is the answer “no campaign”', async () => {
    testState.signalCampaignsPayload = [{ ...clarity, postCount: 1 }];
    testState.signalPostsPayload = [
      signalPost('post-1', 'The launch post', '2026-09-14', { campaigns: [clarity] }),
    ];
    await openPlanner();
    fireEvent.click(screen.getByRole('button', { name: 'Edit The launch post' }));

    const dialog = screen.getByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Remove campaign Clarity Campaign' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save post' }));

    await waitFor(() => expect(requests.some((request) => request.method === 'PATCH')).toBe(true));
    expect(requests.find((request) => request.method === 'PATCH')?.body.campaigns).toEqual([]);
  });

  it('shows every campaign a scheduled post carries on the calendar, not just the first', async () => {
    testState.calendarPayload = () =>
      calendarRange({
        posts: [
          signalPost('post-1', 'The launch post', '2026-09-14', { campaigns: [clarity, week] }),
        ],
      });
    render(
      <MemoryRouter initialEntries={['/calendar?month=2026-09']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByText(branding.title);
    await screen.findByRole('heading', { level: 1, name: /September 2026/ });

    const cell = await screen.findByRole('region', { name: /September 14, 2026/ });
    // A post belongs to a campaign *and* to the week inside it; showing one of the two would name
    // the wrong half half the time.
    expect(within(cell).getByText('Clarity Campaign')).toBeInTheDocument();
    expect(within(cell).getByText('Wk1')).toBeInTheDocument();
  });
});

describe('the campaign figures panel', () => {
  it('reads the stored figures on open, with no provider call and no refresh control', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      groups: [group()],
      scope: { posts: 1, deliveries: 1, measuredDeliveries: 1 },
      totals: { views: 4210, likes: 318, comments: 24, shares: 61 },
      campaigns: [clarity],
    });
    await openPlanner();

    expect(panel()).toHaveTextContent('Clarity Campaign');
    expect(panel()).toHaveTextContent((4210).toLocaleString());
    expect(panel()).toHaveTextContent('1 of 1 delivery measured');
    // Nothing here fetches from the provider, so there is deliberately no refresh button.
    expect(within(panel()).queryByRole('button', { name: /Refresh figures/ })).toBeNull();
    expect(analyticsRequests()).toHaveLength(1);
  });

  it('says a group is unmeasured rather than showing a row of zeros', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      groups: [
        group({
          measuredDeliveries: 0,
          deliveries: 2,
          totals: undefined,
        }),
      ],
      scope: { posts: 1, deliveries: 2, measuredDeliveries: 0 },
      campaigns: [clarity],
    });
    await openPlanner();

    expect(panel()).toHaveTextContent('No figures yet');
    expect(panel()).toHaveTextContent('0 of 2 deliveries measured');
    expect(panel()).toHaveTextContent('which is different from a count of zero');
    expect(within(panel()).queryByLabelText('Figures for Clarity Campaign')).toBeNull();
  });

  it('keeps unclassified posts visible under No campaign', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      groups: [
        group(),
        group({
          campaignId: null,
          name: SIGNAL_CAMPAIGN_NONE_LABEL,
          posts: 4,
          deliveries: 0,
          measuredDeliveries: 0,
          totals: undefined,
        }),
      ],
      scope: { posts: 5, deliveries: 1, measuredDeliveries: 1 },
      totals: { views: 4210, likes: 318, comments: 24, shares: 61 },
      campaigns: [clarity],
    });
    await openPlanner();

    expect(panel()).toHaveTextContent(SIGNAL_CAMPAIGN_NONE_LABEL);
    expect(panel()).toHaveTextContent('4 posts');
  });

  it('puts a campaign filter in the address and sends it, with several read as or', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      groups: [group()],
      campaigns: [clarity, week],
    });
    await openPlanner();

    fireEvent.click(within(panel()).getByRole('button', { name: 'Clarity Campaign' }));
    await waitFor(() => expect(lastAnalyticsRequest()).toContain(`campaigns=${clarity.id}`));
    expect(within(panel()).getByRole('button', { name: 'Clarity Campaign' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(within(panel()).getByRole('button', { name: 'Wk1' }));
    await waitFor(() =>
      expect(lastAnalyticsRequest()).toContain(
        `campaigns=${encodeURIComponent(`${clarity.id},${week.id}`)}`,
      ),
    );

    // And selecting it again takes it back out.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Clarity Campaign' }));
    await waitFor(() => expect(lastAnalyticsRequest()).toContain(`campaigns=${week.id}`));
    expect(lastAnalyticsRequest()).not.toContain(clarity.id);
  });

  it('asks for the unclassified posts by name', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({ campaigns: [clarity] });
    await openPlanner();

    fireEvent.click(within(panel()).getByRole('button', { name: SIGNAL_CAMPAIGN_NONE_LABEL }));
    await waitFor(() =>
      expect(lastAnalyticsRequest()).toContain(`campaigns=${SIGNAL_CAMPAIGN_NONE}`),
    );
  });

  it('filters by channel, by account, and by a date range', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      channels: ['tt', 'yt'],
      accounts: [{ accountId: 904, channel: 'tt', handle: '@gholmes' }],
      campaigns: [clarity],
    });
    await openPlanner();

    fireEvent.click(within(panel()).getByRole('button', { name: 'TikTok' }));
    await waitFor(() => expect(lastAnalyticsRequest()).toContain('channels=tt'));

    fireEvent.click(within(panel()).getByRole('button', { name: '@gholmes' }));
    await waitFor(() => expect(lastAnalyticsRequest()).toContain('accounts=904'));

    fireEvent.change(within(panel()).getByLabelText('From'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(lastAnalyticsRequest()).toContain('from=2026-09-01'));
    fireEvent.change(within(panel()).getByLabelText('To'), { target: { value: '2026-09-30' } });
    await waitFor(() => expect(lastAnalyticsRequest()).toContain('to=2026-09-30'));
  });

  it('sends no range that ends before it starts, rather than turning the panel into an error', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({ campaigns: [clarity] });
    await openPlanner();

    fireEvent.change(within(panel()).getByLabelText('From'), { target: { value: '2026-09-30' } });
    await waitFor(() => expect(lastAnalyticsRequest()).toContain('from=2026-09-30'));
    fireEvent.change(within(panel()).getByLabelText('To'), { target: { value: '2026-09-01' } });
    await waitFor(() => expect(within(panel()).getByLabelText('To')).toHaveValue('2026-09-01'));
    expect(lastAnalyticsRequest()).not.toContain('to=');
  });

  it('clears every filter at once and leaves the planner’s own parameters alone', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({ campaigns: [clarity] });
    await openPlanner(`/signal?month=2026-09&campaigns=${clarity.id}&from=2026-09-01`);

    expect(within(panel()).getByRole('button', { name: 'Clarity Campaign' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(panel()).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(lastAnalyticsRequest()).toBe(''));
    // The month is the planner's, not the panel's, and clearing the filters must not move it.
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeInTheDocument();
  });

  it('applies the filters an address arrives with, and ignores a date it cannot read', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({ campaigns: [clarity] });
    await openPlanner(`/signal?month=2026-09&campaigns=${clarity.id}&from=2026-02-31`);

    await waitFor(() => expect(lastAnalyticsRequest()).toContain(`campaigns=${clarity.id}`));
    expect(lastAnalyticsRequest()).not.toContain('from=');
  });

  it('shows a compact trend with a day table behind it, in gains rather than totals', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      groups: [group()],
      scope: { posts: 1, deliveries: 1, measuredDeliveries: 1 },
      totals: { views: 4210, likes: 318, comments: 24, shares: 61 },
      trend: [{ date: '2026-09-15', views: 1210, likes: 118, comments: 4, shares: 11 }],
      campaigns: [clarity],
    });
    await openPlanner();

    fireEvent.click(within(panel()).getByText('One day of history'));
    const table = within(panel()).getByRole('table');
    expect(table).toHaveTextContent('2026-09-15');
    expect(table).toHaveTextContent((1210).toLocaleString());
    expect(table).toHaveTextContent('gained each day');
  });

  it('reports a refused read instead of rendering an empty panel', async () => {
    testState.signalCampaignAnalyticsError = 'The range ends before it starts.';
    await openPlanner();
    expect(await within(panel()).findByRole('alert')).toHaveTextContent(
      'The range ends before it starts.',
    );
  });

  it('says nothing is measured yet when the whole scope has no figures', async () => {
    testState.signalCampaignAnalyticsPayload = emptyCampaignAnalytics({
      groups: [group({ measuredDeliveries: 0, totals: undefined })],
      scope: { posts: 1, deliveries: 1, measuredDeliveries: 0 },
      campaigns: [clarity],
    });
    await openPlanner();
    expect(panel()).toHaveTextContent('there is no total to show');
  });
});
