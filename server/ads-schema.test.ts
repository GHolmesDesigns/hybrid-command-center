import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, transaction, type Db } from './db.ts';
import { listIntegrationEvents, recordIntegrationEvent } from './integration-log.ts';
import { INTEGRATION_ENTITY_TYPES } from '../shared/integration-log.ts';

const NOW = '2026-10-02T12:00:00.000Z';
const A = '1111111111';
const B = '2222222222';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const addAccount = (customerId: string) =>
  db
    .prepare(
      `INSERT INTO ads_accounts(customer_id,descriptive_name,currency_code,time_zone,manager,status,snapshot_at)
       VALUES(?,?,?,?,0,'ENABLED',?)`,
    )
    .run(customerId, `Account ${customerId}`, 'USD', 'America/New_York', NOW);
const addCampaign = (customerId: string, campaignId: string) =>
  db
    .prepare(
      `INSERT INTO ads_campaigns(customer_id,campaign_id,name,status,channel_type,snapshot_at)
       VALUES(?,?,?,?,?,?)`,
    )
    .run(customerId, campaignId, `Campaign ${campaignId}`, 'ENABLED', 'SEARCH', NOW);
const addDay = (customerId: string, campaignId: string, date: string, conversions = 1.25) =>
  db
    .prepare(
      `INSERT INTO ads_campaign_days(customer_id,campaign_id,date,impressions,clicks,cost_micros,conversions)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(customerId, campaignId, date, 100, 7, 2_500_000, conversions);
const addClient = () =>
  db
    .prepare(
      `INSERT INTO clients(id,name,slug,created_at,updated_at) VALUES('c1','Acme','acme',?,?)`,
    )
    .run(NOW, NOW);
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

describe('Google Ads schema', () => {
  it('lets two accounts hold the same campaign ID and the same day without colliding', () => {
    addAccount(A);
    addAccount(B);
    addCampaign(A, '42');
    addCampaign(B, '42');
    addDay(A, '42', '2026-09-30');
    addDay(B, '42', '2026-09-30');
    expect(count('ads_campaigns')).toBe(2);
    expect(count('ads_campaign_days')).toBe(2);
    expect(() => addCampaign(A, '42')).toThrow(/UNIQUE|constraint/i);
    expect(() => addDay(A, '42', '2026-09-30')).toThrow(/UNIQUE|constraint/i);
  });

  it('refuses a campaign day whose campaign belongs to a different account', () => {
    addAccount(A);
    addAccount(B);
    addCampaign(A, '42');
    expect(() => addDay(B, '42', '2026-09-30')).toThrow(/FOREIGN KEY/i);
  });

  it('stores conversions as the fractional number the provider documents, and cost as integer micros', () => {
    addAccount(A);
    addCampaign(A, '42');
    addDay(A, '42', '2026-09-30', 0.3333);
    const row = db.prepare('SELECT * FROM ads_campaign_days').get() as {
      conversions: number;
      cost_micros: number;
    };
    expect(row.conversions).toBe(0.3333);
    expect(row.cost_micros).toBe(2_500_000);
  });

  it('rejects an instant where an account-local date belongs, and a malformed ID', () => {
    addAccount(A);
    addCampaign(A, '42');
    expect(() => addDay(A, '42', '2026-09-30T04:00:00Z')).toThrow(/CHECK/i);
    expect(() => addAccount('12345')).toThrow(/CHECK/i);
    expect(() => addCampaign(A, '4x')).toThrow(/CHECK/i);
  });

  it('keeps approval and client mapping when a refresh replaces the account snapshot whole', () => {
    addClient();
    addAccount(A);
    addCampaign(A, '42');
    addDay(A, '42', '2026-09-30');
    db.prepare(
      `INSERT INTO ads_account_settings(customer_id,approved,approved_at,client_id,updated_at)
       VALUES(?,1,?,'c1',?)`,
    ).run(A, NOW, NOW);

    // The harshest refresh: the provider rows are deleted and written again.
    transaction(db, () => {
      db.prepare('DELETE FROM ads_accounts WHERE customer_id = ?').run(A);
      addAccount(A);
    });

    expect(db.prepare('SELECT approved, client_id FROM ads_account_settings').all()).toEqual([
      { approved: 1, client_id: 'c1' },
    ]);
    // Provider-owned children follow the account they describe, which is the snapshot's own rule.
    expect(count('ads_campaigns')).toBe(0);
    expect(count('ads_campaign_days')).toBe(0);
  });

  it('sends an account back to Unassigned rather than blocking if its client row is ever removed', () => {
    addClient();
    db.prepare(
      `INSERT INTO ads_account_settings(customer_id,approved,client_id,updated_at) VALUES(?,1,'c1',?)`,
    ).run(A, NOW);
    db.prepare(`DELETE FROM clients WHERE id='c1'`).run();
    expect(db.prepare('SELECT approved, client_id FROM ads_account_settings').get()).toEqual({
      approved: 1,
      client_id: null,
    });
  });

  it('holds a single connection row and only an encrypted token column', () => {
    const insert = (id: string) =>
      db
        .prepare(`INSERT INTO ads_connection(id,status,updated_at) VALUES(?,'DISCONNECTED',?)`)
        .run(id, NOW);
    insert('google-ads');
    expect(() => insert('other')).toThrow(/CHECK/i);
    const columns = (
      db.prepare('PRAGMA table_info(ads_connection)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns.filter((name) => /token/.test(name))).toEqual(['refresh_token_encrypted']);
  });

  it('indexes the per-account date window and the client lookup', () => {
    const indexes = (table: string) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((i) => i.name);
    expect(indexes('ads_campaign_days')).toContain('idx_ads_campaign_days_account_date');
    expect(indexes('ads_account_settings')).toContain('idx_ads_account_settings_client');
  });
});

describe('Google Ads migration', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-ads-'));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('adds the Ads tables to a database that predates them, keeps its data, and is safe to repeat', () => {
    const file = path.join(directory, 'old.db');
    const first = createDb(file);
    first.exec(
      `DROP TABLE ads_campaign_days; DROP TABLE ads_campaigns; DROP TABLE ads_accounts;
       DROP TABLE ads_account_settings; DROP TABLE ads_connection;`,
    );
    first
      .prepare(
        `INSERT INTO clients(id,name,slug,created_at,updated_at) VALUES('c1','Acme','acme',?,?)`,
      )
      .run(NOW, NOW);
    first.close();

    const upgraded = createDb(file);
    const tables = (
      upgraded
        .prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'ads_%' AND type='table'`)
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables.sort()).toEqual([
      'ads_account_settings',
      'ads_accounts',
      'ads_campaign_days',
      'ads_campaigns',
      'ads_connection',
      'ads_oauth_pending_states',
    ]);
    expect(upgraded.prepare('SELECT name FROM clients').all()).toEqual([{ name: 'Acme' }]);
    upgraded.close();

    const repeated: string[] = [];
    createDb(file, (statements) => repeated.push(...statements)).close();
    expect(repeated).toEqual([]);
  });
});

describe('Google Ads activity log vocabulary', () => {
  it('records a typed Ads sync with an account entity and scrubs a credential from the failure', () => {
    recordIntegrationEvent(db, {
      source: 'google-ads',
      operation: 'ads.sync',
      outcome: 'FAILURE',
      summary: 'Refresh failed; the last snapshot was kept.',
      entities: [{ type: 'adsAccount', id: A, label: A }],
      error: 'refresh_token=1//abcdefghijklmnop rejected',
    });
    const [event] = listIntegrationEvents(db);
    expect(event).toMatchObject({
      source: 'google-ads',
      operation: 'ads.sync',
      outcome: 'FAILURE',
    });
    expect(event?.error).not.toContain('abcdefghijklmnop');
  });

  it('has no entity type for a campaign, whose name is provider free text', () => {
    expect(INTEGRATION_ENTITY_TYPES.filter((type) => /campaign/i.test(type))).toEqual([]);
  });
});
