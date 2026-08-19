import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { createPost, signalPostInput } from '../signal/service.ts';
import { readSignalCampaignAnalytics, signalCampaignAnalyticsQuery } from './campaign-analytics.ts';
import { SIGNAL_CAMPAIGN_NONE } from '../../shared/signal-campaign-analytics.ts';
import type { SignalPost } from '../../shared/signal.ts';

/**
 * The gather behind campaign figures.
 *
 * The conclusions are `shared/signal-campaign-analytics.test.ts`'s. What is asserted here is the
 * half only a database can prove: that an unmeasured delivery arrives with no `totals` field at all,
 * that a stored reading of zero arrives as a reading, that the daily snapshots reach the delivery
 * they belong to, and that the route reads the address the way the panel writes it.
 */

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const app = () => createApp(db);

const add = (text: string, overrides: Record<string, unknown> = {}) =>
  createPost(db, signalPostInput.parse({ text, ...overrides }));

let publicationSequence = 0;

/** One delivered publication with one target, which is what a figure can belong to. */
function deliver(
  post: SignalPost,
  target: { channel: string; accountId: number; handle: string; resultId?: string },
) {
  const publicationId = `pub-${++publicationSequence}`;
  db.prepare(
    `INSERT INTO signal_publications(
       id,post_id,state,provider,idempotency_key,scheduled_instant,timezone,
       sent_caption,sent_channels,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    publicationId,
    post.id,
    'CONFIRMED',
    'post-bridge',
    `key-${publicationId}`,
    '2026-09-14T17:00:00.000Z',
    'America/New_York',
    post.text,
    JSON.stringify([target.channel]),
    '2026-09-14T12:00:00.000Z',
    '2026-09-14T12:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO signal_publication_targets(
       publication_id,channel,provider_account_id,outcome,handle,mode,post_result_id
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(
    publicationId,
    target.channel,
    target.accountId,
    'SUCCESS',
    target.handle,
    'AUTOMATIC',
    target.resultId ?? null,
  );
  return publicationId;
}

/** A stored reading, as `PublishAnalyticsService` writes one. */
function measure(
  publicationId: string,
  accountId: number,
  figures: { views: number; likes: number; comments: number; shares: number },
) {
  db.prepare(
    `INSERT INTO signal_post_metrics(
       publication_id,provider_account_id,post_result_id,analytics_id,platform,
       views,likes,comments,shares,synced_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    publicationId,
    accountId,
    'result-1',
    'analytics-1',
    'tiktok',
    figures.views,
    figures.likes,
    figures.comments,
    figures.shares,
    '2026-09-16T00:00:00.000Z',
  );
}

const snapshot = (publicationId: string, accountId: number, date: string, views: number): void => {
  db.prepare(
    `INSERT INTO signal_post_metric_days(
       publication_id,provider_account_id,date,views,likes,comments,shares
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(publicationId, accountId, date, views, 0, 0, 0);
};

const read = (query: Record<string, string> = {}) =>
  readSignalCampaignAnalytics(db, signalCampaignAnalyticsQuery.parse(query));

describe('gathering campaign figures from the rows', () => {
  it('groups a delivered, measured post under its campaigns and names the accounts it reached', () => {
    const post = add('The launch post', { date: '2026-09-14', campaigns: ['Clarity', 'Wk1'] });
    const publicationId = deliver(post, {
      channel: 'tt',
      accountId: 904,
      handle: '@gholmes',
      resultId: 'result-1',
    });
    measure(publicationId, 904, { views: 4210, likes: 318, comments: 24, shares: 61 });

    const summary = read();
    expect(summary.groups.map((group) => [group.name, group.totals?.views])).toEqual([
      ['Clarity', 4210],
      ['Wk1', 4210],
    ]);
    expect(summary.totals).toEqual({ views: 4210, likes: 318, comments: 24, shares: 61 });
    expect(summary.scope).toEqual({ posts: 1, deliveries: 1, measuredDeliveries: 1 });
    expect(summary.channels).toEqual(['tt']);
    expect(summary.accounts).toEqual([{ accountId: 904, channel: 'tt', handle: '@gholmes' }]);
  });

  it('gives an unmeasured delivery no totals field, so nothing downstream can read it as zero', () => {
    const post = add('Waiting on the provider', { date: '2026-09-14', campaigns: ['Clarity'] });
    deliver(post, { channel: 'tt', accountId: 904, handle: '@gholmes' });

    const summary = read();
    expect(summary.groups[0]).toMatchObject({ deliveries: 1, measuredDeliveries: 0 });
    expect(summary.groups[0]).not.toHaveProperty('totals');
    expect(summary).not.toHaveProperty('totals');
  });

  it('treats a stored reading of zero as a reading, because zero is what the platform counted', () => {
    const post = add('Counted, and nobody watched', { date: '2026-09-14', campaigns: ['Clarity'] });
    const publicationId = deliver(post, {
      channel: 'tt',
      accountId: 904,
      handle: '@gholmes',
      resultId: 'result-1',
    });
    measure(publicationId, 904, { views: 0, likes: 0, comments: 0, shares: 0 });

    const summary = read();
    expect(summary.groups[0]?.measuredDeliveries).toBe(1);
    expect(summary.totals).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
  });

  it('carries the daily snapshots to the delivery they belong to, as per-day gains', () => {
    const post = add('With a history', { date: '2026-09-14', campaigns: ['Clarity'] });
    const publicationId = deliver(post, {
      channel: 'tt',
      accountId: 904,
      handle: '@gholmes',
      resultId: 'result-1',
    });
    measure(publicationId, 904, { views: 4210, likes: 0, comments: 0, shares: 0 });
    snapshot(publicationId, 904, '2026-09-14', 3000);
    snapshot(publicationId, 904, '2026-09-15', 4210);

    expect(read().trend).toEqual([
      { date: '2026-09-15', views: 1210, likes: 0, comments: 0, shares: 0 },
    ]);
    expect(read().groups[0]?.trend).toHaveLength(1);
  });

  it('keeps a post with no deliveries visible as a post in its campaign', () => {
    add('Planned and not sent', { date: '2026-09-14', campaigns: ['Clarity'] });
    const summary = read();
    expect(summary.groups[0]).toMatchObject({
      name: 'Clarity',
      posts: 1,
      deliveries: 0,
      measuredDeliveries: 0,
    });
  });

  it('puts an unclassified post under No campaign, including one still in the queue', () => {
    add('Never classified', { date: '2026-09-14' });
    add('An idea with no date');
    const summary = read();
    expect(summary.groups.map((group) => [group.campaignId, group.posts])).toEqual([[null, 2]]);
    // A range is a question about days, and an undated post is in none of them.
    expect(read({ from: '2026-09-01', to: '2026-09-30' }).groups[0]?.posts).toBe(1);
  });

  it('lists a campaign nothing carries, so the filter can offer it', () => {
    db.prepare('INSERT INTO signal_campaigns(id,name,color) VALUES(?,?,?)').run(
      'c-unused',
      'Unused idea',
      null,
    );
    const summary = read();
    expect(summary.campaigns.map((campaign) => campaign.name)).toEqual(['Unused idea']);
    expect(summary.groups).toEqual([]);
  });
});

describe('the filters, as the address spells them', () => {
  const workspace = () => {
    const first = add('Clarity, measured', { date: '2026-09-01', campaigns: ['Clarity'] });
    const second = add('Explain, measured', { date: '2026-09-20', campaigns: ['Explain'] });
    const tiktok = deliver(first, {
      channel: 'tt',
      accountId: 904,
      handle: '@gholmes',
      resultId: 'r1',
    });
    const youtube = deliver(second, {
      channel: 'yt',
      accountId: 905,
      handle: '@channel',
      resultId: 'r2',
    });
    measure(tiktok, 904, { views: 1000, likes: 0, comments: 0, shares: 0 });
    measure(youtube, 905, { views: 200, likes: 0, comments: 0, shares: 0 });
    return { first, second };
  };

  it('takes a comma-separated list, and reads an empty parameter as no restriction', () => {
    expect(signalCampaignAnalyticsQuery.parse({ channels: 'tt,yt' }).channels).toEqual([
      'tt',
      'yt',
    ]);
    expect(signalCampaignAnalyticsQuery.parse({ channels: '' }).channels).toEqual([]);
    expect(signalCampaignAnalyticsQuery.parse({}).campaigns).toEqual([]);
    expect(signalCampaignAnalyticsQuery.parse({ accounts: ' 904 , 905 ' }).accounts).toEqual([
      904, 905,
    ]);
    expect(
      signalCampaignAnalyticsQuery.parse({ campaigns: SIGNAL_CAMPAIGN_NONE }).campaigns,
    ).toEqual([SIGNAL_CAMPAIGN_NONE]);
  });

  it('refuses a member it cannot read rather than dropping it silently', () => {
    expect(() => signalCampaignAnalyticsQuery.parse({ channels: 'tt,mastodon' })).toThrow();
    expect(() => signalCampaignAnalyticsQuery.parse({ accounts: '904,abc' })).toThrow();
    expect(() => signalCampaignAnalyticsQuery.parse({ accounts: '0' })).toThrow();
    expect(() => signalCampaignAnalyticsQuery.parse({ campaigns: 'not-a-uuid' })).toThrow();
    expect(() => signalCampaignAnalyticsQuery.parse({ from: '2026-02-31' })).toThrow();
    expect(() =>
      signalCampaignAnalyticsQuery.parse({ from: '2026-09-30', to: '2026-09-01' }),
    ).toThrow();
  });

  it('narrows by channel and by account against the stored rows', () => {
    workspace();
    expect(read({ channels: 'tt' }).totals?.views).toBe(1000);
    expect(read({ accounts: '905' }).totals?.views).toBe(200);
    expect(read({ channels: 'tt', accounts: '905' })).not.toHaveProperty('totals');
  });

  it('narrows by campaign, with several read as or', () => {
    const { first, second } = workspace();
    const clarityId = first.campaigns[0]!.id;
    const explainId = second.campaigns[0]!.id;
    expect(read({ campaigns: clarityId }).totals?.views).toBe(1000);
    expect(read({ campaigns: `${clarityId},${explainId}` }).totals?.views).toBe(1200);
  });

  it('narrows by the post’s own date', () => {
    workspace();
    expect(read({ from: '2026-09-10' }).totals?.views).toBe(200);
    expect(read({ to: '2026-09-10' }).totals?.views).toBe(1000);
    expect(read({ from: '2026-09-01', to: '2026-09-30' }).totals?.views).toBe(1200);
  });
});

describe('the campaign figures route', () => {
  it('answers the summary, and contacts no provider on any path through it', async () => {
    const post = add('The launch post', { date: '2026-09-14', campaigns: ['Clarity'] });
    const publicationId = deliver(post, {
      channel: 'tt',
      accountId: 904,
      handle: '@gholmes',
      resultId: 'r1',
    });
    measure(publicationId, 904, { views: 4210, likes: 318, comments: 24, shares: 61 });

    const response = await request(app()).get('/api/signal/analytics/campaigns').expect(200);
    expect(response.body.groups).toHaveLength(1);
    expect(response.body.totals).toEqual({ views: 4210, likes: 318, comments: 24, shares: 61 });
    // The provider is never constructed with a key in tests, and nothing here would reach one:
    // a refusal would have been recorded against the analytics connection, and there is none.
    expect(
      db.prepare("SELECT COUNT(*) n FROM settings WHERE key='publish_analytics_sync'").get(),
    ).toEqual({ n: 0 });
  });

  it('takes the filters from the query string and echoes them back', async () => {
    const post = add('The launch post', { date: '2026-09-14', campaigns: ['Clarity'] });
    const campaignId = post.campaigns[0]!.id;
    const response = await request(app())
      .get(
        `/api/signal/analytics/campaigns?campaigns=${campaignId},none&channels=tt&from=2026-09-01&to=2026-09-30`,
      )
      .expect(200);
    expect(response.body.filters).toEqual({
      campaignIds: [campaignId, 'none'],
      channels: ['tt'],
      accountIds: [],
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('refuses a range that ends before it starts, and an unreadable filter member', async () => {
    const refused = await request(app())
      .get('/api/signal/analytics/campaigns?from=2026-09-30&to=2026-09-01')
      .expect(400);
    expect(refused.body.error).toBe('The range ends before it starts.');
    await request(app()).get('/api/signal/analytics/campaigns?channels=mastodon').expect(400);
  });

  it('writes nothing: reading figures by campaign cannot change a post or a delivery', async () => {
    const post = add('The launch post', { date: '2026-09-14', campaigns: ['Clarity'] });
    const publicationId = deliver(post, {
      channel: 'tt',
      accountId: 904,
      handle: '@gholmes',
      resultId: 'r1',
    });
    measure(publicationId, 904, { views: 10, likes: 0, comments: 0, shares: 0 });
    const before = {
      posts: db.prepare('SELECT * FROM signal_posts').all(),
      publications: db.prepare('SELECT * FROM signal_publications').all(),
      targets: db.prepare('SELECT * FROM signal_publication_targets').all(),
      metrics: db.prepare('SELECT * FROM signal_post_metrics').all(),
      events: db.prepare('SELECT COUNT(*) n FROM integration_events').get(),
    };

    await request(app()).get('/api/signal/analytics/campaigns').expect(200);
    await request(app()).get('/api/signal/analytics/campaigns?channels=tt').expect(200);

    expect(db.prepare('SELECT * FROM signal_posts').all()).toEqual(before.posts);
    expect(db.prepare('SELECT * FROM signal_publications').all()).toEqual(before.publications);
    expect(db.prepare('SELECT * FROM signal_publication_targets').all()).toEqual(before.targets);
    expect(db.prepare('SELECT * FROM signal_post_metrics').all()).toEqual(before.metrics);
    expect(db.prepare('SELECT COUNT(*) n FROM integration_events').get()).toEqual(before.events);
  });
});
