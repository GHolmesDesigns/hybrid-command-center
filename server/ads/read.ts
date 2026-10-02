/**
 * SELECT-only gathering for the accounts list. It holds no provider and has no statement that
 * writes, so opening Settings can never spend API quota or change what a person decided.
 */
import {
  adsTargetIssue,
  type AdsAccountClientRef,
  type AdsAccountView,
  type AdsAccountsState,
  type AdsCampaignView,
  type AdsPerformanceState,
  type AdsConnectionStatus,
  type AdsStaleReason,
} from '../../shared/ads.ts';
import type { Db } from '../db.ts';

interface SnapshotRow {
  customer_id: string;
  descriptive_name: string;
  currency_code: string;
  time_zone: string;
  manager: number;
  status: string;
  snapshot_at: string;
}
interface SettingsRow {
  customer_id: string;
  approved: number;
  approved_at: string | null;
  client_id: string | null;
}

/** The client a link points at, as the list shows it. An archived client keeps its accounts. */
export function readAdsClientRef(db: Db, clientId: string | null): AdsAccountClientRef | null {
  if (!clientId) return null;
  const row = db.prepare('SELECT id, name, status FROM clients WHERE id = ?').get(clientId) as
    AdsAccountClientRef | undefined;
  return row ?? null;
}

export function readAdsAccounts(db: Db): AdsAccountsState {
  const connectionStatus = ((
    db.prepare(`SELECT status FROM ads_connection WHERE id = 'google-ads'`).get() as
      { status: AdsConnectionStatus } | undefined
  )?.status ?? 'DISCONNECTED') as AdsConnectionStatus;

  const discovered = db
    .prepare('SELECT customer_id, discovered_at FROM ads_discovered_accounts')
    .all() as { customer_id: string; discovered_at: string }[];
  const discoveredIds = new Set(discovered.map((row) => row.customer_id));
  const snapshots = new Map(
    (db.prepare('SELECT * FROM ads_accounts').all() as unknown as SnapshotRow[]).map((row) => [
      row.customer_id,
      row,
    ]),
  );
  const settings = new Map(
    (
      db
        .prepare('SELECT customer_id, approved, approved_at, client_id FROM ads_account_settings')
        .all() as unknown as SettingsRow[]
    ).map((row) => [row.customer_id, row]),
  );

  const ids = [...new Set([...discoveredIds, ...snapshots.keys(), ...settings.keys()])].sort();
  const accounts = ids.map((customerId): AdsAccountView => {
    const snapshotRow = snapshots.get(customerId);
    const setting = settings.get(customerId);
    const snapshot = snapshotRow
      ? {
          descriptiveName: snapshotRow.descriptive_name,
          currencyCode: snapshotRow.currency_code,
          timeZone: snapshotRow.time_zone,
          manager: snapshotRow.manager === 1,
          status: snapshotRow.status,
          snapshotAt: snapshotRow.snapshot_at,
        }
      : null;
    const discoveredNow = discoveredIds.has(customerId);
    // A kept snapshot that nothing is refreshing says so. Reads stop; the figures stay.
    const stale: AdsStaleReason | null = !snapshot
      ? null
      : connectionStatus !== 'CONNECTED'
        ? 'DISCONNECTED'
        : !discoveredNow
          ? 'ACCESS_LOST'
          : null;
    return {
      customerId,
      discovered: discoveredNow,
      approved: setting?.approved === 1,
      approvedAt: setting?.approved === 1 ? setting.approved_at : null,
      snapshot,
      stale,
      client: readAdsClientRef(db, setting?.client_id ?? null),
      targetIssue: adsTargetIssue(snapshot),
    };
  });

  return {
    connectionStatus,
    discoveredAt: discovered.map((row) => row.discovered_at).sort()[discovered.length - 1] ?? null,
    accounts,
  };
}

interface CampaignRow {
  customer_id: string;
  campaign_id: string;
  name: string;
  status: string;
  channel_type: string;
}
interface DayRow {
  customer_id: string;
  campaign_id: string;
  date: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
}
interface WindowRow {
  customer_id: string;
  window_start: string;
  window_end: string;
  synced_at: string;
}

/**
 * The stored performance snapshot, for the page that will show it. Local SELECTs only: opening it
 * can never call the provider, spend quota, or change a row. Currency and time zone stay on the
 * account beside its figures and nothing here adds one account's cost to another's.
 */
export function readAdsPerformance(db: Db): AdsPerformanceState {
  const accountsState = readAdsAccounts(db);
  const sync = (db
    .prepare(
      `SELECT last_sync_at, last_sync_outcome, last_sync_error FROM ads_connection WHERE id = 'google-ads'`,
    )
    .get() ?? {}) as {
    last_sync_at?: string | null;
    last_sync_outcome?: 'SUCCESS' | 'FAILURE' | null;
    last_sync_error?: string | null;
  };
  const windows = new Map(
    (db.prepare('SELECT * FROM ads_sync_windows').all() as unknown as WindowRow[]).map((row) => [
      row.customer_id,
      row,
    ]),
  );
  const campaignsByAccount = new Map<string, AdsCampaignView[]>();
  const byKey = new Map<string, AdsCampaignView>();
  for (const row of db
    .prepare('SELECT * FROM ads_campaigns ORDER BY customer_id, campaign_id')
    .all() as unknown as CampaignRow[]) {
    const campaign: AdsCampaignView = {
      campaignId: row.campaign_id,
      name: row.name,
      status: row.status,
      channelType: row.channel_type,
      days: [],
    };
    byKey.set(`${row.customer_id}|${row.campaign_id}`, campaign);
    const list = campaignsByAccount.get(row.customer_id) ?? [];
    list.push(campaign);
    campaignsByAccount.set(row.customer_id, list);
  }
  for (const row of db
    .prepare('SELECT * FROM ads_campaign_days ORDER BY customer_id, campaign_id, date')
    .all() as unknown as DayRow[])
    byKey.get(`${row.customer_id}|${row.campaign_id}`)?.days.push({
      date: row.date,
      impressions: row.impressions,
      clicks: row.clicks,
      costMicros: row.cost_micros,
      conversions: row.conversions,
    });

  return {
    connectionStatus: accountsState.connectionStatus,
    lastSync: {
      at: sync.last_sync_at ?? null,
      outcome: sync.last_sync_outcome ?? null,
      error: sync.last_sync_error ?? null,
    },
    lastAttemptFailed: sync.last_sync_outcome === 'FAILURE',
    // An account appears once a person approved it or a refresh read it; a merely listed ID has no
    // figures and no decision, so it is not here.
    accounts: accountsState.accounts
      .filter(
        (account) => account.snapshot && (account.approved || windows.has(account.customerId)),
      )
      .map((account) => {
        const window = windows.get(account.customerId);
        return {
          customerId: account.customerId,
          descriptiveName: account.snapshot!.descriptiveName,
          currencyCode: account.snapshot!.currencyCode,
          timeZone: account.snapshot!.timeZone,
          approved: account.approved,
          client: account.client,
          stale: account.stale,
          syncedAt: window?.synced_at ?? null,
          window: window ? { startDate: window.window_start, endDate: window.window_end } : null,
          campaigns: campaignsByAccount.get(account.customerId) ?? [],
        };
      }),
  };
}
