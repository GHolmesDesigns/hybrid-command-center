import {
  App,
  MemoryRouter,
  branding,
  describe,
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
import type { SignalPublication } from '../../shared/publish';
import type { PostMetricsSummary, PostTargetMetrics } from '../../shared/publish-analytics';
import type { SignalChannel } from '../../shared/signal';

const openPost = async (title: string) => {
  render(
    <MemoryRouter initialEntries={['/signal?month=2026-09']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: `Edit ${title}` }));
};

const publication = (overrides: Partial<SignalPublication> = {}): SignalPublication => ({
  id: 'publication-1',
  postId: 'measured',
  state: 'CONFIRMED',
  provider: 'post-bridge',
  providerPostId: 'provider-1',
  scheduledInstant: '2026-09-13T13:00:00.000Z',
  timezone: 'America/New_York',
  sentCaption: 'A measured campaign post',
  sentMedia: [],
  sentChannels: ['tt'],
  targets: [
    { channel: 'tt', platform: 'tiktok', accountId: 7, handle: '@gholmes', mode: 'AUTOMATIC' },
  ],
  checkAttempts: 1,
  checkedAt: '2026-09-14T10:00:00.000Z',
  createdAt: '2026-09-13T09:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
  ...overrides,
});

const target = (overrides: Partial<PostTargetMetrics> = {}): PostTargetMetrics => ({
  publicationId: 'publication-1',
  accountId: 7,
  channel: 'tt',
  platform: 'tiktok',
  handle: '@gholmes',
  availability: 'AVAILABLE',
  resultId: 'result-tt',
  totals: { views: 4210, likes: 318, comments: 24, shares: 61 },
  days: [
    { date: '2026-09-13', views: 3000, likes: 200, comments: 20, shares: 50 },
    { date: '2026-09-14', views: 4210, likes: 318, comments: 24, shares: 61 },
  ],
  providerSyncedAt: '2026-09-14T11:00:00.000Z',
  syncedAt: '2026-09-14T11:05:00.000Z',
  shareUrl: 'https://tiktok.example/video/1',
  ...overrides,
});

/**
 * A delivery on a channel this provider does not measure.
 *
 * Written as its own builder rather than as the measured one with fields deleted, because the absence
 * of `totals` is the whole claim: an unmeasured channel has no figure, which is not the same shape as
 * a figure of nothing.
 */
const unmeasured = (overrides: Partial<PostTargetMetrics> = {}): PostTargetMetrics => ({
  publicationId: 'publication-1',
  accountId: 4,
  channel: 'x',
  platform: 'twitter',
  handle: '@gholmes',
  availability: 'NOT_AVAILABLE',
  days: [],
  ...overrides,
});

const summary = (overrides: Partial<PostMetricsSummary> = {}): PostMetricsSummary => ({
  postId: 'measured',
  targets: [target()],
  lastSyncedAt: '2026-09-14T11:05:00.000Z',
  refresh: { allowed: true, attempts: 0, exhausted: false },
  ...overrides,
});

/** A dated post with one delivery, so the Delivery section the panel lives in is rendered. */
const seedPost = (title = 'A measured campaign post', channels: SignalChannel[] = ['tt']) => {
  testState.signalPostsPayload = [
    signalPost('measured', title, '2026-09-13', { channels, status: 'PUBLISHED' }),
  ];
  testState.publicationsPayload = [publication({ sentChannels: channels })];
};

const panel = () => screen.findByRole('region', { name: 'Figures' });

/**
 * The figures panel, as a reader meets it.
 *
 * What is checked here is what the page owes the contract: the provider's four numbers shown as
 * numbers, a channel nobody measures saying so instead of showing a zero, the last-synchronised time
 * on screen, and a refresh that happens only because somebody pressed it. The rules behind all of
 * that are exercised in `shared/publish-analytics.test.ts` and `server/publish/analytics.test.ts`.
 */
describe('Signal figures', () => {
  it('shows the provider’s four counts and when they were last synchronised', async () => {
    seedPost();
    testState.postMetricsPayload = summary();
    await openPost('A measured campaign post');

    const figures = await panel();
    // All four figures, in the contract's own order, as a labelled list rather than a sentence.
    expect(
      within(figures)
        .getAllByRole('term')
        .map((term) => term.textContent),
    ).toEqual(['Views', 'Likes', 'Comments', 'Shares']);
    // Grouped by locale, which is the only formatting this app applies to a provider's number.
    expect(within(figures).getAllByText((4210).toLocaleString()).length).toBeGreaterThan(0);
    expect(within(figures).getAllByText((318).toLocaleString()).length).toBeGreaterThan(0);
    expect(figures).toHaveTextContent('Last synchronised');
    expect(figures).toHaveTextContent('Figures refresh only when you ask.');
    expect(within(figures).getByRole('link', { name: /Open it on TikTok/ })).toHaveAttribute(
      'href',
      'https://tiktok.example/video/1',
    );
  });

  it('says a channel this provider does not measure is not available, and shows no zero for it', async () => {
    seedPost('An unmeasured campaign post', ['tt', 'x']);
    testState.postMetricsPayload = summary({
      targets: [target(), unmeasured()],
    });
    await openPost('An unmeasured campaign post');

    const rows = within(await panel()).getAllByRole('listitem');
    expect(rows[1]).toHaveTextContent('Not available from this provider');
    expect(rows[1]).toHaveTextContent('TikTok, YouTube, and Instagram only');
    // The claim the criterion is about: no figure at all, rather than a figure of nothing.
    expect(rows[1]).not.toHaveTextContent('0');
  });

  it('reads on open without refreshing, and refreshes only when asked', async () => {
    seedPost();
    testState.postMetricsPayload = summary({
      targets: [target({ availability: 'AWAITING_SYNC', totals: undefined, days: [] })],
      lastSyncedAt: undefined,
    });
    testState.postMetricsRefreshPayload = summary();
    await openPost('A measured campaign post');

    const figures = await panel();
    expect(figures).toHaveTextContent('No figures yet');
    expect(figures).toHaveTextContent('Not synchronised with the provider yet.');
    // Opening the post read the stored figures and asked for no synchronisation.
    expect(requests.some((entry) => entry.url.endsWith('/metrics'))).toBe(true);
    expect(requests.some((entry) => entry.url.endsWith('/metrics/refresh'))).toBe(false);

    fireEvent.click(within(figures).getByRole('button', { name: /Refresh figures/ }));
    await waitFor(() =>
      expect(requests.filter((entry) => entry.url.endsWith('/metrics/refresh'))).toHaveLength(1),
    );
    expect(await within(await panel()).findByText((4210).toLocaleString())).toBeInTheDocument();
  });

  it('keeps the last figures on screen when the provider is rate-limiting, and stops asking', async () => {
    seedPost();
    testState.postMetricsPayload = summary();
    testState.postMetricsRefreshPayload = summary({
      refresh: {
        allowed: false,
        attempts: 2,
        exhausted: false,
        waitingUntil: '2026-09-14T11:06:00.000Z',
        retryAfterSeconds: 30,
        reason:
          'The provider is rate-limiting synchronisations. Nothing is retried before 2026-09-14T11:06:00.000Z, and the figures below are the last ones it gave.',
      },
    });
    await openPost('A measured campaign post');

    fireEvent.click(within(await panel()).getByRole('button', { name: /Refresh figures/ }));
    const figures = await panel();
    await waitFor(() => expect(figures).toHaveTextContent('rate-limiting synchronisations'));
    // The values that were already read are still the values on screen.
    expect(within(figures).getByText((4210).toLocaleString())).toBeInTheDocument();
    // And the control is closed until the wait has passed, so a reader cannot spend the limit again.
    expect(within(figures).getByRole('button', { name: /Refresh figures/ })).toBeDisabled();
  });

  it('offers no refresh at all for a post nothing measures', async () => {
    seedPost('An unmeasurable campaign post', ['x']);
    testState.postMetricsPayload = summary({
      targets: [unmeasured()],
      lastSyncedAt: undefined,
    });
    await openPost('An unmeasurable campaign post');

    const figures = await panel();
    expect(within(figures).queryByRole('button', { name: /Refresh figures/ })).toBeNull();
  });

  it('shows the daily history as gains rather than as running totals', async () => {
    seedPost();
    testState.postMetricsPayload = summary();
    await openPost('A measured campaign post');

    const figures = await panel();
    // Two snapshots produce one day of gains: the earliest has no previous day to subtract.
    fireEvent.click(within(figures).getByText('One day of history'));
    const history = within(figures).getByRole('table');
    expect(history).toHaveTextContent('2026-09-14');
    // 4210 - 3000 rather than either of the cumulative counts.
    expect(within(history).getByText((1210).toLocaleString())).toBeInTheDocument();
  });

  it('renders nothing for a post with no deliveries at all', async () => {
    testState.signalPostsPayload = [
      signalPost('measured', 'A planned campaign post', '2026-09-13', { channels: ['tt'] }),
    ];
    await openPost('A planned campaign post');
    await screen.findByLabelText('Planning status');
    expect(screen.queryByRole('region', { name: 'Figures' })).toBeNull();
  });
});
