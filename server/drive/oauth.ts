/**
 * The authorization half of a Drive connection: minting the `state` a connect starts with,
 * and consuming it exactly once when Google sends the browser back to the callback.
 *
 * Pending authorizations live in `oauth_pending_states`, one row per connect attempt — not a
 * single settings value. Two authenticated devices can therefore hold independent pending
 * states without overwriting each other. Each row carries the PKCE verifier and, when operator
 * authentication is on, the session token hash that started it; the callback must present that
 * same session, and the row is deleted before the code is exchanged so a replay finds nothing.
 *
 * Scope is `drive.file` only. Existing folders the app did not create become reachable only
 * after the operator selects them in Google Picker (Settings), which attaches them to this
 * grant. Restoring an old full-Drive token ciphertext is not a scope migration — reconnect.
 */
import crypto from 'node:crypto';
import { google, type Auth } from 'googleapis';
import { DRIVE_OAUTH_SCOPE } from '../../shared/drive-oauth.ts';
import type { Db } from '../db.ts';

export { DRIVE_OAUTH_SCOPE };

/**
 * Fresh-install / additive CREATE. Exported so `server/db.ts` can paste the same SQL into
 * `tableSchema` without a second definition drifting.
 */
export const OAUTH_PENDING_STATES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oauth_pending_states (
  state TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  session_token_hash TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
)`;

/**
 * The obsolete single settings row from before C52. Boot deletes it so a leftover value cannot
 * be mistaken for a live pending authorization.
 */
export const OAUTH_STATE_SETTINGS_KEY = 'oauth_state';

/**
 * How long a minted state stays usable. Long enough for a consent screen the user reads,
 * a Google account chooser, and a slow redirect; short enough that a state left behind by an
 * abandoned connect is not still waiting days later.
 */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Why a callback was refused. Never reaches the browser — the response says only that it was. */
export class OAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthStateError';
  }
}

export type PendingAuthorization = {
  state: string;
  verifier: string;
  sessionTokenHash: string | null;
  issuedAt: string;
  expiresAt: string;
};

type PendingRow = {
  state: string;
  verifier: string;
  session_token_hash: string | null;
  issued_at: string;
  expires_at: string;
};

/** 32 random bytes as base64url — 43 characters, the shortest verifier RFC 7636 allows. */
const mintVerifier = () => crypto.randomBytes(32).toString('base64url');

/** The `S256` transformation from RFC 7636 §4.2. */
const challengeFor = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

/** Constant-time comparison, so a mismatch does not leak where it stopped matching. */
function sameSecret(a: string, b: string) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const toPending = (row: PendingRow): PendingAuthorization => ({
  state: row.state,
  verifier: row.verifier,
  sessionTokenHash: row.session_token_hash,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
});

/** Drop expired (and the obsolete settings key) so abandoned connects do not accumulate. */
export function purgeExpiredAuthorizations(db: Db, now: Date = new Date()): number {
  db.prepare('DELETE FROM settings WHERE key = ?').run(OAUTH_STATE_SETTINGS_KEY);
  const result = db
    .prepare('DELETE FROM oauth_pending_states WHERE expires_at <= ?')
    .run(now.toISOString());
  return Number(result.changes ?? 0);
}

/**
 * Mints a state and a PKCE verifier for one connect attempt and stores them as their own row.
 * When `sessionTokenHash` is set, only that session may complete the callback.
 */
export function beginAuthorization(
  db: Db,
  now: Date,
  options: { sessionTokenHash?: string | null } = {},
) {
  purgeExpiredAuthorizations(db, now);
  const state = crypto.randomUUID();
  const verifier = mintVerifier();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS).toISOString();
  const sessionTokenHash = options.sessionTokenHash ?? null;

  db.prepare(
    `INSERT INTO oauth_pending_states (state, verifier, session_token_hash, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(state, verifier, sessionTokenHash, issuedAt, expiresAt);

  return { state, challenge: challengeFor(verifier) };
}

/**
 * Consumes the pending authorization for `state`, or throws `OAuthStateError`.
 *
 * On a match the row is deleted before the caller exchanges anything, which is what makes the
 * callback single-use. A state bound to a session refuses any other session (or none). A state
 * that does not match deliberately leaves every other pending row alone.
 */
export function consumeAuthorization(
  db: Db,
  state: unknown,
  now: Date,
  options: { sessionTokenHash?: string | null } = {},
): PendingAuthorization {
  if (typeof state !== 'string' || !state)
    throw new OAuthStateError('the state does not match a pending authorization');

  const row = db
    .prepare(
      'SELECT state, verifier, session_token_hash, issued_at, expires_at FROM oauth_pending_states WHERE state = ?',
    )
    .get(state) as PendingRow | undefined;

  if (!row) throw new OAuthStateError('no authorization is pending for that state');

  const callerHash = options.sessionTokenHash ?? null;
  if (row.session_token_hash !== null) {
    if (callerHash === null || !sameSecret(callerHash, row.session_token_hash)) {
      throw new OAuthStateError('the pending authorization belongs to another session');
    }
  }

  // Delete before expiry checks so an expired or replayed state cannot be retried.
  db.prepare('DELETE FROM oauth_pending_states WHERE state = ?').run(state);

  const nowMs = now.getTime();
  const issuedMs = Date.parse(row.issued_at);
  const expiresMs = Date.parse(row.expires_at);
  /**
   * A negative age means the clock moved backwards between minting and the callback, which
   * leaves the age unusable rather than small. Refusing costs the user one more click on
   * Connect; accepting would mean a stamp in the future never expires at all.
   */
  if (Number.isNaN(issuedMs) || Number.isNaN(expiresMs) || nowMs < issuedMs || nowMs > expiresMs) {
    throw new OAuthStateError('the pending authorization has expired');
  }

  return toPending(row);
}

/** Look up a pending row by state without consuming it (tests). */
export function readPendingAuthorization(db: Db, state: string): PendingAuthorization | undefined {
  const row = db
    .prepare(
      'SELECT state, verifier, session_token_hash, issued_at, expires_at FROM oauth_pending_states WHERE state = ?',
    )
    .get(state) as PendingRow | undefined;
  return row ? toPending(row) : undefined;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * The two authorization-server calls a connect makes, behind an interface, so the callback can
 * be exercised end to end against the mock in `mock-provider.ts`. Automated tests never contact
 * Google (`AGENTS.md`), and the PKCE verifier reaching the exchange is only assertable if
 * something in a test can see the exchange happen.
 */
export interface OAuthAuthorizationClient {
  authorizationUrl(input: { state: string; challenge: string }): string;
  exchange(input: { code: string; verifier: string }): Promise<Auth.Credentials>;
}

/** The real client: Google's OAuth2 helper, given the PKCE parameters on both calls. */
export function createGoogleOAuthClient(credentials: OAuthCredentials): OAuthAuthorizationClient {
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
        scope: [DRIVE_OAUTH_SCOPE],
        state,
        code_challenge_method: 'S256' as Auth.CodeChallengeMethod,
        code_challenge: challenge,
      }),
    exchange: async ({ code, verifier }) => {
      const { tokens } = await oauth.getToken({ code, codeVerifier: verifier });
      return tokens;
    },
  };
}
