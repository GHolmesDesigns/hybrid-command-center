/**
 * The Ads performance refresh (C258).
 *
 * What this suite protects: a refresh replaces the provider-owned snapshot whole under one
 * timestamp or not at all; any failure — a later stream, another account, a bad row, a limit, an
 * unreadable credential — leaves the previous generation byte-identical and says so; a campaign
 * with no activity stays listed and an unreported date never becomes a zero; accounts and
 * currencies stay separate; and what a person decided is never touched. Expected rows are written
 * out here, not read back from the service. Everything runs against `MockAdsProvider`.
 */
import fs from 'node:fs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADS_SYNC_LIMITS,
  ADS_SYNC_MAX_REQUESTS,
  adsSyncWindow,
  type AdsCampaignDay,
  type AdsCampaignSnapshot,
  type AdsPerformanceState,
} from '../../shared/ads.ts';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { MockAdsProvider } from './mock-provider.ts';
import { readAdsPerformance } from './read.ts';
import { refreshAdsPerformance } from './sync.ts';
import { encryptAdsRefreshToken } from './tokens.ts';

const KEY = 'ads-encryption-key-that-is-32-chars!!';
const NOW = new Date('2026-10-02T12:00:00.000Z');
const USD = '1234567890';
const EUR = '4567890123';
const ads = {
  clientId: 'ads-client-id',
  clientSecret: 'ads-client-secret',
  redirectUri: 'http://localhost:8787/api/ads/oauth/callback',
  encryptionKey: KEY,
  loginCustomerId: '',
};

let db: Db;
let provider: MockAdsProvider;

const campaign = (customerId: string, campaignId: string, name: string): AdsCampaignSnapshot => ({
  customerId,
  campaignId,
  name,
  status: 'ENABLED',
  channelType: 'SEARCH',
});
const day = (
  customerId: string,
  campaignId: string,
  date: string,
  impressions: number,
  clicks: number,
  costMicros: number,
  conversions: number,
): AdsCampaignDay => ({
  customerId,
  campaignId,
  date,
  impressions,
  clicks,
  costMicros,
  conversions,
});

beforeEach(() => {
  db = createDb(':memory:');
  provider = new MockAdsProvider();
  provider.accessible = [USD, EUR];
  provider.accounts.set(EUR, {
    customerId: EUR,
    descriptiveName: 'Paris account',
    currencyCode: 'EUR',
    timeZone: 'Europe/Paris',
    manager: false,
    status: 'ENABLED',
  });
  db.prepare(
    `INSERT INTO ads_connection(id,status,scope,refresh_token_encrypted,connected_at,updated_at)
     VALUES('google-ads','CONNECTED','scope',?,?,?)`,
  ).run(encryptAdsRefreshToken('stored-refresh-token', KEY), NOW.toISOString(), NOW.toISOString());
  for (const [id, name, currency, zone] of [
    [USD, 'Agency account', 'USD', 'America/New_York'],
    [EUR, 'Paris account', 'EUR', 'Europe/Paris'],
  ]) {
    db.prepare(
      `INSERT INTO ads_accounts(customer_id,descriptive_name,currency_code,time_zone,manager,status,snapshot_at)
       VALUES(?,?,?,?,0,'ENABLED',?)`,
    ).run(id, name, currency, zone, '2026-10-01T00:00:00.000Z');
    db.prepare('INSERT INTO ads_discovered_accounts(customer_id,discovered_at) VALUES(?,?)').run(
      id,
      '2026-10-01T00:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO ads_account_settings(customer_id,approved,approved_at,client_id,updated_at)
       VALUES(?,1,'2026-10-01T00:00:00.000Z',NULL,'2026-10-01T00:00:00.000Z')`,
    ).run(id);
  }
  // Both accounts carry a campaign with the same ID: identity is account plus campaign.
  provider.campaigns.set(USD, [
    campaign(USD, '42', 'Brand search'),
    campaign(USD, '43', 'Quiet campaign'),
  ]);
  provider.campaigns.set(EUR, [campaign(EUR, '42', 'Recherche marque')]);
  provider.days.set(USD, [
    day(USD, '42', '2026-10-01', 1000, 50, 12_500_000, 2.5),
    day(USD, '42', '2026-10-02', 800, 40, 9_000_000, 0.3333),
  ]);
  provider.days.set(EUR, [day(EUR, '42', '2026-10-02', 300, 10, 4_000_000, 1)]);
});

const refresh = (now = NOW) => refreshAdsPerformance(db, { provider, ads, now });
const TABLES = [
  'ads_accounts',
  'ads_campaigns',
  'ads_campaign_days',
  'ads_sync_windows',
  'ads_account_settings',
  'ads_discovered_accounts',
];
/** Every table a refresh may or may not touch, so "unchanged" means every byte of it. */
const dump = () =>
  JSON.stringify(TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
const syncEvents = () =>
  listIntegrationEvents(db, { source: 'google-ads' }).filter(
    (event) => event.operation === 'ads.sync',
  );
const lastSync = () =>
  db
    .prepare(
      `SELECT last_sync_at at, last_sync_outcome outcome, last_sync_error error FROM ads_connection`,
    )
    .get() as { at: string | null; outcome: string | null; error: string | null };

describe('the 90-day window', () => {
  it("is 90 dates ending on the account's own today, not the UTC date", () => {
    // 02:00 UTC on 2 October is still the evening of 1 October in New York and already the 2nd
    // afternoon in Auckland: a UTC date would drop or repeat a day for one of them.
    const instant = new Date('2026-10-02T02:00:00.000Z');
    expect(adsSyncWindow(instant, 'America/New_York')).toEqual({
      startDate: '2026-07-04',
      endDate: '2026-10-01',
    });
    expect(adsSyncWindow(instant, 'Pacific/Auckland')).toEqual({
      startDate: '2026-07-05',
      endDate: '2026-10-02',
    });
  });

  it('is refused for a time zone that is not one', () => {
    expect(() => adsSyncWindow(NOW, 'Not/AZone')).toThrow();
  });
});

describe('a complete refresh', () => {
  it('stores exactly the reported campaigns and days under one generation, per account', async () => {
    const result = await refresh();
    expect(result).toEqual({
      syncedAt: NOW.toISOString(),
      accounts: 2,
      campaigns: 3,
      days: 3,
      skipped: 0,
    });
    const state = readAdsPerformance(db);
    expect(state.lastAttemptFailed).toBe(false);
    expect(state.lastSync).toEqual({ at: NOW.toISOString(), outcome: 'SUCCESS', error: null });
    expect(
      state.accounts.map((account) => ({
        id: account.customerId,
        currency: account.currencyCode,
        zone: account.timeZone,
        syncedAt: account.syncedAt,
        window: account.window,
        campaigns: account.campaigns.map((c) => [c.campaignId, c.name, c.days]),
      })),
    ).toEqual([
      {
        id: USD,
        currency: 'USD',
        zone: 'America/New_York',
        syncedAt: NOW.toISOString(),
        window: { startDate: '2026-07-05', endDate: '2026-10-02' },
        campaigns: [
          [
            '42',
            'Brand search',
            [
              {
                date: '2026-10-01',
                impressions: 1000,
                clicks: 50,
                costMicros: 12_500_000,
                conversions: 2.5,
              },
              {
                date: '2026-10-02',
                impressions: 800,
                clicks: 40,
                costMicros: 9_000_000,
                conversions: 0.3333,
              },
            ],
          ],
          // Listed with no measured day, and no zero day invented for it.
          ['43', 'Quiet campaign', []],
        ],
      },
      {
        id: EUR,
        currency: 'EUR',
        zone: 'Europe/Paris',
        syncedAt: NOW.toISOString(),
        window: { startDate: '2026-07-05', endDate: '2026-10-02' },
        // The same campaign ID in another account is a different campaign, in its own currency.
        campaigns: [
          [
            '42',
            'Recherche marque',
            [
              {
                date: '2026-10-02',
                impressions: 300,
                clicks: 10,
                costMicros: 4_000_000,
                conversions: 1,
              },
            ],
          ],
        ],
      },
    ]);
    const stamps = db.prepare('SELECT DISTINCT snapshot_at s FROM ads_campaigns').all() as {
      s: string;
    }[];
    expect(stamps).toEqual([{ s: NOW.toISOString() }]);
  });

  it('reads each account in the account-local window and spends three calls per account', async () => {
    await refresh();
    expect(provider.readCalls).toEqual([USD, EUR]);
    expect(provider.campaignCalls).toEqual([USD, EUR]);
    expect(provider.dayCalls.map((call) => call.window)).toEqual([
      { startDate: '2026-07-05', endDate: '2026-10-02' },
      { startDate: '2026-07-05', endDate: '2026-10-02' },
    ]);
    expect(
      provider.readCalls.length + provider.campaignCalls.length + provider.dayCalls.length,
    ).toBe(6);
    expect(ADS_SYNC_MAX_REQUESTS).toBe(ADS_SYNC_LIMITS.accounts * 3);
    expect(provider.accessTokenCalls).toEqual(['stored-refresh-token']);
  });

  it('sends the configured login-customer-id on every read and none when there is none', async () => {
    await refresh();
    expect(new Set(provider.loginCustomerIds)).toEqual(new Set([undefined]));
    provider.loginCustomerIds = [];
    await refreshAdsPerformance(db, {
      provider,
      ads: { ...ads, loginCustomerId: '9999999999' },
      now: NOW,
    });
    expect(new Set(provider.loginCustomerIds)).toEqual(new Set(['9999999999']));
  });

  it('records one redacted SUCCESS event naming the accounts and no campaign', async () => {
    await refresh();
    const events = syncEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'SUCCESS', entityCount: 2 });
    expect(events[0]!.entities.map((entity) => entity.id)).toEqual([USD, EUR]);
    expect(JSON.stringify(events[0])).not.toMatch(
      /Brand search|Quiet campaign|stored-refresh-token/,
    );
  });

  it('leaves approval, mapping, and the encrypted token exactly as a person left them', async () => {
    db.prepare(
      `INSERT INTO clients(id,name,slug,created_at,updated_at) VALUES('c1','Acme','acme','t','t')`,
    ).run();
    db.prepare("UPDATE ads_account_settings SET client_id='c1' WHERE customer_id = ?").run(USD);
    const settings = db.prepare('SELECT * FROM ads_account_settings ORDER BY customer_id').all();
    const token = db.prepare('SELECT refresh_token_encrypted t FROM ads_connection').get();
    const other = db.prepare('SELECT COUNT(*) n FROM integration_events').get() as { n: number };
    await refresh();
    expect(db.prepare('SELECT * FROM ads_account_settings ORDER BY customer_id').all()).toEqual(
      settings,
    );
    expect(db.prepare('SELECT refresh_token_encrypted t FROM ads_connection').get()).toEqual(token);
    // The refresh's one event is the only row it added anywhere.
    expect((db.prepare('SELECT COUNT(*) n FROM integration_events').get() as { n: number }).n).toBe(
      other.n + 1,
    );
  });
});

describe('a refresh that cannot complete', () => {
  const failures: [string, () => void][] = [
    [
      'a metrics stream cut off for the second account',
      () => provider.dayError.set(EUR, 'the stream ended before it was complete'),
    ],
    [
      'a campaign query that fails for the second account',
      () => provider.campaignError.set(EUR, 'HTTP 500'),
    ],
    ['a provider that cannot read an approved account', () => provider.accounts.delete(EUR)],
    [
      'an account that is a manager now',
      () => provider.accounts.set(EUR, { ...provider.accounts.get(EUR)!, manager: true }),
    ],
    [
      'a daily row for a campaign that was never listed',
      () => provider.days.set(USD, [day(USD, '999', '2026-10-01', 1, 1, 1, 1)]),
    ],
    [
      'a daily row outside the requested window',
      () => provider.days.set(USD, [day(USD, '42', '2026-07-04', 1, 1, 1, 1)]),
    ],
    [
      'a daily row after today in the account',
      () => provider.days.set(USD, [day(USD, '42', '2026-10-04', 1, 1, 1, 1)]),
    ],
    [
      'the same campaign day reported twice',
      () =>
        provider.days.set(USD, [
          day(USD, '42', '2026-10-01', 1, 1, 1, 1),
          day(USD, '42', '2026-10-01', 2, 2, 2, 2),
        ]),
    ],
    [
      'a daily row that belongs to another account',
      () => provider.days.set(USD, [day(EUR, '42', '2026-10-01', 1, 1, 1, 1)]),
    ],
    [
      'a row with a negative figure',
      () => provider.days.set(USD, [day(USD, '42', '2026-10-01', -1, 1, 1, 1)]),
    ],
    [
      'a row with a fractional click count',
      () => provider.days.set(USD, [day(USD, '42', '2026-10-01', 1, 1.5, 1, 1)]),
    ],
    [
      'a campaign listed twice',
      () => provider.campaigns.set(USD, [campaign(USD, '42', 'A'), campaign(USD, '42', 'B')]),
    ],
    [
      'more campaigns than one refresh holds',
      () =>
        provider.campaigns.set(
          USD,
          Array.from({ length: ADS_SYNC_LIMITS.campaignsPerAccount + 1 }, (_, i) =>
            campaign(USD, String(i + 1), `c${i}`),
          ),
        ),
    ],
    [
      'an account answering for a different ID',
      () => provider.accounts.set(EUR, { ...provider.accounts.get(EUR)!, customerId: USD }),
    ],
  ];

  it.each(failures)(
    'leaves the previous generation byte-identical and records FAILURE for %s',
    async (_name, breakIt) => {
      await refresh();
      const before = dump();
      // A later generation that would change every figure, if it were allowed to land.
      provider.campaigns.set(USD, [campaign(USD, '42', 'Renamed')]);
      provider.days.set(USD, [day(USD, '42', '2026-10-02', 9, 9, 9, 9)]);
      breakIt();
      const later = new Date('2026-10-03T12:00:00.000Z');
      await expect(refresh(later)).rejects.toMatchObject({ status: 502 });
      expect(dump()).toBe(before);
      const events = syncEvents();
      expect(events[0]).toMatchObject({ outcome: 'FAILURE' });
      expect(events[1]).toMatchObject({ outcome: 'SUCCESS' });
      expect(lastSync()).toMatchObject({ at: later.toISOString(), outcome: 'FAILURE' });
      expect(readAdsPerformance(db).lastAttemptFailed).toBe(true);
    },
  );

  it('keeps the first account out of the database when the second account fails', async () => {
    provider.dayError.set(EUR, 'the stream ended before it was complete');
    await expect(refresh()).rejects.toMatchObject({ status: 502 });
    expect(db.prepare('SELECT COUNT(*) n FROM ads_campaigns').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM ads_campaign_days').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM ads_sync_windows').get()).toEqual({ n: 0 });
    // Account metadata is untouched too: its snapshot is still the approval-time one.
    expect(
      db.prepare('SELECT snapshot_at s FROM ads_accounts WHERE customer_id = ?').get(USD),
    ).toEqual({
      s: '2026-10-01T00:00:00.000Z',
    });
  });

  it('records a FAILURE when the stored credential cannot be read, and calls nothing', async () => {
    db.prepare("UPDATE ads_connection SET refresh_token_encrypted = 'not-a-ciphertext'").run();
    await expect(refresh()).rejects.toMatchObject({ status: 502 });
    expect(provider.accessTokenCalls).toEqual([]);
    expect(provider.readCalls).toEqual([]);
    expect(syncEvents()[0]).toMatchObject({ outcome: 'FAILURE' });
  });

  it('records a FAILURE when more accounts are approved than one refresh may read', async () => {
    for (let i = 0; i <= ADS_SYNC_LIMITS.accounts; i += 1) {
      const id = String(1_000_000_000 + i);
      db.prepare(
        `INSERT INTO ads_account_settings(customer_id,approved,approved_at,updated_at) VALUES(?,1,'t','t')`,
      ).run(id);
      db.prepare('INSERT INTO ads_discovered_accounts(customer_id,discovered_at) VALUES(?,?)').run(
        id,
        't',
      );
    }
    await expect(refresh()).rejects.toMatchObject({ status: 502 });
    expect(provider.readCalls).toEqual([]);
    expect(syncEvents()[0]).toMatchObject({ outcome: 'FAILURE' });
  });

  it('shows no provider words to the caller and scrubs credentials from the log row', async () => {
    provider.dayError.set(USD, 'HTTP 500 {"detail":"Bearer ya29.leaky-token internal"}');
    const error = await refresh().catch((e: unknown) => e as Error);
    expect(String((error as Error).message)).not.toMatch(/ya29|leaky|internal/);
    const row = JSON.stringify([syncEvents(), lastSync()]);
    expect(row).not.toMatch(/ya29\.leaky/);
    expect(syncEvents()[0]!.error).toMatch(/redacted/);
  });

  it('refuses a second refresh while one is reading, spending no extra provider calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = provider.readAccount.bind(provider);
    provider.readAccount = async (...args) => {
      await gate;
      return slow(...args);
    };
    const first = refresh();
    await expect(refresh()).rejects.toMatchObject({ status: 409 });
    release();
    await first;
    expect(provider.readCalls).toEqual([USD, EUR]);
    // The refusal is not a failed refresh and must not read as one.
    expect(syncEvents().map((event) => event.outcome)).toEqual(['SUCCESS']);
  });
});

describe('refusals before any call', () => {
  it('does nothing and records nothing when Ads is disconnected', async () => {
    db.prepare(
      "UPDATE ads_connection SET status='DISCONNECTED', refresh_token_encrypted=NULL",
    ).run();
    await expect(refresh()).rejects.toMatchObject({ status: 409 });
    expect(provider.accessTokenCalls).toEqual([]);
    expect(syncEvents()).toEqual([]);
  });

  it('does nothing when no account is approved', async () => {
    db.prepare('UPDATE ads_account_settings SET approved = 0').run();
    await expect(refresh()).rejects.toMatchObject({ status: 409 });
    expect(provider.accessTokenCalls).toEqual([]);
    expect(syncEvents()).toEqual([]);
  });

  it('reads only approved accounts and leaves an account the grant no longer reaches stale and untouched', async () => {
    await refresh();
    db.prepare('DELETE FROM ads_discovered_accounts WHERE customer_id = ?').run(EUR);
    const eurBefore = JSON.stringify([
      db.prepare('SELECT * FROM ads_campaigns WHERE customer_id = ?').all(EUR),
      db.prepare('SELECT * FROM ads_campaign_days WHERE customer_id = ?').all(EUR),
    ]);
    provider.readCalls = [];
    provider.campaignCalls = [];
    provider.dayCalls = [];
    provider.days.set(EUR, [day(EUR, '42', '2026-10-03', 1, 1, 1, 1)]);
    const result = await refresh(new Date('2026-10-03T12:00:00.000Z'));
    expect(result).toMatchObject({ accounts: 1, skipped: 1 });
    expect(provider.readCalls).toEqual([USD]);
    expect(
      JSON.stringify([
        db.prepare('SELECT * FROM ads_campaigns WHERE customer_id = ?').all(EUR),
        db.prepare('SELECT * FROM ads_campaign_days WHERE customer_id = ?').all(EUR),
      ]),
    ).toBe(eurBefore);
    expect(
      readAdsPerformance(db).accounts.find((account) => account.customerId === EUR),
    ).toMatchObject({ stale: 'ACCESS_LOST', syncedAt: NOW.toISOString() });
  });

  it('never reads an account whose approval was withdrawn', async () => {
    db.prepare('UPDATE ads_account_settings SET approved = 0 WHERE customer_id = ?').run(EUR);
    await refresh();
    expect(provider.readCalls).toEqual([USD]);
    expect(
      db.prepare('SELECT COUNT(*) n FROM ads_campaigns WHERE customer_id = ?').get(EUR),
    ).toEqual({ n: 0 });
  });
});

describe('a later generation', () => {
  it('removes days that fell out of the window and keeps the ones still inside it', async () => {
    provider.days.set(USD, [
      day(USD, '42', '2026-07-05', 10, 1, 100, 0), // the oldest date of the first window
      day(USD, '42', '2026-07-06', 20, 2, 200, 0),
      day(USD, '42', '2026-10-02', 30, 3, 300, 0),
    ]);
    await refresh();
    // Ten days later the window starts on 15 July; the provider is asked for that range and
    // reports only what it holds inside it.
    const later = new Date('2026-10-12T12:00:00.000Z');
    provider.days.set(USD, [
      day(USD, '42', '2026-10-02', 30, 3, 300, 0),
      day(USD, '42', '2026-10-12', 40, 4, 400, 0),
    ]);
    await refresh(later);
    expect(provider.dayCalls.at(-2)!.window).toEqual({
      startDate: '2026-07-15',
      endDate: '2026-10-12',
    });
    expect(
      db.prepare('SELECT date FROM ads_campaign_days WHERE customer_id = ? ORDER BY date').all(USD),
    ).toEqual([{ date: '2026-10-02' }, { date: '2026-10-12' }]);
    expect(
      db
        .prepare('SELECT window_start s, window_end e FROM ads_sync_windows WHERE customer_id = ?')
        .get(USD),
    ).toEqual({
      s: '2026-07-15',
      e: '2026-10-12',
    });
  });

  it('drops a campaign the provider no longer lists with its days, and keeps one that has no day', async () => {
    await refresh();
    provider.campaigns.set(USD, [campaign(USD, '43', 'Quiet campaign')]);
    provider.days.set(USD, []);
    await refresh(new Date('2026-10-03T12:00:00.000Z'));
    expect(
      db.prepare('SELECT campaign_id FROM ads_campaigns WHERE customer_id = ?').all(USD),
    ).toEqual([{ campaign_id: '43' }]);
    expect(
      db.prepare('SELECT COUNT(*) n FROM ads_campaign_days WHERE customer_id = ?').get(USD),
    ).toEqual({ n: 0 });
  });
});

describe('reading the snapshot', () => {
  it('makes no provider call and writes nothing, however often it is read', async () => {
    await refresh();
    const before = dump();
    const calls = provider.readCalls.length + provider.accessTokenCalls.length;
    const app = createApp(db, { adsProvider: () => provider, adsConfig: ads, now: () => NOW });
    for (let i = 0; i < 3; i += 1) {
      const response = await request(app).get('/api/ads/performance');
      expect(response.status).toBe(200);
      expect((response.body as AdsPerformanceState).accounts).toHaveLength(2);
    }
    expect(provider.readCalls.length + provider.accessTokenCalls.length).toBe(calls);
    expect(dump()).toBe(before);
  });

  it('refreshes only through the explicit POST and returns the stored state with the result', async () => {
    const app = createApp(db, { adsProvider: () => provider, adsConfig: ads, now: () => NOW });
    expect((await request(app).get('/api/ads/performance')).body.accounts[0].campaigns).toEqual([]);
    expect(provider.accessTokenCalls).toEqual([]);
    const response = await request(app).post('/api/ads/performance/refresh').send();
    expect(response.status).toBe(200);
    expect(response.body.result).toMatchObject({ accounts: 2, campaigns: 3, days: 3 });
    expect(response.body.performance.accounts[0].campaigns).toHaveLength(2);
  });

  it('answers a failed refresh over HTTP with a 502 and no provider text', async () => {
    provider.dayError.set(USD, 'secret provider detail');
    const app = createApp(db, { adsProvider: () => provider, adsConfig: ads, now: () => NOW });
    const response = await request(app).post('/api/ads/performance/refresh').send();
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toMatch(/secret provider detail/);
  });
});

describe('structure', () => {
  const source = (name: string) => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

  it('keeps the provider read-only: only list and read methods, none that writes', () => {
    const methods = [...source('provider.ts').matchAll(/^ {2}(\w+)\(/gm)].map((match) => match[1]);
    expect(methods).toEqual([
      'accessToken',
      'listAccessibleCustomers',
      'readAccount',
      'readCampaigns',
      'readCampaignDays',
    ]);
  });

  it('keeps read.ts SELECT-only', () => {
    expect(source('read.ts')).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('starts no timer anywhere in the Ads module', () => {
    for (const name of fs.readdirSync(new URL('.', import.meta.url)))
      if (name.endsWith('.ts') && !name.endsWith('.test.ts'))
        expect(source(name), name).not.toMatch(/setInterval|setTimeout|cron/i);
  });
});
