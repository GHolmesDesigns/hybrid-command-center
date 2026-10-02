import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ADS_OAUTH_SCOPE } from '../../shared/ads.ts';
import { createApp } from '../app.ts';
import { config } from '../config.ts';
import { createDb, type Db } from '../db.ts';
import { decryptJson } from '../drive/tokens.ts';
import { setSetting, getSetting } from '../drive/service.ts';
import { MockOAuthClient } from '../drive/mock-provider.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { MockAdsOAuthClient } from './mock-oauth.ts';
import { challengeFor } from './oauth.ts';
import { AdsTokenError, decryptAdsRefreshToken, encryptAdsRefreshToken } from './tokens.ts';

const ADS_KEY = 'ads-encryption-key-that-is-32-chars!!';
const DRIVE_KEY = 'drive-encryption-key-that-is-32-chars';
const NOW = new Date('2026-10-02T12:00:00.000Z');
const ads = {
  clientId: 'ads-client-id',
  clientSecret: 'ads-client-secret',
  redirectUri: 'http://localhost:8787/api/ads/oauth/callback',
  encryptionKey: ADS_KEY,
  loginCustomerId: '',
};

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const connectionRow = () =>
  db.prepare(`SELECT * FROM ads_connection WHERE id = 'google-ads'`).get() as
    | {
        status: string;
        scope: string | null;
        refresh_token_encrypted: string | null;
        connected_at: string | null;
      }
    | undefined;
const adsEvents = () => listIntegrationEvents(db, { source: 'google-ads' });

const harness = (overrides: Partial<typeof ads> = {}) => {
  const oauth = new MockAdsOAuthClient();
  const app = createApp(db, {
    adsOauth: () => oauth,
    adsConfig: { ...ads, ...overrides },
    now: () => NOW,
  });
  return { oauth, app };
};
const start = async (app: ReturnType<typeof createApp>) => {
  const { url } = (await request(app).get('/api/ads/oauth/start').expect(200)).body;
  return String(new URL(url).searchParams.get('state'));
};
const callback = (app: ReturnType<typeof createApp>, query: Record<string, string>) =>
  request(app).get('/api/ads/oauth/callback').query(query);
const connect = async (app: ReturnType<typeof createApp>) => {
  const state = await start(app);
  await callback(app, { state, code: 'ads-code' }).expect(302);
};

describe('Ads token storage', () => {
  it('opens only under the Ads key: Drive’s key and a rotated key cannot read it', () => {
    const sealed = encryptAdsRefreshToken('1//refresh-secret-value', ADS_KEY);
    expect(sealed).not.toContain('refresh-secret-value');
    expect(decryptAdsRefreshToken(sealed, ADS_KEY)).toBe('1//refresh-secret-value');
    // Drive's own helper, handed Drive's key, cannot open an Ads ciphertext.
    expect(() => decryptJson(sealed, DRIVE_KEY)).toThrow();
    // The Ads wrapper reports that as one error with no ciphertext or key in it.
    let thrown: unknown;
    try {
      decryptAdsRefreshToken(sealed, DRIVE_KEY);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdsTokenError);
    expect(String((thrown as Error).message)).not.toContain(sealed);
    expect(String((thrown as Error).message)).not.toContain(DRIVE_KEY);
  });

  it('refuses a missing or short Ads key in Ads’ own words, never Drive’s', () => {
    expect(() => encryptAdsRefreshToken('token', '')).toThrow(/GOOGLE_ADS_TOKEN_ENCRYPTION_KEY/);
    expect(() => encryptAdsRefreshToken('token', 'short')).toThrow(/at least 32/);
    expect(() => encryptAdsRefreshToken('token', '')).not.toThrow(/Drive/);
  });
});

describe('Ads connect over HTTP', () => {
  it('reports not configured, names what is missing, and starts nothing', async () => {
    const { app, oauth } = harness({ clientSecret: '', encryptionKey: '' });
    const status = (await request(app).get('/api/ads/status').expect(200)).body;
    expect(status).toMatchObject({
      configured: false,
      status: 'DISCONNECTED',
      missing: ['GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_TOKEN_ENCRYPTION_KEY'],
    });
    await request(app).get('/api/ads/oauth/start').expect(409);
    expect(oauth.authorizations).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM ads_oauth_pending_states').get()).toEqual({ n: 0 });
  });

  it('connects only after the account list succeeds, binds the exchange to PKCE, and stores ciphertext', async () => {
    const { app, oauth } = harness();
    const state = await start(app);
    expect(oauth.authorizations[0].state).toBe(state);

    const response = await callback(app, { state, code: 'ads-code' }).expect(302);
    expect(response.headers.location).toBe(`${config.appOrigin}/settings?ads=connected`);

    expect(challengeFor(oauth.exchanges[0].verifier)).toBe(oauth.authorizations[0].challenge);
    // The list call happened with the access token the exchange returned, before the row existed.
    expect(oauth.listCalls).toEqual(['mock-ads-access-token']);

    const row = connectionRow()!;
    expect(row).toMatchObject({ status: 'CONNECTED', scope: ADS_OAUTH_SCOPE });
    expect(row.refresh_token_encrypted).not.toContain('mock-ads-refresh-token');
    expect(decryptAdsRefreshToken(row.refresh_token_encrypted!, ADS_KEY)).toBe(
      'mock-ads-refresh-token',
    );

    const status = (await request(app).get('/api/ads/status').expect(200)).body;
    expect(status).toMatchObject({ configured: true, status: 'CONNECTED', viaManager: false });
    // No token, ciphertext, or secret reaches the browser or the log.
    const everything = JSON.stringify(status) + JSON.stringify(adsEvents());
    expect(everything).not.toContain('mock-ads-refresh-token');
    expect(everything).not.toContain('mock-ads-access-token');
    expect(everything).not.toContain(row.refresh_token_encrypted!);
    expect(everything).not.toContain(ads.clientSecret);

    expect(adsEvents()).toHaveLength(1);
    expect(adsEvents()[0]).toMatchObject({
      operation: 'ads.connect',
      outcome: 'SUCCESS',
      source: 'google-ads',
    });
    // Connecting approves nothing.
    expect(db.prepare('SELECT COUNT(*) n FROM ads_account_settings').get()).toEqual({ n: 0 });
  });

  it('records the manager login customer ID as a flag only', async () => {
    const { app } = harness({ loginCustomerId: '9998887777' });
    await connect(app);
    const status = (await request(app).get('/api/ads/status')).body;
    expect(status.viaManager).toBe(true);
    expect(JSON.stringify(status)).not.toContain('9998887777');
  });

  it('refuses an unknown, replayed, or cross-grant state with a bare 400 and writes nothing', async () => {
    const { app, oauth } = harness();
    await callback(app, { state: 'never-issued', code: 'x' }).expect(400);

    const state = await start(app);
    await callback(app, { state, code: 'ads-code' }).expect(302);
    await callback(app, { state, code: 'attacker-code' }).expect(400);
    expect(oauth.exchanges).toHaveLength(1);

    // A state Drive minted is not one the Ads callback honours, and the reverse.
    const driveOauth = new MockOAuthClient();
    const driveCredentials = {
      clientId: 'd',
      clientSecret: 'd',
      redirectUri: 'http://localhost:8787/api/drive/oauth/callback',
      encryptionKey: DRIVE_KEY,
    };
    const original = { ...config.google };
    Object.assign(config.google, driveCredentials);
    try {
      const both = createApp(db, {
        oauth: () => driveOauth,
        adsOauth: () => oauth,
        adsConfig: ads,
        now: () => NOW,
      });
      const driveStart = (await request(both).get('/api/drive/oauth/start').expect(200)).body;
      const driveState = String(new URL(driveStart.url).searchParams.get('state'));
      await callback(both, { state: driveState, code: 'x' }).expect(400);
      const adsState = await start(both);
      await request(both)
        .get('/api/drive/oauth/callback')
        .query({ state: adsState, code: 'x' })
        .expect(400);
    } finally {
      Object.assign(config.google, original);
    }
    expect(adsEvents()).toHaveLength(1);
    expect(oauth.exchanges).toHaveLength(1);
  });

  it('refuses an expired state', async () => {
    const oauth = new MockAdsOAuthClient();
    let current = NOW;
    const app = createApp(db, {
      adsOauth: () => oauth,
      adsConfig: ads,
      now: () => current,
    });
    const state = await start(app);
    current = new Date(NOW.getTime() + 11 * 60_000);
    await callback(app, { state, code: 'late' }).expect(400);
    expect(oauth.exchanges).toHaveLength(0);
    expect(connectionRow()).toBeUndefined();
  });

  it.each([
    ['a provider error', { error: 'access_denied' }, 'denied', {}],
    ['a missing code', {}, 'missing_code', {}],
    ['a refused exchange', { code: 'c' }, 'exchange_failed', { exchangeError: 'invalid_grant' }],
    [
      'no refresh token',
      { code: 'c' },
      'no_refresh_token',
      { grant: { accessToken: 'a', refreshToken: null, scope: ADS_OAUTH_SCOPE } },
    ],
    [
      'a different scope',
      { code: 'c' },
      'scope_mismatch',
      {
        grant: {
          accessToken: 'a',
          refreshToken: 'r',
          scope: 'https://www.googleapis.com/auth/drive.file',
        },
      },
    ],
    [
      'a failed account list',
      { code: 'c' },
      'account_list_failed',
      { listError: 'HTTP 403 ya29.leaked-access-token' },
    ],
  ] as const)(
    'does not connect on %s, and records one redacted failure',
    async (_label, query, reason, setup) => {
      const { app, oauth } = harness();
      Object.assign(oauth, setup);
      const state = await start(app);
      const response = await callback(app, { state, ...query }).expect(302);
      expect(response.headers.location).toBe(
        `${config.appOrigin}/settings?ads=error&reason=${reason}`,
      );
      expect(connectionRow()).toBeUndefined();
      const events = adsEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ operation: 'ads.connect', outcome: 'FAILURE' });
      expect(JSON.stringify(events)).not.toMatch(/ya29|leaked|invalid_grant|mock-ads/);
      expect((await request(app).get('/api/ads/status')).body.status).toBe('DISCONNECTED');
    },
  );

  it('does not mark connected when the account list fails even though the exchange succeeded', async () => {
    const { app, oauth } = harness();
    oauth.listError = 'HTTP 500';
    const state = await start(app);
    await callback(app, { state, code: 'c' }).expect(302);
    expect(oauth.exchanges).toHaveLength(1);
    expect(connectionRow()).toBeUndefined();
  });

  it('leaves a prior connection exactly as it was when a reconnect fails', async () => {
    const { app, oauth } = harness();
    await connect(app);
    const before = connectionRow();

    oauth.listError = 'HTTP 503';
    const state = await start(app);
    await callback(app, { state, code: 'again' }).expect(302);

    expect(connectionRow()).toEqual(before);
    expect((await request(app).get('/api/ads/status')).body.status).toBe('CONNECTED');
    expect(adsEvents().map((event) => event.outcome)).toEqual(['FAILURE', 'SUCCESS']);
  });

  it('replaces the stored credential on a successful reconnect', async () => {
    const { app, oauth } = harness();
    await connect(app);
    const first = connectionRow()!.refresh_token_encrypted;
    oauth.grant = { ...oauth.grant, refreshToken: 'second-refresh-token' };
    await connect(app);
    const row = connectionRow()!;
    expect(row.refresh_token_encrypted).not.toBe(first);
    expect(decryptAdsRefreshToken(row.refresh_token_encrypted!, ADS_KEY)).toBe(
      'second-refresh-token',
    );
    expect(adsEvents()[0].summary).toMatch(/reconnected/);
  });

  it('reports an unreadable saved credential as an error rather than connected', async () => {
    const { app } = harness();
    await connect(app);
    const rotated = createApp(db, {
      adsOauth: () => new MockAdsOAuthClient(),
      adsConfig: { ...ads, encryptionKey: 'a-different-ads-key-also-32-characters-long' },
      now: () => NOW,
    });
    const status = (await request(rotated).get('/api/ads/status')).body;
    expect(status.status).toBe('ERROR');
    expect(status.problem).toMatch(/cannot be read/);
  });

  it('reports a saved connection as an error when the Ads key is no longer configured', async () => {
    const { app } = harness();
    await connect(app);
    const keyless = createApp(db, {
      adsOauth: () => new MockAdsOAuthClient(),
      adsConfig: { ...ads, encryptionKey: '' },
      now: () => NOW,
    });
    const status = (await request(keyless).get('/api/ads/status')).body;
    expect(status).toMatchObject({ configured: false, status: 'ERROR' });
    expect(status.problem).toMatch(/encryption key is not configured/);
  });

  it('disconnects locally, records one event, and is a no-op the second time', async () => {
    const { app } = harness();
    await connect(app);
    const first = (await request(app).post('/api/ads/disconnect').expect(200)).body;
    expect(first).toMatchObject({
      ok: true,
      wasConnected: true,
      googleRevocationRequired: true,
    });
    expect(connectionRow()).toMatchObject({
      status: 'DISCONNECTED',
      scope: null,
      refresh_token_encrypted: null,
      connected_at: null,
    });
    expect((await request(app).get('/api/ads/status')).body.status).toBe('DISCONNECTED');

    const second = (await request(app).post('/api/ads/disconnect').expect(200)).body;
    expect(second).toMatchObject({ wasConnected: false, googleRevocationRequired: false });
    expect(adsEvents().map((event) => event.operation)).toEqual(['ads.disconnect', 'ads.connect']);
  });

  it('never touches Drive’s connection, in either direction', async () => {
    const { app } = harness();
    // Seeded after the app exists: the Drive client decrypts a stored token when it is built.
    setSetting(db, 'google_tokens', 'drive-ciphertext');
    setSetting(db, 'drive_root_id', 'root-1');
    await connect(app);
    await request(app).post('/api/ads/disconnect').expect(200);
    expect(getSetting(db, 'google_tokens')).toBe('drive-ciphertext');
    expect(getSetting(db, 'drive_root_id')).toBe('root-1');

    await request(app).post('/api/settings/drive/disconnect').expect(200);
    await connect(app);
    expect(connectionRow()?.status).toBe('CONNECTED');
  });

  it('keeps ad accounts, approvals, and mappings when disconnecting', async () => {
    const { app } = harness();
    await connect(app);
    db.prepare(
      `INSERT INTO ads_account_settings(customer_id,approved,updated_at) VALUES('1234567890',1,?)`,
    ).run(NOW.toISOString());
    await request(app).post('/api/ads/disconnect').expect(200);
    expect(db.prepare('SELECT approved FROM ads_account_settings').get()).toEqual({ approved: 1 });
  });
});
