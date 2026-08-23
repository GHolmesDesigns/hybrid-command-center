import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import type { PublishTarget } from './provider.ts';

export const POST_BRIDGE_PROVIDER = 'post-bridge';

export interface ProviderAccountIdentity {
  id: number;
  provider: string;
  accountRef: string;
  platform: string;
  name: string;
  handle: string;
  resolvedAt: string;
}

interface AccountRow {
  id: number;
  provider: string;
  provider_account_ref: string;
  platform: string;
  display_name: string;
  handle: string;
  resolved_at: string;
}

const toIdentity = (row: AccountRow): ProviderAccountIdentity => ({
  id: row.id,
  provider: row.provider,
  accountRef: row.provider_account_ref,
  platform: row.platform,
  name: row.display_name,
  handle: row.handle,
  resolvedAt: row.resolved_at,
});

const nonEmpty = (value: string, field: string): string => {
  if (!value || value.trim() !== value)
    throw new Error(`${field} must be non-empty and untrimmed.`);
  return value;
};

/** Reads one provider-qualified account. The provider reference is compared as text, exactly. */
export function providerAccountByIdentity(
  db: Db,
  provider: string,
  accountRef: string,
): ProviderAccountIdentity | undefined {
  const row = db
    .prepare(
      `SELECT id,provider,provider_account_ref,platform,display_name,handle,resolved_at
         FROM signal_provider_accounts
        WHERE provider=? AND provider_account_ref=?`,
    )
    .get(provider, accountRef) as AccountRow | undefined;
  return row ? toIdentity(row) : undefined;
}

/** Reads identities by local surrogate, preserving the caller's order. */
export function providerAccountsByIds(db: Db, ids: readonly number[]): ProviderAccountIdentity[] {
  const find = db.prepare(
    `SELECT id,provider,provider_account_ref,platform,display_name,handle,resolved_at
       FROM signal_provider_accounts WHERE id=?`,
  );
  return ids.flatMap((id) => {
    const row = find.get(id) as AccountRow | undefined;
    return row ? [toIdentity(row)] : [];
  });
}

/**
 * Resolves provider listings to local surrogates and refreshes their display metadata atomically.
 *
 * The account reference is never coerced, hashed, truncated, or inferred from a handle. A numeric
 * id supplied by the legacy Post Bridge adapter is only a preferred *local* surrogate; if that
 * surrogate is already occupied, SQLite allocates another and the opaque reference remains intact.
 */
export function resolveProviderAccounts(
  db: Db,
  targets: readonly PublishTarget[],
  clock: () => Date = () => new Date(),
): (PublishTarget & { provider: string; accountRef: string })[] {
  const timestamp = clock().toISOString();
  return transaction(db, () => {
    const byIdentity = db.prepare(
      'SELECT id FROM signal_provider_accounts WHERE provider=? AND provider_account_ref=?',
    );
    const idTaken = db.prepare('SELECT 1 AS present FROM signal_provider_accounts WHERE id=?');
    const insertPreferred = db.prepare(
      `INSERT INTO signal_provider_accounts(
         id,provider,provider_account_ref,platform,display_name,handle,
         resolved_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    const insert = db.prepare(
      `INSERT INTO signal_provider_accounts(
         provider,provider_account_ref,platform,display_name,handle,
         resolved_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    const update = db.prepare(
      `UPDATE signal_provider_accounts
          SET platform=?,display_name=?,handle=?,resolved_at=?,updated_at=?
        WHERE id=?`,
    );

    return targets.map((target) => {
      const provider = nonEmpty(target.provider ?? POST_BRIDGE_PROVIDER, 'provider');
      const accountRef = nonEmpty(target.accountRef ?? String(target.id), 'provider account ref');
      let id = (byIdentity.get(provider, accountRef) as { id: number } | undefined)?.id;
      if (id === undefined) {
        const preferred =
          Number.isSafeInteger(target.id) && target.id > 0 && !idTaken.get(target.id)
            ? target.id
            : undefined;
        if (preferred !== undefined) {
          insertPreferred.run(
            preferred,
            provider,
            accountRef,
            target.platform,
            target.name,
            target.handle,
            timestamp,
            timestamp,
            timestamp,
          );
          id = preferred;
        } else {
          const result = insert.run(
            provider,
            accountRef,
            target.platform,
            target.name,
            target.handle,
            timestamp,
            timestamp,
            timestamp,
          );
          id = Number(result.lastInsertRowid);
        }
      } else {
        update.run(target.platform, target.name, target.handle, timestamp, timestamp, id);
      }
      return { ...target, id, provider, accountRef };
    });
  });
}
