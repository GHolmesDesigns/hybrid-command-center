/**
 * The authorization half of a Drive connection: minting the `state` a connect starts with,
 * and consuming it exactly once when Google sends the browser back to the callback.
 *
 * This module exists because a consumed state has to be *absent*, not a sentinel. An earlier
 * build overwrote the stored value with the literal string `used` once a connect succeeded,
 * which left `?state=used` a permanently valid callback. The callback is a `GET` on loopback,
 * so any page the user visits could navigate the browser to it carrying someone else's
 * authorization code — and the callback writes `google_tokens`, so the app would quietly end
 * up provisioning client and project folders into that other account. Deleting the row is what
 * closes it: after a connect there is no stored value left to match, guessable or not.
 *
 * Two further properties come with the rewrite:
 *
 * - **A pending authorization ages out.** It carries the time it was issued and is refused
 *   past `OAUTH_STATE_TTL_MS`, so a state minted and abandoned weeks ago is not still live.
 * - **The exchange is bound to the request that started it.** A PKCE verifier is minted beside
 *   the state and kept in the same row, so the authorization code is no longer the only secret
 *   in the token exchange — a code intercepted on its own cannot be redeemed.
 *
 * Both live in the single `oauth_state` settings row, so consuming an authorization drops the
 * state and its verifier in one write and neither can outlive the other.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { google, type Auth } from 'googleapis';
import type { Db } from '../db.ts';
import { deleteSetting, getSetting, setSetting } from './service.ts';

/** The one settings row a pending authorization lives in. Absent means nothing is pending. */
export const OAUTH_STATE_KEY = 'oauth_state';

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

/**
 * Parsed rather than trusted. This module writes the row, but it is a `settings` value like any
 * other: a hand-edited one, or the `used` sentinel an older build left behind, has to fail as a
 * rejected callback rather than as a crash.
 */
const pendingAuthorization = z.object({
  state: z.string().min(1).max(200),
  // RFC 7636 §4.1 bounds a verifier at 43–128 characters.
  verifier: z.string().min(43).max(128),
  issuedAt: z.iso.datetime(),
});
export type PendingAuthorization = z.infer<typeof pendingAuthorization>;

/** 32 random bytes as base64url — 43 characters, the shortest verifier RFC 7636 allows. */
const mintVerifier = () => crypto.randomBytes(32).toString('base64url');

/** The `S256` transformation from RFC 7636 §4.2. */
const challengeFor = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** Constant-time comparison, so a mismatch does not leak where it stopped matching. */
function sameSecret(a: string, b: string) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Mints a state and a PKCE verifier for one connect attempt and stores them, replacing whatever
 * was pending. Returns the two values the authorization URL carries; the verifier stays here.
 */
export function beginAuthorization(db: Db, now: Date) {
  const state = crypto.randomUUID();
  const verifier = mintVerifier();
  const pending: PendingAuthorization = { state, verifier, issuedAt: now.toISOString() };
  setSetting(db, OAUTH_STATE_KEY, JSON.stringify(pending));
  return { state, challenge: challengeFor(verifier) };
}

/**
 * Consumes the pending authorization for `state`, or throws `OAuthStateError`.
 *
 * On a match the row is deleted before the caller exchanges anything, which is what makes the
 * callback single-use: a replay of a state that already succeeded finds nothing stored, and so
 * does a callback carrying `used`, `undefined`, or any other invented value.
 *
 * A state that does *not* match deliberately leaves the row alone. The pending authorization
 * belongs to a browser that has not come back yet, and a stray callback must not be able to
 * cancel the connect the user is in the middle of.
 */
export function consumeAuthorization(db: Db, state: unknown, now: Date): PendingAuthorization {
  const stored = getSetting(db, OAUTH_STATE_KEY);
  if (stored === undefined) throw new OAuthStateError('no authorization is pending');

  const parsed = pendingAuthorization.safeParse(safeJson(stored));
  if (!parsed.success) {
    // Nothing this module wrote, so nothing can ever match it. Drop it rather than leave it.
    deleteSetting(db, OAUTH_STATE_KEY);
    throw new OAuthStateError('the pending authorization is unreadable');
  }

  const pending = parsed.data;
  if (typeof state !== 'string' || !sameSecret(state, pending.state))
    throw new OAuthStateError('the state does not match the pending authorization');

  deleteSetting(db, OAUTH_STATE_KEY);

  /**
   * A negative age means the clock moved backwards between minting and the callback, which
   * leaves the age unusable rather than small. Refusing costs the user one more click on
   * Connect; accepting would mean a stamp in the future never expires at all.
   */
  const age = now.getTime() - Date.parse(pending.issuedAt);
  if (age < 0 || age > OAUTH_STATE_TTL_MS)
    throw new OAuthStateError('the pending authorization has expired');

  return pending;
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
        scope: ['https://www.googleapis.com/auth/drive'],
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
