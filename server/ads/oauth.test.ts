import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADS_OAUTH_SCOPE } from '../../shared/ads.ts';
import { createDb, type Db } from '../db.ts';
import { encryptJson } from '../drive/tokens.ts';
import {
  ADS_OAUTH_STATE_TTL_MS,
  AdsOAuthStateError,
  beginAdsAuthorization,
  challengeFor,
  consumeAdsAuthorization,
  createGoogleAdsOAuthClient,
  purgeExpiredAdsAuthorizations,
} from './oauth.ts';
import { AdsTokenError, decryptAdsRefreshToken, encryptAdsRefreshToken } from './tokens.ts';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const KEY = 'ads-encryption-key-that-is-32-chars!!';
let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

describe('Ads pending authorization', () => {
  it('binds a state to the session that began it and refuses any other', () => {
    const { state } = beginAdsAuthorization(db, NOW, { sessionTokenHash: 'session-a' });
    expect(() =>
      consumeAdsAuthorization(db, state, NOW, { sessionTokenHash: 'session-b' }),
    ).toThrow(AdsOAuthStateError);
    // A refusal on session leaves the row, so the right session can still finish.
    expect(() => consumeAdsAuthorization(db, state, NOW)).toThrow(/another session/);
    const { verifier } = consumeAdsAuthorization(db, state, NOW, { sessionTokenHash: 'session-a' });
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(() =>
      consumeAdsAuthorization(db, state, NOW, { sessionTokenHash: 'session-a' }),
    ).toThrow(/no authorization is pending/);
  });

  it('refuses a non-string state and a clock that moved backwards', () => {
    expect(() => consumeAdsAuthorization(db, undefined, NOW)).toThrow(AdsOAuthStateError);
    const { state } = beginAdsAuthorization(db, NOW);
    expect(() => consumeAdsAuthorization(db, state, new Date(NOW.getTime() - 1000))).toThrow(
      /expired/,
    );
  });

  it('purges only expired states', () => {
    beginAdsAuthorization(db, NOW);
    const later = new Date(NOW.getTime() + ADS_OAUTH_STATE_TTL_MS + 1);
    const fresh = beginAdsAuthorization(db, later);
    expect(purgeExpiredAdsAuthorizations(db, later)).toBe(0); // begin already purged the old one
    expect(() => consumeAdsAuthorization(db, fresh.state, later)).not.toThrow();
  });
});

describe('Ads token edge cases', () => {
  it('refuses an empty token and a ciphertext whose payload is not a refresh token', () => {
    expect(() => encryptAdsRefreshToken('', KEY)).toThrow(AdsTokenError);
    const wrongShape = encryptJson({ other: 1 }, KEY);
    expect(() => decryptAdsRefreshToken(wrongShape, KEY)).toThrow(AdsTokenError);
    expect(() => decryptAdsRefreshToken('not-a-ciphertext', KEY)).toThrow(AdsTokenError);
  });
});

describe('the real Ads OAuth client (no network)', () => {
  const client = createGoogleAdsOAuthClient({
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://localhost:8787/api/ads/oauth/callback',
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the Ads scope only, offline, with PKCE S256 and the state', () => {
    const url = new URL(client.authorizationUrl({ state: 's1', challenge: challengeFor('v') }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe(ADS_OAUTH_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challengeFor('v'));
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/api/ads/oauth/callback',
    );
  });

  it('lists accessible customers with a bearer token and no developer or manager header', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ resourceNames: ['customers/1234567890', 'customers/2222222222'] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await client.listAccessibleCustomers('tok')).toEqual(['1234567890', '2222222222']);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers');
    expect(init.method).toBe('GET');
    expect(Object.keys(init.headers as object)).toEqual(['Authorization']);
  });

  it('treats a missing list as empty, and a refused or malformed answer as failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    expect(await client.listAccessibleCustomers('tok')).toEqual([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 403 })),
    );
    await expect(client.listAccessibleCustomers('tok')).rejects.toThrow(/403/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ resourceNames: ['customers/not-an-id'] })),
    );
    await expect(client.listAccessibleCustomers('tok')).rejects.toThrow();
  });
});
