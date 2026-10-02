/**
 * The authorization half of an Ads connection, kept apart from Drive's.
 *
 * A connect mints a state and a PKCE verifier into `ads_oauth_pending_states`, a table Drive's
 * callback never reads, and the callback consumes the row exactly once before anything is
 * exchanged. The two authorization-server calls and the one account-list call a connect makes sit
 * behind `AdsOAuthClient`, so automated tests run the whole callback against a mock and nothing
 * here can reach Google from CI. The interface has no write method by construction: this module
 * can authorize and list, never change an ad account.
 */
import crypto from 'node:crypto';
import { google, type Auth } from 'googleapis';
import { z } from 'zod';
import { ADS_API_VERSION, ADS_OAUTH_SCOPE } from '../../shared/ads.ts';
import type { Db } from '../db.ts';

/** Ten minutes: a consent screen read slowly, not a state left behind by an abandoned connect. */
export const ADS_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const ADS_REQUEST_TIMEOUT_MS = 30_000;

export class AdsOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdsOAuthStateError';
  }
}

type PendingRow = {
  state: string;
  verifier: string;
  session_token_hash: string | null;
  issued_at: string;
  expires_at: string;
};

export const challengeFor = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

function sameSecret(a: string, b: string) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function purgeExpiredAdsAuthorizations(db: Db, now: Date): number {
  const result = db
    .prepare('DELETE FROM ads_oauth_pending_states WHERE expires_at <= ?')
    .run(now.toISOString());
  return Number(result.changes ?? 0);
}

export function beginAdsAuthorization(
  db: Db,
  now: Date,
  options: { sessionTokenHash?: string | null } = {},
) {
  purgeExpiredAdsAuthorizations(db, now);
  const state = crypto.randomUUID();
  const verifier = crypto.randomBytes(32).toString('base64url');
  db.prepare(
    `INSERT INTO ads_oauth_pending_states (state, verifier, session_token_hash, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    state,
    verifier,
    options.sessionTokenHash ?? null,
    now.toISOString(),
    new Date(now.getTime() + ADS_OAUTH_STATE_TTL_MS).toISOString(),
  );
  return { state, challenge: challengeFor(verifier) };
}

/**
 * Consumes the pending authorization for `state` or throws `AdsOAuthStateError`. The row is
 * deleted before the expiry check and before any exchange, so a replayed or expired state cannot
 * be retried, and a state bound to a session refuses every other session.
 */
export function consumeAdsAuthorization(
  db: Db,
  state: unknown,
  now: Date,
  options: { sessionTokenHash?: string | null } = {},
): { verifier: string } {
  if (typeof state !== 'string' || !state)
    throw new AdsOAuthStateError('the state does not match a pending authorization');
  const row = db
    .prepare(
      'SELECT state, verifier, session_token_hash, issued_at, expires_at FROM ads_oauth_pending_states WHERE state = ?',
    )
    .get(state) as PendingRow | undefined;
  if (!row) throw new AdsOAuthStateError('no authorization is pending for that state');
  const callerHash = options.sessionTokenHash ?? null;
  if (row.session_token_hash !== null) {
    if (callerHash === null || !sameSecret(callerHash, row.session_token_hash))
      throw new AdsOAuthStateError('the pending authorization belongs to another session');
  }
  db.prepare('DELETE FROM ads_oauth_pending_states WHERE state = ?').run(state);
  const nowMs = now.getTime();
  const issuedMs = Date.parse(row.issued_at);
  const expiresMs = Date.parse(row.expires_at);
  if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs) || nowMs < issuedMs || nowMs > expiresMs)
    throw new AdsOAuthStateError('the pending authorization has expired');
  return { verifier: row.verifier };
}

export interface AdsOAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** What a code exchange yields. The access token is used once, for the account list, then dropped. */
export interface AdsGrant {
  accessToken: string;
  refreshToken: string | null;
  /** Space-separated scopes Google reports as granted. */
  scope: string | null;
}

export interface AdsOAuthClient {
  authorizationUrl(input: { state: string; challenge: string }): string;
  exchange(input: { code: string; verifier: string }): Promise<AdsGrant>;
  /** Customer IDs the grant can reach directly. Not a manager hierarchy. */
  listAccessibleCustomers(accessToken: string): Promise<string[]>;
}

const accessibleSchema = z.object({
  resourceNames: z
    .array(z.string().regex(/^customers\/\d{10}$/))
    .max(1000)
    .default([]),
});

export function createGoogleAdsOAuthClient(credentials: AdsOAuthCredentials): AdsOAuthClient {
  const oauth = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri,
  );
  return {
    authorizationUrl: ({ state, challenge }) =>
      oauth.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: [ADS_OAUTH_SCOPE],
        state,
        code_challenge_method: 'S256' as Auth.CodeChallengeMethod,
        code_challenge: challenge,
      }),
    exchange: async ({ code, verifier }) => {
      const { tokens } = await oauth.getToken({ code, codeVerifier: verifier });
      return {
        accessToken: tokens.access_token ?? '',
        refreshToken: tokens.refresh_token ?? null,
        scope: tokens.scope ?? null,
      };
    },
    listAccessibleCustomers: async (accessToken) => {
      // The one Ads call a connect makes. It sends no developer-token header and no
      // login-customer-id: the call lists what the grant reaches directly.
      const response = await fetch(
        `https://googleads.googleapis.com/${ADS_API_VERSION}/customers:listAccessibleCustomers`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(ADS_REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = accessibleSchema.parse(await response.json());
      return parsed.resourceNames.map((name) => name.slice('customers/'.length));
    },
  };
}
