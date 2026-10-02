import { describe, expect, it } from 'vitest';
import type { AdsPerformanceAccount, AdsPerformanceState } from './ads.ts';
import {
  ADS_CLIENT_UNASSIGNED,
  ADS_NO_FILTERS,
  buildAdsPerformanceView,
  formatAdsCost,
  readAdsFilters,
} from './ads-performance-view.ts';

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

const acme = { id: 'client-acme', name: 'Acme', status: 'ACTIVE' as const };
const state = (accounts: AdsPerformanceAccount[]): AdsPerformanceState => ({
  connectionStatus: 'CONNECTED',
  lastSync: { at: '2026-10-02T12:00:00.000Z', outcome: 'SUCCESS', error: null },
  lastAttemptFailed: false,
  accounts,
});

const usd = account('1111111111', {
  client: acme,
  campaigns: [
    {
      campaignId: '1',
      name: 'Search',
      status: 'ENABLED',
      channelType: 'SEARCH',
      days: [day('2026-09-01', 100, 10, 5_000_000), day('2026-09-02', 200, 20, 7_000_000)],
    },
    { campaignId: '2', name: 'Paused', status: 'PAUSED', channelType: 'DISPLAY', days: [] },
  ],
});
const eur = account('2222222222', {
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

describe('buildAdsPerformanceView', () => {
  it('adds provider days per currency and never across currencies', () => {
    const view = buildAdsPerformanceView(state([usd, eur]), ADS_NO_FILTERS);
    expect(view.currencyTotals.map((entry) => entry.currencyCode)).toEqual(['EUR', 'USD']);
    expect(view.currencyTotals.find((entry) => entry.currencyCode === 'USD')?.totals).toEqual({
      impressions: 300,
      clicks: 30,
      costMicros: 12_000_000,
      conversions: 15,
    });
    expect(
      view.currencyTotals.find((entry) => entry.currencyCode === 'EUR')?.totals.costMicros,
    ).toBe(2_000_000);
  });

  it('puts Unassigned in a group of its own, last, and never hides it', () => {
    const view = buildAdsPerformanceView(state([eur, usd]), ADS_NO_FILTERS);
    expect(view.groups.map((group) => group.key)).toEqual(['client-acme', ADS_CLIENT_UNASSIGNED]);
  });

  it('orders named clients and their accounts by name, with Unassigned after both', () => {
    const beta = { id: 'client-beta', name: 'Beta', status: 'ACTIVE' as const };
    const view = buildAdsPerformanceView(
      state([
        account('5555555555', { descriptiveName: 'Zed', client: acme }),
        eur,
        account('4444444444', { descriptiveName: 'Alpha', client: acme }),
        account('6666666666', { client: beta }),
      ]),
      ADS_NO_FILTERS,
    );
    expect(view.groups.map((group) => group.name)).toEqual(['Acme', 'Beta', 'Unassigned']);
    expect(view.groups[0].accounts.map((row) => row.account.descriptiveName)).toEqual([
      'Alpha',
      'Zed',
    ]);
  });

  it('gives a campaign without metric rows no figures rather than zeros', () => {
    const view = buildAdsPerformanceView(state([usd]), ADS_NO_FILTERS);
    const paused = view.groups[0].accounts[0].campaigns.find(
      (row) => row.campaign.campaignId === '2',
    )!;
    expect(paused.totals).toBeNull();
    expect(paused.neverMeasured).toBe(true);
  });

  it('has no totals at all when the date range holds no measured day', () => {
    const view = buildAdsPerformanceView(state([usd, eur]), {
      ...ADS_NO_FILTERS,
      from: '2026-10-01',
      to: '2026-10-02',
    });
    expect(view.currencyTotals).toEqual([]);
    expect(view.measuredDays).toBe(0);
    expect(view.groups[0].accounts[0].totals).toBeNull();
    // A campaign with rows, none in range, says so differently from one that never had any.
    expect(view.groups[0].accounts[0].campaigns[0].neverMeasured).toBe(false);
  });

  it('applies an inclusive date range to the days summed', () => {
    const view = buildAdsPerformanceView(state([usd]), {
      ...ADS_NO_FILTERS,
      from: '2026-09-02',
      to: '2026-09-02',
    });
    expect(view.currencyTotals[0].totals.impressions).toBe(200);
  });

  it('reports the newest generation in view as the last-good snapshot time', () => {
    const older = account('3333333333', { syncedAt: '2026-10-01T00:00:00.000Z' });
    const view = buildAdsPerformanceView(state([older, usd]), ADS_NO_FILTERS);
    expect(view.snapshotAt).toBe('2026-10-02T12:00:00.000Z');
  });
});

describe('readAdsFilters', () => {
  const accounts = [usd, eur];

  it('applies supported values as written', () => {
    const reading = readAdsFilters(
      new URLSearchParams('client=client-acme&account=1111111111&from=2026-08-01&to=2026-09-30'),
      accounts,
    );
    expect(reading.filters).toEqual({
      client: 'client-acme',
      account: '1111111111',
      from: '2026-08-01',
      to: '2026-09-30',
    });
    expect(reading.ignored).toEqual([]);
  });

  it('accepts the reserved unassigned client', () => {
    expect(readAdsFilters(new URLSearchParams('client=unassigned'), accounts).filters.client).toBe(
      'unassigned',
    );
  });

  it('ignores and reports retired, invalid, and out-of-window values instead of failing', () => {
    const reading = readAdsFilters(
      new URLSearchParams('client=gone&account=9999999999&from=2026-02-30&to=2027-01-01'),
      accounts,
    );
    expect(reading.filters).toEqual(ADS_NO_FILTERS);
    expect(reading.ignored).toEqual(['client', 'account', 'from', 'to']);
  });

  it('ignores an account that is not inside the chosen client', () => {
    const reading = readAdsFilters(
      new URLSearchParams('client=client-acme&account=2222222222'),
      accounts,
    );
    expect(reading.filters.account).toBeNull();
    expect(reading.ignored).toEqual(['account']);
  });

  it('ignores a range that runs backwards', () => {
    const reading = readAdsFilters(new URLSearchParams('from=2026-09-30&to=2026-08-01'), accounts);
    expect(reading.filters.from).toBeNull();
    expect(reading.filters.to).toBeNull();
    expect(reading.ignored).toEqual(['from', 'to']);
  });
});

describe('formatAdsCost', () => {
  it('shows micros in the account currency and survives an unknown code', () => {
    expect(formatAdsCost(12_340_000, 'USD', 'en-US')).toBe('$12.34');
    expect(formatAdsCost(1_000_000, 'ZZZZ', 'en-US')).toBe('1 ZZZZ');
  });
});
