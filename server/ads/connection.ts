/**
 * The Ads connection: what the callback does with a code, what Settings may know about the
 * result, and what disconnecting removes.
 *
 * Connected means one thing here: a refresh token was issued for the Ads scope **and** the
 * account-list call succeeded with it. Every refusal before that point writes nothing but one
 * redacted `integration_events` row, so a prior connection survives a failed reconnect exactly as
 * it was. The row stores ciphertext under the Ads key only; no function here returns a token, and
 * no event carries one.
 */
import {
  ADS_CONNECT_FAILURE_MESSAGE,
  ADS_OAUTH_SCOPE,
  type AdsConnectFailure,
  type AdsConnectionState,
} from '../../shared/ads.ts';
import { adsMissingConfig, type config } from '../config.ts';
import { transaction, type Db } from '../db.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import { consumeAdsAuthorization, type AdsOAuthClient } from './oauth.ts';
import { AdsTokenError, decryptAdsRefreshToken, encryptAdsRefreshToken } from './tokens.ts';

type AdsConfig = typeof config.ads;

interface ConnectionRow {
  status: 'DISCONNECTED' | 'CONNECTED' | 'ERROR';
  scope: string | null;
  refresh_token_encrypted: string | null;
  login_customer_id: string | null;
  connected_at: string | null;
}

const readRow = (db: Db) =>
  db
    .prepare(
      `SELECT status, scope, refresh_token_encrypted, login_customer_id, connected_at
       FROM ads_connection WHERE id = 'google-ads'`,
    )
    .get() as ConnectionRow | undefined;

/**
 * What the browser sees. A stored credential the current key cannot open is reported as an
 * error with the reason, never as connected: the status says what a refresh could actually do.
 */
export function readAdsConnectionState(db: Db, ads: AdsConfig): AdsConnectionState {
  const missing = adsMissingConfig(ads);
  const row = readRow(db);
  const base = {
    configured: missing.length === 0,
    missing,
    connectedAt: null,
    scope: null,
    viaManager: false,
    problem: null,
  };
  if (!row || row.status !== 'CONNECTED' || !row.refresh_token_encrypted)
    return { ...base, status: row?.status === 'ERROR' ? 'ERROR' : 'DISCONNECTED' };
  if (!ads.encryptionKey)
    return {
      ...base,
      status: 'ERROR',
      problem:
        'The Google Ads encryption key is not configured, so the saved connection is unusable.',
    };
  try {
    decryptAdsRefreshToken(row.refresh_token_encrypted, ads.encryptionKey);
  } catch (error) {
    return {
      ...base,
      status: 'ERROR',
      problem: error instanceof AdsTokenError ? error.message : 'The saved connection is unusable.',
    };
  }
  return {
    ...base,
    status: 'CONNECTED',
    connectedAt: row.connected_at,
    scope: row.scope,
    viaManager: Boolean(row.login_customer_id),
  };
}

const recordFailure = (db: Db, failure: AdsConnectFailure) =>
  recordIntegrationEvent(db, {
    source: 'google-ads',
    operation: 'ads.connect',
    outcome: 'FAILURE',
    summary: 'Google Ads connection was not saved.',
    error: ADS_CONNECT_FAILURE_MESSAGE[failure],
  });

export type AdsAuthorizationResult = { ok: true } | { ok: false; reason: AdsConnectFailure };

export interface AdsCallbackQuery {
  state?: unknown;
  code?: unknown;
  error?: unknown;
}

/**
 * Completes one callback. A state that is missing, unknown, expired, replayed, or bound to
 * another session throws `AdsOAuthStateError` before anything else happens and writes nothing:
 * the request is not one this app started, so it does not get to record an event either.
 */
export async function completeAdsAuthorization(
  db: Db,
  input: {
    query: AdsCallbackQuery;
    client: AdsOAuthClient;
    ads: AdsConfig;
    now: Date;
    sessionTokenHash: string | null;
  },
): Promise<AdsAuthorizationResult> {
  const { verifier } = consumeAdsAuthorization(db, input.query.state, input.now, {
    sessionTokenHash: input.sessionTokenHash,
  });
  const fail = (reason: AdsConnectFailure): AdsAuthorizationResult => {
    recordFailure(db, reason);
    return { ok: false, reason };
  };

  if (input.query.error !== undefined) return fail('denied');
  const code = input.query.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > 2048)
    return fail('missing_code');

  let grant;
  try {
    grant = await input.client.exchange({ code, verifier });
  } catch {
    return fail('exchange_failed');
  }
  if (!grant.refreshToken) return fail('no_refresh_token');
  if (!(grant.scope ?? '').split(/\s+/).includes(ADS_OAUTH_SCOPE)) return fail('scope_mismatch');

  let accessible: string[];
  try {
    accessible = await input.client.listAccessibleCustomers(grant.accessToken);
  } catch {
    return fail('account_list_failed');
  }

  let ciphertext: string;
  try {
    ciphertext = encryptAdsRefreshToken(grant.refreshToken, input.ads.encryptionKey);
  } catch {
    return fail('encryption_unavailable');
  }

  const stamp = input.now.toISOString();
  transaction(db, () => {
    const existing = readRow(db);
    db.prepare(
      `INSERT INTO ads_connection(id,status,scope,refresh_token_encrypted,login_customer_id,connected_at,updated_at)
       VALUES('google-ads','CONNECTED',?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status='CONNECTED', scope=excluded.scope,
         refresh_token_encrypted=excluded.refresh_token_encrypted,
         login_customer_id=excluded.login_customer_id, connected_at=excluded.connected_at,
         updated_at=excluded.updated_at`,
    ).run(ADS_OAUTH_SCOPE, ciphertext, input.ads.loginCustomerId || null, stamp, stamp);
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.connect',
      outcome: 'SUCCESS',
      summary: `Google Ads ${existing?.status === 'CONNECTED' ? 'reconnected' : 'connected'}; ${accessible.length} directly accessible ${accessible.length === 1 ? 'account' : 'accounts'}. No account is approved by connecting.`,
    });
  });
  return { ok: true };
}

/**
 * Removes the local credential. Approvals, mappings, and any stored snapshot are other tables and
 * stay where they are; Google's grant is revoked by the person, and the response says so.
 * Returns whether anything was connected, so a repeat disconnect is a no-op that writes nothing.
 */
export function disconnectAds(db: Db, now: Date): { wasConnected: boolean } {
  return transaction(db, () => {
    const row = readRow(db);
    if (!row || (row.status === 'DISCONNECTED' && !row.refresh_token_encrypted))
      return { wasConnected: false };
    db.prepare(
      `UPDATE ads_connection SET status='DISCONNECTED', scope=NULL, refresh_token_encrypted=NULL,
         login_customer_id=NULL, connected_at=NULL, updated_at=? WHERE id='google-ads'`,
    ).run(now.toISOString());
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.disconnect',
      outcome: 'SUCCESS',
      summary: 'Google Ads disconnected locally. The Google grant is revoked separately.',
    });
    return { wasConnected: true };
  });
}
