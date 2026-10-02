/**
 * Client <-> ad account linkage (C257).
 *
 * A hash-checked preview and commit, like a client merge: the commit rebuilds the plan inside its
 * own transaction and refuses a confirmation whose plan no longer matches what the workspace holds.
 * The write is one column of one `ads_account_settings` row. It never touches approval, the
 * provider snapshot, another account, Drive, Signal, or `integration_events` — a mapping is local
 * workspace data, like merging two clients.
 */
import crypto from 'node:crypto';
import type { AdsAccountClientRef, AdsMappingPlan, AdsMappingPreview } from '../../shared/ads.ts';
import { transaction, type Db } from '../db.ts';
import { AdsAccountError } from './errors.ts';
import { readAdsClientRef } from './read.ts';

const planHash = (plan: AdsMappingPlan) =>
  crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');

function buildPlan(db: Db, customerId: string, clientId: string | null): AdsMappingPlan {
  const setting = db
    .prepare('SELECT approved, client_id FROM ads_account_settings WHERE customer_id = ?')
    .get(customerId) as { approved: number; client_id: string | null } | undefined;
  if (!setting || setting.approved !== 1)
    throw new AdsAccountError('Approve this account before mapping it to a client.', 409);

  let to: AdsAccountClientRef | null = null;
  if (clientId !== null) {
    to = readAdsClientRef(db, clientId);
    if (!to) throw new AdsAccountError('That client does not exist.', 404);
    // A merged-away client is archived too, so this also keeps a link off a retired record.
    if (to.status !== 'ACTIVE')
      throw new AdsAccountError('An archived client cannot receive a new account link.', 409);
  }
  const from = readAdsClientRef(db, setting.client_id);
  if ((from?.id ?? null) === (to?.id ?? null))
    throw new AdsAccountError(
      to ? 'This account is already mapped to that client.' : 'This account is already unassigned.',
      409,
    );

  const name = db
    .prepare('SELECT descriptive_name name FROM ads_accounts WHERE customer_id = ?')
    .get(customerId) as { name: string } | undefined;
  return {
    customerId,
    accountName: name?.name ?? customerId,
    action: !to ? 'UNASSIGN' : from ? 'REASSIGN' : 'ASSIGN',
    from,
    to,
  };
}

export function previewAdsMapping(
  db: Db,
  customerId: string,
  clientId: string | null,
): AdsMappingPreview {
  const plan = buildPlan(db, customerId, clientId);
  return { ...plan, planHash: planHash(plan) };
}

export function commitAdsMapping(
  db: Db,
  customerId: string,
  clientId: string | null,
  expectedHash: string,
  now: Date,
): AdsMappingPreview & { mappedAt: string } {
  return transaction(db, () => {
    const plan = buildPlan(db, customerId, clientId);
    const hash = planHash(plan);
    if (hash !== expectedHash)
      throw new AdsAccountError(
        'This account or client changed since the mapping was previewed. Review the new preview before confirming.',
        409,
      );
    const stamp = now.toISOString();
    db.prepare('UPDATE ads_account_settings SET client_id=?, updated_at=? WHERE customer_id=?').run(
      plan.to?.id ?? null,
      stamp,
      customerId,
    );
    return { ...plan, planHash: hash, mappedAt: stamp };
  });
}
