import type { Db } from '../db.ts';

/**
 * Replaces the discoverable set whole. A listing is a snapshot of what the grant reached, so an
 * account it no longer reaches is removed here and reads as lost access, rather than staying as an
 * entry nothing is checking. Runs inside the caller's transaction; it opens none of its own.
 */
export function replaceDiscoveredAdsAccounts(
  db: Db,
  customerIds: readonly string[],
  stamp: string,
): void {
  db.prepare('DELETE FROM ads_discovered_accounts').run();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO ads_discovered_accounts(customer_id, discovered_at) VALUES(?, ?)',
  );
  for (const id of customerIds) insert.run(id, stamp);
}
