import {
  render,
  screen,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  client,
  requests,
  testState,
} from './App.test-setup';
import type { AdsPerformanceAccount, AdsPerformanceState } from '../../shared/ads';

const acme = client('client-acme', 'Acme Studio');
const other = client('client-other', 'Other Studio');
const archived = client('client-old', 'Old Studio', 'ARCHIVED');
const merged = client('client-dup', 'Dup Studio', 'ARCHIVED', {
  mergedInto: { id: acme.id, name: acme.name, mergedAt: '2026-09-01T00:00:00.000Z' },
});

const account = (
  customerId: string,
  clientRef: AdsPerformanceAccount['client'],
  overrides: Partial<AdsPerformanceAccount> = {},
): AdsPerformanceAccount => ({
  customerId,
  descriptiveName: `Account ${customerId}`,
  currencyCode: 'USD',
  timeZone: 'America/New_York',
  approved: true,
  client: clientRef,
  stale: null,
  syncedAt: '2026-10-02T12:00:00.000Z',
  window: { startDate: '2026-07-05', endDate: '2026-10-02' },
  campaigns: [
    {
      campaignId: customerId,
      name: 'Search',
      status: 'ENABLED',
      channelType: 'SEARCH',
      days: [
        { date: '2026-09-01', impressions: 100, clicks: 10, costMicros: 5_000_000, conversions: 2 },
      ],
    },
  ],
  ...overrides,
});

const ref = (c: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED' }) => ({
  id: c.id,
  name: c.name,
  status: c.status,
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

const renderClient = async (id: string) => {
  testState.clientsPayload = [acme, other, archived, merged];
  render(
    <MemoryRouter initialEntries={[`/clients/${id}`]}>
      <App />
    </MemoryRouter>,
  );
  return screen.findByRole('region', { name: 'Google Ads' });
};

describe('Client detail Ads summary (C260)', () => {
  it("shows this client's account and figures, never another client's, and links to the filtered page", async () => {
    testState.adsPerformancePayload = performance([
      account('1111111111', ref(acme)),
      account('2222222222', ref(other)),
    ]);
    const section = await renderClient(acme.id);
    expect(await within(section).findByText('Account 1111111111')).toBeVisible();
    expect(within(section).queryByText('Account 2222222222')).toBeNull();
    expect(within(section).getByLabelText('Totals in USD')).toHaveTextContent('$5.00');
    expect(within(section).getByRole('link', { name: /Open in Ads/ })).toHaveAttribute(
      'href',
      '/ads?client=client-acme',
    );
    // Rendering is a read of stored data: no refresh request, no write.
    expect(requests.filter((r) => r.url.includes('/ads/performance/refresh'))).toHaveLength(0);
    expect(requests.filter((r) => r.url.includes('/ads/') && r.method !== 'GET')).toHaveLength(0);
  });

  it('says no account is mapped, without totals or an Ads link', async () => {
    testState.adsPerformancePayload = performance([account('2222222222', ref(other))]);
    const section = await renderClient(acme.id);
    expect(await within(section).findByText(/No approved Ads account is mapped/)).toBeVisible();
    expect(within(section).queryByLabelText(/^Totals in/)).toBeNull();
    expect(within(section).queryByRole('link', { name: /Open in Ads/ })).toBeNull();
  });

  it('says a mapped account has no measurements instead of showing zero totals', async () => {
    testState.adsPerformancePayload = performance([
      account('1111111111', ref(acme), { syncedAt: null, window: null, campaigns: [] }),
    ]);
    const section = await renderClient(acme.id);
    expect(await within(section).findByText(/no measured days/)).toBeVisible();
    expect(within(section).queryByLabelText(/^Totals in/)).toBeNull();
    expect(within(section).getAllByText(/Not refreshed yet/).length).toBeGreaterThan(0);
  });

  it('keeps last-good figures visible beside stale and disconnected notices', async () => {
    testState.adsPerformancePayload = performance(
      [account('1111111111', ref(acme), { stale: 'DISCONNECTED' })],
      { connectionStatus: 'DISCONNECTED', lastAttemptFailed: true },
    );
    const section = await renderClient(acme.id);
    expect(await within(section).findByText('Google Ads is not connected.')).toBeVisible();
    expect(within(section).getByRole('alert')).toHaveTextContent('figures are stale');
    expect(within(section).getByLabelText('Totals in USD')).toHaveTextContent('$5.00');
  });

  it('follows an archived client and a merge: the survivor holds the accounts, the source none', async () => {
    testState.adsPerformancePayload = performance([
      account('1111111111', ref(acme)),
      account('3333333333', ref(archived)),
    ]);
    const old = await renderClient(archived.id);
    expect(await within(old).findByText('Account 3333333333')).toBeVisible();
  });

  it('shows a merged-away client no accounts and names where they went', async () => {
    testState.adsPerformancePayload = performance([account('1111111111', ref(acme))]);
    const section = await renderClient(merged.id);
    expect(await within(section).findByText(/merged into Acme Studio/)).toBeVisible();
    expect(within(section).queryByText('Account 1111111111')).toBeNull();
  });
});
