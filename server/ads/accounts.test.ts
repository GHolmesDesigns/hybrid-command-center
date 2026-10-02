/**
 * Account approval and client mapping (C257).
 *
 * What this suite protects: the provider is never asked about an account before a person approved
 * that exact ID; a manager or non-enabled account never becomes a performance target; a mapping
 * changes one column and nothing else; a stale preview is refused; and a client archive, a client
 * merge, a disconnect, and lost access each leave the local choice and the last snapshot where
 * they were. Everything runs against `MockAdsProvider` — nothing here can reach Google.
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdsAccountView, AdsAccountsState } from '../../shared/ads.ts';
import { MCP_TOOL_REGISTRY } from '../mcp/registry.ts';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { disconnectAds } from './connection.ts';
import { MockAdsProvider } from './mock-provider.ts';
import { encryptAdsRefreshToken } from './tokens.ts';

const KEY = 'ads-encryption-key-that-is-32-chars!!';
const NOW = new Date('2026-10-02T12:00:00.000Z');
const SERVING = '1234567890';
const MANAGER = '2345678901';
const CANCELLED = '3456789012';
const OTHER = '4567890123';
const ads = {
  clientId: 'ads-client-id',
  clientSecret: 'ads-client-secret',
  redirectUri: 'http://localhost:8787/api/ads/oauth/callback',
  encryptionKey: KEY,
  loginCustomerId: '',
};

let db: Db;
let provider: MockAdsProvider;
beforeEach(() => {
  db = createDb(':memory:');
  provider = new MockAdsProvider();
  provider.accessible = [SERVING, MANAGER, CANCELLED, OTHER];
  provider.accounts.set(MANAGER, {
    customerId: MANAGER,
    descriptiveName: 'Agency manager',
    currencyCode: 'USD',
    timeZone: 'America/New_York',
    manager: true,
    status: 'ENABLED',
  });
  provider.accounts.set(CANCELLED, {
    customerId: CANCELLED,
    descriptiveName: 'Old account',
    currencyCode: 'USD',
    timeZone: 'America/New_York',
    manager: false,
    status: 'CANCELED',
  });
  provider.accounts.set(OTHER, {
    customerId: OTHER,
    descriptiveName: 'Second serving account',
    currencyCode: 'EUR',
    timeZone: 'Europe/Paris',
    manager: false,
    status: 'ENABLED',
  });
  db.prepare(
    `INSERT INTO ads_connection(id,status,scope,refresh_token_encrypted,connected_at,updated_at)
     VALUES('google-ads','CONNECTED','scope',?,?,?)`,
  ).run(encryptAdsRefreshToken('stored-refresh-token', KEY), NOW.toISOString(), NOW.toISOString());
});

const app = () => createApp(db, { adsProvider: () => provider, adsConfig: ads, now: () => NOW });
const list = async () => (await request(app()).get('/api/ads/accounts')).body as AdsAccountsState;
const view = async (id: string) =>
  (await list()).accounts.find((account) => account.customerId === id) as AdsAccountView;
const discover = () => request(app()).post('/api/ads/accounts/discover').send();
const approve = (id: string, confirm = id) =>
  request(app()).post(`/api/ads/accounts/${id}/approve`).send({ confirmCustomerId: confirm });
const preview = (id: string, clientId: string | null) =>
  request(app()).post(`/api/ads/accounts/${id}/mapping/preview`).send({ clientId });
const commit = (id: string, clientId: string | null, planHash: string) =>
  request(app()).post(`/api/ads/accounts/${id}/mapping`).send({ clientId, planHash });
/** Preview then confirm, which is the only way the page maps. */
const map = async (id: string, clientId: string | null) => {
  const planned = await preview(id, clientId);
  expect(planned.status).toBe(200);
  const done = await commit(id, clientId, planned.body.planHash);
  expect(done.status).toBe(200);
  return done.body;
};
const createClient = async (name: string) =>
  (await request(app()).post('/api/clients').send({ name })).body as { id: string };

const settingsRows = () =>
  db.prepare('SELECT * FROM ads_account_settings ORDER BY customer_id').all();
const snapshotRows = () => db.prepare('SELECT * FROM ads_accounts ORDER BY customer_id').all();
const adsEvents = () => listIntegrationEvents(db, { source: 'google-ads' });
const eventCount = () =>
  (db.prepare('SELECT COUNT(*) n FROM integration_events').get() as { n: number }).n;

describe('listing and approving accounts', () => {
  it('lists the directly accessible IDs and reads and approves none of them', async () => {
    const response = await discover();
    expect(response.status).toBe(200);
    const accounts = (response.body as AdsAccountsState).accounts;
    expect(accounts.map((account) => account.customerId)).toEqual([
      SERVING,
      MANAGER,
      CANCELLED,
      OTHER,
    ]);
    expect(accounts.every((account) => account.discovered && !account.approved)).toBe(true);
    expect(accounts.every((account) => account.snapshot === null)).toBe(true);
    // The regression this catches: listing quietly reading metadata for what it found.
    expect(provider.listCalls).toHaveLength(1);
    expect(provider.readCalls).toEqual([]);
    expect(settingsRows()).toEqual([]);
    expect(snapshotRows()).toEqual([]);
  });

  it('makes no metadata call before approval, and exactly one for the approved ID afterwards', async () => {
    await discover();
    expect(provider.readCalls).toEqual([]);
    const response = await approve(SERVING);
    expect(response.status).toBe(200);
    expect(provider.readCalls).toEqual([SERVING]);
    const account = await view(SERVING);
    expect(account).toMatchObject({
      approved: true,
      client: null,
      stale: null,
      targetIssue: null,
      snapshot: { descriptiveName: 'Agency account', currencyCode: 'USD', manager: false },
    });
    // The other accounts were not read and are not approved.
    expect(await view(OTHER)).toMatchObject({ approved: false, snapshot: null });
  });

  it('refuses a confirmation naming another ID, an unlisted ID, and a malformed ID without a provider call', async () => {
    await discover();
    expect((await approve(SERVING, OTHER)).status).toBe(400);
    expect((await approve('9999999999')).status).toBe(404);
    expect((await approve('123')).status).toBe(400);
    expect(provider.readCalls).toEqual([]);
    expect(provider.accessTokenCalls).toHaveLength(1); // the listing's, nothing since
    expect(settingsRows()).toEqual([]);
  });

  it('never approves a manager or a cancelled account, and says why', async () => {
    await discover();
    for (const [id, text] of [
      [MANAGER, /manager account/],
      [CANCELLED, /enabled serving account/],
    ] as const) {
      const response = await approve(id);
      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(text);
    }
    expect(settingsRows()).toEqual([]);
    const manager = await view(MANAGER);
    expect(manager).toMatchObject({ approved: false, targetIssue: 'MANAGER' });
    expect(await view(CANCELLED)).toMatchObject({ approved: false, targetIssue: 'NOT_ENABLED' });
    // A refused target can never be mapped either.
    const client = await createClient('Acme');
    expect((await preview(MANAGER, client.id)).status).toBe(409);
    expect(
      adsEvents().filter(
        (event) => event.operation === 'ads.approve' && event.outcome === 'FAILURE',
      ),
    ).toHaveLength(2);
  });

  it('approves a second time without another provider call and leaves one approval', async () => {
    await discover();
    await approve(SERVING);
    await approve(SERVING);
    expect(provider.readCalls).toEqual([SERVING]);
    expect(settingsRows()).toHaveLength(1);
  });

  it('keeps nothing when the provider cannot read the account, and the browser sees no provider words', async () => {
    await discover();
    provider.readError = 'HTTP 500 {"error":"ya29.leaky-token internal detail"}';
    const response = await approve(SERVING);
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toMatch(/ya29|leaky|internal detail/);
    expect(settingsRows()).toEqual([]);
    expect(snapshotRows()).toEqual([]);
    const failure = adsEvents().find((event) => event.operation === 'ads.approve');
    expect(failure).toMatchObject({ outcome: 'FAILURE' });
    expect(JSON.stringify(failure)).not.toMatch(/ya29\.leaky/);
  });

  it('records one event for a listing and one for an approval, with no token in either', async () => {
    await discover();
    await approve(SERVING);
    const events = adsEvents();
    expect(events.map((event) => `${event.operation}:${event.outcome}`).sort()).toEqual([
      'ads.approve:SUCCESS',
      'ads.discover:SUCCESS',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/stored-refresh-token|mock-ads-access-token/);
  });

  it('keeps the previous list when listing fails', async () => {
    await discover();
    provider.listError = 'HTTP 503';
    const response = await discover();
    expect(response.status).toBe(502);
    expect((await list()).accounts).toHaveLength(4);
  });
});

describe('mapping to a client', () => {
  const approvedAndMapped = async () => {
    await discover();
    await approve(SERVING);
    await approve(OTHER);
    const acme = await createClient('Acme');
    const beta = await createClient('Beta');
    return { acme, beta };
  };

  it('previews without writing, then assigns, and shows every account including the unassigned one', async () => {
    const { acme } = await approvedAndMapped();
    const before = settingsRows();
    const planned = await preview(SERVING, acme.id);
    expect(planned.body).toMatchObject({
      action: 'ASSIGN',
      accountName: 'Agency account',
      from: null,
      to: { id: acme.id, name: 'Acme' },
    });
    expect(settingsRows()).toEqual(before);

    await map(SERVING, acme.id);
    expect(await view(SERVING)).toMatchObject({
      client: { id: acme.id, name: 'Acme' },
      approved: true,
    });
    // The other approved account is still listed, unassigned, not hidden.
    expect(await view(OTHER)).toMatchObject({ client: null, approved: true });
  });

  it('reassigns by changing only the local client_id', async () => {
    const { acme, beta } = await approvedAndMapped();
    await map(SERVING, acme.id);
    const settingsBefore = settingsRows() as { customer_id: string; client_id: string | null }[];
    const snapshotsBefore = snapshotRows();
    const eventsBefore = eventCount();
    const driveBefore = db.prepare('SELECT COUNT(*) n FROM drive_steps').get();
    const postsBefore = db.prepare('SELECT COUNT(*) n FROM signal_posts').get();

    const done = await map(SERVING, beta.id);
    expect(done).toMatchObject({
      action: 'REASSIGN',
      from: { name: 'Acme' },
      to: { name: 'Beta' },
    });

    const settingsAfter = settingsRows() as { customer_id: string; client_id: string | null }[];
    const changed = settingsAfter.filter(
      (row, index) => JSON.stringify(row) !== JSON.stringify(settingsBefore[index]),
    );
    expect(changed.map((row) => row.customer_id)).toEqual([SERVING]);
    expect(settingsAfter.find((row) => row.customer_id === SERVING)).toMatchObject({
      client_id: beta.id,
      approved: 1,
    });
    // The other account, the provider snapshot, the activity log, Drive, and Signal did not move.
    expect(settingsAfter.find((row) => row.customer_id === OTHER)).toEqual(
      settingsBefore.find((row) => row.customer_id === OTHER),
    );
    expect(snapshotRows()).toEqual(snapshotsBefore);
    expect(eventCount()).toBe(eventsBefore);
    expect(db.prepare('SELECT COUNT(*) n FROM drive_steps').get()).toEqual(driveBefore);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_posts').get()).toEqual(postsBefore);
    expect(provider.readCalls).toEqual([SERVING, OTHER]);
  });

  it('refuses a stale preview and writes nothing', async () => {
    const { acme, beta } = await approvedAndMapped();
    const planned = await preview(SERVING, acme.id);
    // Another operator maps the account somewhere else after the preview was taken.
    await map(SERVING, beta.id);
    const settingsBefore = settingsRows();
    const refused = await commit(SERVING, acme.id, planned.body.planHash);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/changed since/);
    expect(settingsRows()).toEqual(settingsBefore);
    expect(await view(SERVING)).toMatchObject({ client: { name: 'Beta' } });
  });

  it('refuses a hash taken for a different target', async () => {
    const { acme, beta } = await approvedAndMapped();
    const planned = await preview(SERVING, acme.id);
    expect((await commit(SERVING, beta.id, planned.body.planHash)).status).toBe(409);
    expect(await view(SERVING)).toMatchObject({ client: null });
  });

  it('unassigns to the Unassigned group and keeps the account approved and listed', async () => {
    const { acme } = await approvedAndMapped();
    await map(SERVING, acme.id);
    const done = await map(SERVING, null);
    expect(done).toMatchObject({ action: 'UNASSIGN', to: null });
    expect(await view(SERVING)).toMatchObject({ approved: true, client: null });
  });

  it('refuses an unapproved account, a missing client, an archived client, and a no-op', async () => {
    const { acme } = await approvedAndMapped();
    expect((await preview('9999999999', acme.id)).status).toBe(409);
    expect((await preview(SERVING, 'no-such-client')).status).toBe(404);
    expect((await preview(SERVING, null)).status).toBe(409); // already unassigned
    await map(SERVING, acme.id);
    expect((await preview(SERVING, acme.id)).status).toBe(409); // already there
    const gone = await createClient('Gone');
    await request(app()).post(`/api/clients/${gone.id}/archive`).send();
    expect((await preview(OTHER, gone.id)).status).toBe(409);
  });

  it('keeps the link when the client is archived, and shows the client as archived', async () => {
    const { acme } = await approvedAndMapped();
    await map(SERVING, acme.id);
    await request(app()).post(`/api/clients/${acme.id}/archive`).send();
    expect(await view(SERVING)).toMatchObject({ client: { id: acme.id, status: 'ARCHIVED' } });
    expect(
      db.prepare('SELECT client_id FROM ads_account_settings WHERE customer_id=?').get(SERVING),
    ).toEqual({
      client_id: acme.id,
    });
  });

  it('retargets only the source client’s accounts to the survivor when clients merge, keeping everything else', async () => {
    const { acme, beta } = await approvedAndMapped();
    const survivor = await createClient('Survivor');
    await map(SERVING, acme.id);
    await map(OTHER, beta.id);
    const snapshotsBefore = snapshotRows();
    const otherBefore = (settingsRows() as { customer_id: string }[]).find(
      (row) => row.customer_id === OTHER,
    );

    const planned = await request(app())
      .post(`/api/clients/${acme.id}/merge/preview`)
      .send({ destinationId: survivor.id });
    const merged = await request(app())
      .post(`/api/clients/${acme.id}/merge`)
      .send({ destinationId: survivor.id, planHash: planned.body.planHash });
    expect(merged.status).toBe(200);

    expect(await view(SERVING)).toMatchObject({
      approved: true,
      client: { id: survivor.id, name: 'Survivor' },
    });
    expect(
      (settingsRows() as { customer_id: string }[]).find((row) => row.customer_id === OTHER),
    ).toEqual(otherBefore);
    expect(snapshotRows()).toEqual(snapshotsBefore);
  });

  it('keeps approval and mapping when a withdrawn account is approved again', async () => {
    const { acme } = await approvedAndMapped();
    await map(SERVING, acme.id);
    const withdrawn = await request(app())
      .post(`/api/ads/accounts/${SERVING}/withdraw`)
      .send({ confirmCustomerId: SERVING });
    expect(withdrawn.status).toBe(200);
    expect(await view(SERVING)).toMatchObject({ approved: false, client: { name: 'Acme' } });
    expect((await preview(SERVING, null)).status).toBe(409); // not approved: no mapping change
    await approve(SERVING);
    expect(await view(SERVING)).toMatchObject({ approved: true, client: { name: 'Acme' } });
  });

  it('keeps approval and mapping when the account list is refreshed', async () => {
    const { acme } = await approvedAndMapped();
    await map(SERVING, acme.id);
    const before = settingsRows();
    await discover();
    expect(settingsRows()).toEqual(before);
  });
});

describe('disconnect and lost access', () => {
  const approvedAccount = async () => {
    await discover();
    await approve(SERVING);
    const client = await createClient('Acme');
    await map(SERVING, client.id);
    return client;
  };

  it('keeps the last snapshot visibly stale after disconnect and stops every provider read', async () => {
    const client = await approvedAccount();
    const snapshotsBefore = snapshotRows();
    disconnectAds(db, NOW);
    const callsBefore = [
      provider.accessTokenCalls.length,
      provider.listCalls.length,
      provider.readCalls.length,
    ];

    expect(await view(SERVING)).toMatchObject({
      approved: true,
      stale: 'DISCONNECTED',
      client: { id: client.id },
      snapshot: { descriptiveName: 'Agency account' },
    });
    expect((await discover()).status).toBe(409);
    expect((await approve(OTHER)).status).toBe(409);
    expect([
      provider.accessTokenCalls.length,
      provider.listCalls.length,
      provider.readCalls.length,
    ]).toEqual(callsBefore);
    expect(snapshotRows()).toEqual(snapshotsBefore);
  });

  it('marks an approved account stale when a later listing no longer reaches it, and keeps its snapshot', async () => {
    await approvedAccount();
    provider.accessible = [OTHER];
    await discover();
    expect(await view(SERVING)).toMatchObject({
      approved: true,
      discovered: false,
      stale: 'ACCESS_LOST',
      snapshot: { descriptiveName: 'Agency account' },
    });
    expect(await view(OTHER)).toMatchObject({ stale: null });
  });

  it('is fresh again after a reconnect lists the account', async () => {
    await approvedAccount();
    disconnectAds(db, NOW);
    db.prepare(
      `UPDATE ads_connection SET status='CONNECTED', refresh_token_encrypted=?, updated_at=? WHERE id='google-ads'`,
    ).run(encryptAdsRefreshToken('new-token', KEY), NOW.toISOString());
    await discover();
    expect(await view(SERVING)).toMatchObject({ approved: true, stale: null });
  });
});

describe('who can invoke it', () => {
  it('is not exposed as an MCP tool', () => {
    const names = MCP_TOOL_REGISTRY.map((tool) => tool.name as string);
    expect(names.filter((name) => /(^|_)ads?(_|$)/i.test(name))).toEqual([]);
  });
});
