/**
 * SELECT-only gathering for the accounts list. It holds no provider and has no statement that
 * writes, so opening Settings can never spend API quota or change what a person decided.
 */
import {
  adsTargetIssue,
  type AdsAccountClientRef,
  type AdsAccountView,
  type AdsAccountsState,
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
