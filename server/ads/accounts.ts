/**
 * Account discovery and approval (C257).
 *
 * The order of events is the whole safety property:
 *
 * 1. **Listing** asks the provider which customer IDs the grant reaches directly and records them
 *    as *discoverable*. It names no account, reads no metadata, and approves nothing.
 * 2. **Approval** is a person naming one exact ID, twice. Only then is that ID read, once, for its
 *    metadata. A manager or a non-enabled account is refused as a performance target and is never
 *    marked approved; the read that found out is the last one made for it.
 * 3. Everything the provider reports lands in `ads_accounts`; everything a person decided lands in
 *    `ads_account_settings`. Approval upserts the first and never deletes it, so campaigns hanging
 *    off an account cannot be cascaded away, and a later refresh cannot lose a decision.
 *
 * Every provider call completes before the first write, and each operation lands in one transaction
 * with its `integration_events` row. Nothing here is reachable from MCP.
 */
import {
  ADS_TARGET_ISSUE_MESSAGE,
  adsCustomerIdSchema,
  adsTargetIssue,
  type AdsAccountSnapshot,
  type AdsAccountsState,
} from '../../shared/ads.ts';
import type { config } from '../config.ts';
import { transaction, type Db } from '../db.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import { isAdsConnected, readConnectedAdsRefreshToken } from './connection.ts';
import { replaceDiscoveredAdsAccounts } from './discovered.ts';
import { AdsAccountError } from './errors.ts';
import type { AdsProvider } from './provider.ts';
import { readAdsAccounts } from './read.ts';

type AdsConfig = typeof config.ads;

/** A grant reaches a handful of accounts; a list far past this is not one this app should hold. */
const MAX_DISCOVERED = 1000;

const NOT_CONNECTED =
  'Google Ads is not connected, so nothing was read. Connect it in Settings first.';

const adsNameOf = (db: Db, customerId: string) =>
  (
    db
      .prepare('SELECT descriptive_name name FROM ads_accounts WHERE customer_id = ?')
      .get(customerId) as { name: string } | undefined
  )?.name ?? customerId;

/** The access token for one person-initiated read, or the refusal that stops it before any call. */
async function openProviderSession(db: Db, ads: AdsConfig, provider: AdsProvider) {
  const refreshToken = readConnectedAdsRefreshToken(db, ads);
  if (!refreshToken) throw new AdsAccountError(NOT_CONNECTED, 409);
  return provider.accessToken(refreshToken);
}

export async function discoverAdsAccounts(
  db: Db,
  input: { provider: AdsProvider; ads: AdsConfig; now: Date },
): Promise<AdsAccountsState> {
  const fail = (error: unknown): never => {
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.discover',
      outcome: 'FAILURE',
      summary: 'Google Ads accounts were not listed. The previous list is unchanged.',
      error: error instanceof Error ? error.message : 'unknown failure',
    });
    throw new AdsAccountError(
      'Google Ads did not list the accessible accounts, so the previous list is unchanged.',
      502,
    );
  };

  let ids: string[];
  try {
    const accessToken = await openProviderSession(db, input.ads, input.provider);
    ids = await input.provider.listAccessibleCustomers(accessToken);
  } catch (error) {
    if (error instanceof AdsAccountError) throw error;
    return fail(error);
  }
  const parsed = ids.map((id) => adsCustomerIdSchema.safeParse(id));
  if (ids.length > MAX_DISCOVERED || parsed.some((result) => !result.success))
    return fail(new Error('the account list was not in the expected shape'));
  const unique = [...new Set(parsed.map((result) => (result.success ? result.data : '')))];

  transaction(db, () => {
    if (!isAdsConnected(db)) throw new AdsAccountError(NOT_CONNECTED, 409);
    replaceDiscoveredAdsAccounts(db, unique, input.now.toISOString());
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.discover',
      outcome: 'SUCCESS',
      summary: `Listed ${unique.length} directly accessible ${unique.length === 1 ? 'account' : 'accounts'}. Listing approves and reads none of them.`,
    });
  });
  return readAdsAccounts(db);
}

/**
 * Approves one exact serving account, then reads its metadata once. Idempotent: an account that is
 * already approved returns as it is and makes no provider call.
 */
export async function approveAdsAccount(
  db: Db,
  input: {
    customerId: string;
    confirmCustomerId: string;
    provider: AdsProvider;
    ads: AdsConfig;
    now: Date;
  },
): Promise<AdsAccountsState> {
  const { customerId } = input;
  if (input.confirmCustomerId !== customerId)
    throw new AdsAccountError('The confirmation does not match the account being approved.', 400);
  const listed = db
    .prepare('SELECT 1 FROM ads_discovered_accounts WHERE customer_id = ?')
    .get(customerId);
  if (!listed)
    throw new AdsAccountError(
      'This account is not in the list of directly accessible accounts. List accounts again first.',
      404,
    );
  const already = db
    .prepare('SELECT approved FROM ads_account_settings WHERE customer_id = ?')
    .get(customerId) as { approved: number } | undefined;
  if (already?.approved === 1) return readAdsAccounts(db);

  const entity = { type: 'adsAccount', id: customerId, label: customerId } as const;
  let snapshot: AdsAccountSnapshot;
  try {
    const accessToken = await openProviderSession(db, input.ads, input.provider);
    snapshot = await input.provider.readAccount(accessToken, customerId, {
      loginCustomerId: input.ads.loginCustomerId || undefined,
    });
  } catch (error) {
    if (error instanceof AdsAccountError) throw error;
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.approve',
      outcome: 'FAILURE',
      summary: 'An account was not approved because its details could not be read.',
      entities: [entity],
      error: error instanceof Error ? error.message : 'unknown failure',
    });
    throw new AdsAccountError(
      'Google Ads did not return this account’s details, so it was not approved.',
      502,
    );
  }
  if (snapshot.customerId !== customerId)
    throw new AdsAccountError(
      'Google Ads answered for a different account, so nothing was saved.',
      502,
    );

  const issue = adsTargetIssue(snapshot);
  const stamp = input.now.toISOString();
  transaction(db, () => {
    if (!isAdsConnected(db)) throw new AdsAccountError(NOT_CONNECTED, 409);
    // Upsert, never delete-and-insert: campaign rows reference this one with ON DELETE CASCADE.
    db.prepare(
      `INSERT INTO ads_accounts(customer_id,descriptive_name,currency_code,time_zone,manager,status,snapshot_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(customer_id) DO UPDATE SET descriptive_name=excluded.descriptive_name,
         currency_code=excluded.currency_code, time_zone=excluded.time_zone,
         manager=excluded.manager, status=excluded.status, snapshot_at=excluded.snapshot_at`,
    ).run(
      customerId,
      snapshot.descriptiveName,
      snapshot.currencyCode,
      snapshot.timeZone,
      snapshot.manager ? 1 : 0,
      snapshot.status,
      stamp,
    );
    if (issue) {
      recordIntegrationEvent(db, {
        source: 'google-ads',
        operation: 'ads.approve',
        outcome: 'FAILURE',
        summary: `An account was not approved: ${issue === 'MANAGER' ? 'it is a manager account' : 'it is not enabled'}.`,
        entities: [{ ...entity, label: snapshot.descriptiveName }],
        error: ADS_TARGET_ISSUE_MESSAGE[issue],
      });
      return;
    }
    // The client link is deliberately absent from the update: approving again after a withdrawal
    // keeps whatever a person had chosen.
    db.prepare(
      `INSERT INTO ads_account_settings(customer_id,approved,approved_at,client_id,updated_at)
       VALUES(?,1,?,NULL,?)
       ON CONFLICT(customer_id) DO UPDATE SET approved=1, approved_at=excluded.approved_at,
         updated_at=excluded.updated_at`,
    ).run(customerId, stamp, stamp);
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.approve',
      outcome: 'SUCCESS',
      summary:
        'One account was approved for metadata reads. It is Unassigned until a person maps it to a client.',
      entities: [{ ...entity, label: snapshot.descriptiveName }],
    });
  });
  if (issue) throw new AdsAccountError(ADS_TARGET_ISSUE_MESSAGE[issue], 422);
  return readAdsAccounts(db);
}

/**
 * Takes an account back out of reads. Its snapshot and its client link stay: this is a decision
 * about future reads, not a deletion, and approving again restores the same mapping.
 */
export function withdrawAdsAccount(
  db: Db,
  input: { customerId: string; confirmCustomerId: string; now: Date },
): AdsAccountsState {
  if (input.confirmCustomerId !== input.customerId)
    throw new AdsAccountError('The confirmation does not match the account being withdrawn.', 400);
  transaction(db, () => {
    const row = db
      .prepare('SELECT approved FROM ads_account_settings WHERE customer_id = ?')
      .get(input.customerId) as { approved: number } | undefined;
    if (!row || row.approved !== 1) return;
    db.prepare(
      'UPDATE ads_account_settings SET approved=0, approved_at=NULL, updated_at=? WHERE customer_id=?',
    ).run(input.now.toISOString(), input.customerId);
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.approve',
      outcome: 'SUCCESS',
      summary:
        'Approval was withdrawn. Reads for the account stop; its snapshot and client link are kept.',
      entities: [
        { type: 'adsAccount', id: input.customerId, label: adsNameOf(db, input.customerId) },
      ],
    });
  });
  return readAdsAccounts(db);
}
