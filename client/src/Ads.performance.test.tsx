import {
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  fireEvent,
  App,
  requests,
  testState,
} from './App.test-setup';
import type { AdsPerformanceAccount, AdsPerformanceState } from '../../shared/ads';

const day = (date: string, impressions: number, clicks: number, costMicros: number) => ({
  date,
  impressions,
  clicks,
  costMicros,
  conversions: clicks / 2,
});

const account = (
  customerId: string,
  overrides: Partial<AdsPerformanceAccount> = {},
): AdsPerformanceAccount => ({
  customerId,
  descriptiveName: `Account ${customerId}`,
  currencyCode: 'USD',
  timeZone: 'America/New_York',
  approved: true,
  client: null,
  stale: null,
  syncedAt: '2026-10-02T12:00:00.000Z',
  window: { startDate: '2026-07-05', endDate: '2026-10-02' },
  campaigns: [],
  ...overrides,
});

const performance = (
  accounts: AdsPerformanceAccount[],
  overrides: Partial<AdsPerformanceState> = {},
): AdsPerformanceState => ({
  connectionStatus: 'CONNECTED',
  lastSync: { at: '2026-10-02T12:00:00.000Z', outcome: 'SUCCESS', error: null },
  lastAttemptFailed: false,
  accounts,
  ...overrides,
});

const usd = account('1111111111', {
  descriptiveName: 'Acme Search',
  client: { id: 'client-acme', name: 'Acme', status: 'ACTIVE' },
  campaigns: [
    {
      campaignId: '1',
      name: 'Spring Search',
      status: 'ENABLED',
      channelType: 'SEARCH',
      days: [day('2026-09-01', 100, 10, 5_000_000), day('2026-09-02', 200, 20, 7_000_000)],
    },
    { campaignId: '2', name: 'Paused Display', status: 'PAUSED', channelType: 'DISPLAY', days: [] },
  ],
});
const eur = account('2222222222', {
  descriptiveName: 'Berlin Brand',
  currencyCode: 'EUR',
  timeZone: 'Europe/Berlin',
  campaigns: [
    {
      campaignId: '3',
      name: 'Brand',
      status: 'ENABLED',
      channelType: 'SEARCH',
      days: [day('2026-09-02', 50, 5, 2_000_000)],
    },
  ],
});

const renderAds = async (path = '/ads') => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Ads performance' })).toBeVisible();
};
const performanceReads = () =>
  requests.filter((request) => request.url.endsWith('/api/ads/performance'));
const refreshes = () =>
  requests.filter((request) => request.url.endsWith('/api/ads/performance/refresh'));

describe('Ads performance page (C259)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the stored snapshot on load and never refreshes by itself', async () => {
    testState.adsPerformancePayload = performance([usd]);
    await renderAds();
    expect(await screen.findByRole('article', { name: 'Account Acme Search' })).toBeVisible();
    expect(performanceReads().length).toBeGreaterThan(0);
    expect(refreshes()).toHaveLength(0);
  });

  it('shows separate totals per currency, the unassigned group, and zone labels', async () => {
    testState.adsPerformancePayload = performance([usd, eur]);
    await renderAds();
    const totals = await screen.findByRole('region', { name: 'Totals for this view' });
    expect(within(totals).getByLabelText('Totals in USD')).toHaveTextContent('300');
    expect(within(totals).getByLabelText('Totals in USD')).toHaveTextContent('$12.00');
    expect(within(totals).getByLabelText('Totals in EUR')).toHaveTextContent('50');
    // No combined amount: exactly one totals block per currency.
    expect(within(totals).getAllByLabelText(/^Totals in /)).toHaveLength(2);

    const unassigned = screen.getByRole('region', { name: 'Client: Unassigned' });
    expect(within(unassigned).getByText(/not mapped to a client/)).toBeVisible();
    const berlin = within(unassigned).getByRole('article', { name: 'Account Berlin Brand' });
    expect(within(berlin).getByText('Time zone Europe/Berlin')).toBeVisible();
    expect(within(berlin).getByText(/account-local/)).toBeVisible();
  });

  it('shows a campaign without metric rows with words and no fabricated zeros', async () => {
    testState.adsPerformancePayload = performance([usd]);
    await renderAds();
    const row = (await screen.findByRole('row', { name: /Paused Display/ })) as HTMLElement;
    expect(within(row).getByText('No metric rows reported')).toBeVisible();
    expect(row).not.toHaveTextContent('0');
  });

  it('has no totals when the chosen range holds no measured day', async () => {
    testState.adsPerformancePayload = performance([usd]);
    await renderAds('/ads?from=2026-10-01&to=2026-10-02');
    expect(
      await screen.findByText(/No measured days in this view, so there are no totals/),
    ).toBeVisible();
    expect(screen.queryByLabelText('Totals in USD')).toBeNull();
    expect(screen.getByText('No measured days in this range')).toBeVisible();
  });

  it('applies the URL filters and falls back defensively on retired values', async () => {
    testState.adsPerformancePayload = performance([usd, eur]);
    await renderAds('/ads?client=client-acme&account=9999999999&from=2026-02-30');
    expect(await screen.findByRole('article', { name: 'Account Acme Search' })).toBeVisible();
    expect(screen.queryByRole('article', { name: 'Account Berlin Brand' })).toBeNull();
    expect(screen.getByText(/does not have, so that filter was not applied/)).toHaveTextContent(
      'account and start date',
    );
  });

  it('narrows to one account when the filter changes', async () => {
    testState.adsPerformancePayload = performance([usd, eur]);
    await renderAds();
    fireEvent.change(await screen.findByLabelText('Account'), {
      target: { value: '2222222222' },
    });
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Account Acme Search' })).toBeNull(),
    );
    expect(screen.getByRole('article', { name: 'Account Berlin Brand' })).toBeVisible();
  });

  it('refreshes only on the button and shows the new snapshot', async () => {
    testState.adsPerformancePayload = performance([usd]);
    await renderAds();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh from Google' }));
    await waitFor(() => expect(refreshes()).toHaveLength(1));
    expect(refreshes()[0].method).toBe('POST');
  });

  it('keeps last-good figures with a stale banner and the last success time when a refresh fails', async () => {
    testState.adsPerformancePayload = performance([usd], {
      lastSync: {
        at: '2026-10-02T15:00:00.000Z',
        outcome: 'FAILURE',
        error: 'Google Ads refused the request.',
      },
      lastAttemptFailed: true,
    });
    await renderAds();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The latest refresh failed, so these figures are stale.');
    expect(alert).toHaveTextContent('Google Ads refused the request.');
    expect(alert).toHaveTextContent('last successful snapshot');
    expect(screen.getByRole('article', { name: 'Account Acme Search' })).toHaveTextContent(
      'Spring Search',
    );
  });

  it('reads a refresh refusal back as the stale banner without clearing the figures', async () => {
    testState.adsPerformancePayload = performance([usd]);
    testState.adsRefreshError = 'Google Ads is rate limiting this app.';
    await renderAds();
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh from Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('rate limiting');
    expect(screen.getByText('Spring Search')).toBeVisible();
  });

  it('says so, and offers no refresh, when Ads is disconnected', async () => {
    testState.adsPerformancePayload = performance([usd], { connectionStatus: 'DISCONNECTED' });
    await renderAds();
    expect(await screen.findByText('Google Ads is not connected.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh from Google' })).toBeDisabled();
    expect(screen.getByText('Spring Search')).toBeVisible();
  });

  it('explains an empty page and links to Settings', async () => {
    testState.adsPerformancePayload = performance([]);
    await renderAds();
    expect(await screen.findByText('No approved Ads accounts')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Settings' })).toBeVisible();
  });

  it('says an approved account has no figures before its first refresh', async () => {
    testState.adsPerformancePayload = performance([
      account('4444444444', { syncedAt: null, window: null }),
    ]);
    await renderAds();
    expect(await screen.findByText(/No figures yet\./)).toBeVisible();
    expect(screen.getByText('Not refreshed yet')).toBeVisible();
  });
});
