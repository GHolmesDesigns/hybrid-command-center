import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { listPostsInRange } from './read.ts';
import { createPost, listQueue, signalPostInput } from './service.ts';
import { createCampaign, signalCampaignInput } from './campaigns.ts';
import { readCardDeliveries } from './card-delivery.ts';
import { seedSignalPost } from './test-fixture.ts';
import { SIGNAL_RANGE_LIMIT } from '../../shared/signal.ts';
import { SIGNAL_CAMPAIGN_NONE } from '../../shared/signal-campaign-analytics.ts';

/**
 * C186: client, project, and campaign are each OR'd within themselves and AND'd against one
 * another, copy search narrows the same way, and every one of them is applied in SQL before
 * `SIGNAL_RANGE_LIMIT` rather than after it. These tests exercise `listPostsInRange`, `listQueue`,
 * and `readCardDeliveries` directly, plus the HTTP routes that parse the query into the same
 * filters, so the range, the queue, and the delivery snapshot cannot silently disagree on scope.
 */

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const app = () => createApp(db);
const add = (overrides: Record<string, unknown> = {}) =>
  createPost(db, signalPostInput.parse({ text: 'Clarity as competitive advantage', ...overrides }));

function seedClientAndProject(clientId: string, clientName: string, projectId: string): void {
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO clients(id,name,slug,created_at,updated_at) VALUES(?,?,?,?,?)`).run(
    clientId,
    clientName,
    clientName.toLowerCase().replace(/\s+/g, '-'),
    timestamp,
    timestamp,
  );
  db.prepare(`INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(?,?,?,?,?)`).run(
    projectId,
    clientId,
    `${clientName} project`,
    timestamp,
    timestamp,
  );
}

describe('client scope', () => {
  it('reads several clients as or, and unbound as its own explicit case', async () => {
    seedClientAndProject('client-a', 'Acme', 'project-a');
    seedClientAndProject('client-b', 'Brightline', 'project-b');
    seedClientAndProject('client-c', 'Cobalt', 'project-c');
    const a = await add({ projectId: 'project-a', date: '2026-09-01' });
    const b = await add({ projectId: 'project-b', date: '2026-09-01' });
    const c = await add({ projectId: 'project-c', date: '2026-09-01' });
    const none = await add({ date: '2026-09-01' });

    const both = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', {
      clientIds: ['client-a', 'client-b'],
    });
    expect(both.posts.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(both.posts.some((p) => p.id === c.id)).toBe(false);

    const unbound = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', {
      clientIds: ['unbound'],
    });
    expect(unbound.posts.map((p) => p.id)).toEqual([none.id]);
  });
});

describe('project scope', () => {
  it('reads several projects as or', async () => {
    seedClientAndProject('client-a', 'Acme', 'project-a');
    seedClientAndProject('client-b', 'Brightline', 'project-b');
    const a = await add({ projectId: 'project-a', date: '2026-09-01' });
    const b = await add({ projectId: 'project-b', date: '2026-09-01' });
    await add({ date: '2026-09-01' });

    const result = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', {
      projectIds: ['project-a', 'project-b'],
    });
    expect(result.posts.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
  });
});

describe('campaign scope', () => {
  it('reads several campaigns as or, and no campaign as its own explicit case', async () => {
    const launch = createCampaign(db, signalCampaignInput.parse({ name: 'Launch' })).campaign;
    const spring = createCampaign(db, signalCampaignInput.parse({ name: 'Spring' })).campaign;
    const l = await add({ date: '2026-09-01', campaigns: ['Launch'] });
    const s = await add({ date: '2026-09-01', campaigns: ['Spring'] });
    const none = await add({ date: '2026-09-01' });

    const result = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', {
      campaignIds: [launch.id, spring.id],
    });
    expect(result.posts.map((p) => p.id).sort()).toEqual([l.id, s.id].sort());

    const noneOnly = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', {
      campaignIds: [SIGNAL_CAMPAIGN_NONE],
    });
    expect(noneOnly.posts.map((p) => p.id)).toEqual([none.id]);
  });
});

describe('copy search', () => {
  it('matches case-insensitively and narrows the range, queue, and delivery snapshot alike', async () => {
    const dated = await add({ date: '2026-09-01', text: 'Announcing the Autumn Launch' });
    const queued = await add({ text: 'AUTUMN checklist before launch' });
    await add({ date: '2026-09-01', text: 'Unrelated copy entirely' });

    const range = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', { text: 'autumn' });
    expect(range.posts.map((p) => p.id)).toEqual([dated.id]);

    const queue = listQueue(db, 'active', { text: 'autumn' });
    expect(queue.map((p) => p.id)).toEqual([queued.id]);

    const delivery = readCardDeliveries(db, '2026-09-01', '2026-09-01', { text: 'autumn' });
    expect(delivery.deliveries.map((d) => d.postId).sort()).toEqual([dated.id, queued.id].sort());
  });

  it('treats % and _ as literal characters rather than SQL wildcards', async () => {
    const literal = await add({ date: '2026-09-01', text: '50% off this week only' });
    await add({ date: '2026-09-01', text: 'Fifty percent off everything' });

    const result = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', { text: '50%' });
    expect(result.posts.map((p) => p.id)).toEqual([literal.id]);
  });
});

describe('cross-dimension scope', () => {
  it('ands client, project, and campaign together rather than treating them as one or list', async () => {
    seedClientAndProject('client-a', 'Acme', 'project-a');
    const campaign = createCampaign(db, signalCampaignInput.parse({ name: 'Launch' })).campaign;
    const matches = await add({
      projectId: 'project-a',
      date: '2026-09-01',
      campaigns: ['Launch'],
    });
    // Right client, wrong campaign.
    await add({ projectId: 'project-a', date: '2026-09-01' });
    // Right campaign, wrong (no) client.
    await add({ date: '2026-09-01', campaigns: ['Launch'] });

    const result = listPostsInRange(db, '2026-09-01', '2026-09-01', 'active', {
      clientIds: ['client-a'],
      campaignIds: [campaign.id],
    });
    expect(result.posts.map((p) => p.id)).toEqual([matches.id]);
  });
});

describe('scope ahead of the range limit', () => {
  it('filters in SQL before SIGNAL_RANGE_LIMIT rather than after it', () => {
    const campaign = createCampaign(db, signalCampaignInput.parse({ name: 'Launch' })).campaign;
    // More non-matching posts than the range limit, all sorting ahead of the one matching post —
    // if scope were applied to an already-truncated page, this post would never be reached.
    for (let day = 1; day <= SIGNAL_RANGE_LIMIT + 5; day += 1) {
      seedSignalPost(db, {
        date: `2026-01-${String((day % 28) + 1).padStart(2, '0')}`,
        position: 0,
      });
    }
    const matching = seedSignalPost(db, {
      date: '2026-12-31',
      campaigns: [{ id: campaign.id, name: campaign.name }],
    });

    const result = listPostsInRange(db, '2026-01-01', '2026-12-31', 'active', {
      campaignIds: [campaign.id],
    });
    expect(result.posts.map((p) => p.id)).toEqual([matching.id]);
    expect(result.truncated).toBe(false);
  });
});

describe('HTTP routes carry the same scope', () => {
  it('rejects a malformed filter id before touching the database', async () => {
    const res = await request(app()).get(
      '/api/signal/posts?from=2026-09-01&to=2026-09-01&client=not-a-uuid',
    );
    expect(res.status).toBe(400);
  });

  it('applies client/project/campaign/copy scope identically to posts, queue, and card-delivery', async () => {
    // Real UUIDs here, unlike the friendly ids the direct-function tests above use: this test goes
    // through the HTTP query schema, which validates a client/project id as a UUID in production.
    const clientId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    seedClientAndProject(clientId, 'Acme', projectId);
    const campaign = createCampaign(db, signalCampaignInput.parse({ name: 'Launch' })).campaign;
    const dated = await add({
      projectId,
      date: '2026-09-01',
      campaigns: ['Launch'],
      text: 'Launch day announcement',
    });
    const queued = await add({
      projectId,
      campaigns: ['Launch'],
      text: 'Launch prep checklist',
    });
    await add({ date: '2026-09-01', text: 'Unrelated post' });

    const query = `client=${clientId}&project=${projectId}&campaign=${campaign.id}&q=launch`;
    const postsRes = await request(app()).get(
      `/api/signal/posts?from=2026-09-01&to=2026-09-01&${query}`,
    );
    const queueRes = await request(app()).get(`/api/signal/queue?${query}`);
    const deliveryRes = await request(app()).get(
      `/api/signal/card-delivery?from=2026-09-01&to=2026-09-01&${query}`,
    );

    expect(postsRes.status).toBe(200);
    expect(postsRes.body.posts.map((p: { id: string }) => p.id)).toEqual([dated.id]);
    expect(queueRes.status).toBe(200);
    expect(queueRes.body.map((p: { id: string }) => p.id)).toEqual([queued.id]);
    expect(deliveryRes.status).toBe(200);
    expect(deliveryRes.body.deliveries.map((d: { postId: string }) => d.postId).sort()).toEqual(
      [dated.id, queued.id].sort(),
    );
  });

  it('reads campaign=none over HTTP as the reserved unclassified value', async () => {
    await add({ date: '2026-09-01', campaigns: ['Launch'] });
    const unclassified = await add({ date: '2026-09-01' });

    const res = await request(app()).get(
      `/api/signal/posts?from=2026-09-01&to=2026-09-01&campaign=${SIGNAL_CAMPAIGN_NONE}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.posts.map((p: { id: string }) => p.id)).toEqual([unclassified.id]);
  });
});
