/**
 * What the `/ads` page shows of the stored performance snapshot: its durable filters, read
 * defensively from the address, and the one derivation the page makes.
 *
 * That derivation is addition of the provider's own daily values over the chosen set — accounts and
 * an account-local date range — kept **separately per currency**. No rate, ratio, or average, and
 * never a sum across currencies. A set with no measured day has no totals at all rather than a row of
 * zeros, the same distinction `shared/signal-campaign-analytics.ts` carries for Signal.
 *
 * It runs on the stored snapshot only. Nothing here can reach the provider.
 */
import { adsDateSchema, type AdsAccountClientRef, type AdsCampaignView } from './ads.ts';
import type { AdsPerformanceAccount, AdsPerformanceState } from './ads.ts';

/** The reserved `client` value for accounts mapped to no client, so **Unassigned** can be asked for. */
export const ADS_CLIENT_UNASSIGNED = 'unassigned';
export const ADS_CLIENT_UNASSIGNED_LABEL = 'Unassigned';

export const ADS_FILTER_PARAMS = ['client', 'account', 'from', 'to'] as const;

export interface AdsFilters {
  /** A client id, {@link ADS_CLIENT_UNASSIGNED}, or null for every client. */
  client: string | null;
  /** A 10-digit customer id, or null for every account in scope. */
  account: string | null;
  /** Inclusive account-local dates inside the stored window, or null for no bound. */
  from: string | null;
  to: string | null;
}

export const ADS_NO_FILTERS: AdsFilters = { client: null, account: null, from: null, to: null };

/** The four provider figures, added. Cost stays in micros, as the provider reports it. */
export interface AdsFigures {
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
}

export const ADS_FIGURES = ['impressions', 'clicks', 'costMicros', 'conversions'] as const;
export const ADS_FIGURE_LABEL: Record<(typeof ADS_FIGURES)[number], string> = {
  impressions: 'Impressions',
  clicks: 'Clicks',
  costMicros: 'Cost',
  conversions: 'Conversions',
};

export interface AdsDateBounds {
  min: string;
  max: string;
}

/** The earliest and latest account-local dates any stored account window covers, or null with none. */
export function adsDateBounds(accounts: AdsPerformanceAccount[]): AdsDateBounds | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const account of accounts) {
    if (!account.window) continue;
    if (min === null || account.window.startDate < min) min = account.window.startDate;
    if (max === null || account.window.endDate > max) max = account.window.endDate;
  }
  return min !== null && max !== null ? { min, max } : null;
}

export interface AdsFilterReading {
  filters: AdsFilters;
  /** Parameters present in the address that were not applied, so the page can say so. */
  ignored: (typeof ADS_FILTER_PARAMS)[number][];
}

const withinBounds = (value: string, bounds: AdsDateBounds) =>
  value >= bounds.min && value <= bounds.max;

/**
 * Reads the four filters from the address. A supported value applies as written; a missing one is the
 * default; an unknown client or account, a date that is not a real day, a date outside the stored
 * window, or a range that runs backwards is **ignored** and reported, never an error. A bookmark made
 * before an account was withdrawn or a window moved on keeps opening.
 */
export function readAdsFilters(
  params: URLSearchParams,
  accounts: AdsPerformanceAccount[],
): AdsFilterReading {
  const filters: AdsFilters = { ...ADS_NO_FILTERS };
  const ignored: AdsFilterReading['ignored'] = [];
  const raw = (name: (typeof ADS_FILTER_PARAMS)[number]) => params.get(name)?.trim() || null;

  const client = raw('client');
  if (client !== null) {
    const known =
      client === ADS_CLIENT_UNASSIGNED
        ? accounts.some((account) => account.client === null)
        : accounts.some((account) => account.client?.id === client);
    if (known) filters.client = client;
    else ignored.push('client');
  }

  const account = raw('account');
  if (account !== null) {
    const match = accounts.find((candidate) => candidate.customerId === account);
    if (match && accountInClient(match, filters.client)) filters.account = account;
    else ignored.push('account');
  }

  const bounds = adsDateBounds(accounts);
  const date = (name: 'from' | 'to') => {
    const value = raw(name);
    if (value === null) return null;
    if (bounds && adsDateSchema.safeParse(value).success && withinBounds(value, bounds))
      return value;
    ignored.push(name);
    return null;
  };
  const from = date('from');
  const to = date('to');
  if (from !== null && to !== null && from > to) ignored.push('from', 'to');
  else {
    filters.from = from;
    filters.to = to;
  }
  return { filters, ignored };
}

function accountInClient(account: AdsPerformanceAccount, client: string | null): boolean {
  if (client === null) return true;
  if (client === ADS_CLIENT_UNASSIGNED) return account.client === null;
  return account.client?.id === client;
}

/** The accounts a filter set leaves in view, before any date is applied. */
export function adsAccountsInScope(
  accounts: AdsPerformanceAccount[],
  filters: AdsFilters,
): AdsPerformanceAccount[] {
  return accounts.filter(
    (account) =>
      accountInClient(account, filters.client) &&
      (filters.account === null || account.customerId === filters.account),
  );
}

export interface AdsCampaignRow {
  campaign: AdsCampaignView;
  /** Day rows the provider reported inside the chosen dates. */
  measuredDays: number;
  /** Null when no day was measured: an absent day is not a measured zero. */
  totals: AdsFigures | null;
  /** The provider reported no day for this campaign anywhere in the stored window. */
  neverMeasured: boolean;
}

export interface AdsAccountRow {
  account: AdsPerformanceAccount;
  campaigns: AdsCampaignRow[];
  measuredDays: number;
  totals: AdsFigures | null;
}

export interface AdsClientGroup {
  /** The client id, or {@link ADS_CLIENT_UNASSIGNED}. */
  key: string;
  client: AdsAccountClientRef | null;
  name: string;
  accounts: AdsAccountRow[];
}

export interface AdsCurrencyTotals {
  currencyCode: string;
  accounts: number;
  measuredDays: number;
  totals: AdsFigures;
}

export interface AdsPerformanceView {
  groups: AdsClientGroup[];
  /** One entry per currency that has a measured day in view; none when nothing is measured. */
  currencyTotals: AdsCurrencyTotals[];
  accountCount: number;
  campaignCount: number;
  measuredDays: number;
  /** The most recent generation any account in view was read at: the last-good snapshot time. */
  snapshotAt: string | null;
}

const zero = (): AdsFigures => ({ impressions: 0, clicks: 0, costMicros: 0, conversions: 0 });
const add = (into: AdsFigures, day: AdsFigures) => {
  for (const figure of ADS_FIGURES) into[figure] += day[figure];
};

function campaignRow(campaign: AdsCampaignView, filters: AdsFilters): AdsCampaignRow {
  const totals = zero();
  let measuredDays = 0;
  for (const day of campaign.days) {
    if (filters.from !== null && day.date < filters.from) continue;
    if (filters.to !== null && day.date > filters.to) continue;
    add(totals, day);
    measuredDays += 1;
  }
  return {
    campaign,
    measuredDays,
    totals: measuredDays > 0 ? totals : null,
    neverMeasured: campaign.days.length === 0,
  };
}

/** Groups the accounts in scope by client — **Unassigned** as a group of its own — and adds per currency. */
export function buildAdsPerformanceView(
  state: AdsPerformanceState,
  filters: AdsFilters,
): AdsPerformanceView {
  const inScope = adsAccountsInScope(state.accounts, filters);
  const groups = new Map<string, AdsClientGroup>();
  const byCurrency = new Map<string, AdsCurrencyTotals>();
  let campaignCount = 0;
  let measuredDays = 0;
  let snapshotAt: string | null = null;

  for (const account of inScope) {
    const campaigns = account.campaigns.map((campaign) => campaignRow(campaign, filters));
    const totals = zero();
    let accountDays = 0;
    for (const row of campaigns) {
      if (!row.totals) continue;
      add(totals, row.totals);
      accountDays += row.measuredDays;
    }
    const row: AdsAccountRow = {
      account,
      campaigns,
      measuredDays: accountDays,
      totals: accountDays > 0 ? totals : null,
    };
    const key = account.client?.id ?? ADS_CLIENT_UNASSIGNED;
    const group = groups.get(key) ?? {
      key,
      client: account.client,
      name: account.client?.name ?? ADS_CLIENT_UNASSIGNED_LABEL,
      accounts: [],
    };
    group.accounts.push(row);
    groups.set(key, group);

    campaignCount += campaigns.length;
    measuredDays += accountDays;
    if (account.syncedAt && (snapshotAt === null || account.syncedAt > snapshotAt))
      snapshotAt = account.syncedAt;
    if (row.totals) {
      const entry = byCurrency.get(account.currencyCode) ?? {
        currencyCode: account.currencyCode,
        accounts: 0,
        measuredDays: 0,
        totals: zero(),
      };
      entry.accounts += 1;
      entry.measuredDays += accountDays;
      add(entry.totals, row.totals);
      byCurrency.set(account.currencyCode, entry);
    }
  }

  // Named clients first, in name order; Unassigned last and always present when it has an account.
  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === ADS_CLIENT_UNASSIGNED) return 1;
    if (b.key === ADS_CLIENT_UNASSIGNED) return -1;
    return a.name.localeCompare(b.name);
  });
  for (const group of ordered)
    group.accounts.sort((a, b) =>
      a.account.descriptiveName.localeCompare(b.account.descriptiveName),
    );

  return {
    groups: ordered,
    currencyTotals: [...byCurrency.values()].sort((a, b) =>
      a.currencyCode.localeCompare(b.currencyCode),
    ),
    accountCount: inScope.length,
    campaignCount,
    measuredDays,
    snapshotAt,
  };
}

/** Cost from micros as the account's own currency. An unrecognized code falls back to the plain code. */
export function formatAdsCost(costMicros: number, currencyCode: string, locale?: string): string {
  const amount = costMicros / 1_000_000;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: currencyCode }).format(
      amount,
    );
  } catch {
    return `${amount.toLocaleString(locale, { maximumFractionDigits: 2 })} ${currencyCode}`;
  }
}
