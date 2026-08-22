import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from '../db.ts';
import { createApp } from '../app.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { LocalSignalProvider } from '../signal/read.ts';
import { MockAnalyticsProvider, MockPublishProvider } from './mock-provider.ts';
import { PublishAnalyticsService, readAnalyticsSync } from './analytics.ts';
import { UnavailableAnalyticsProvider } from './analytics-provider.ts';
import { PublishProviderError } from './provider.ts';
import { PublishService } from './service.ts';
import { readSyncHealth } from './sync-health.ts';
import {
  ANALYTICS_BACKOFF_MAX_ATTEMPTS,
  ANALYTICS_PLATFORMS,
  type PostMetricsSummary,
} from '../../shared/publish-analytics.ts';
import type { SignalChannel } from '../../shared/signal.ts';

let db: Db;
const NOW = new Date('2026-08-19T12:00:00.000Z');
const clock = () => NOW;

beforeEach(() => {
  db = createDb(':memory:');
});

/**
 * A delivery record in the shape a submission leaves behind, written directly.
 *
 * Direct rather than through `PublishService.submit` on purpose: these cases are about figures, and
 * driving them through preflight would make every one of them also a statement about media bounds on
 * TikTok and YouTube. The one criterion that *is* about the publishing path — reconciliation
 * capturing the provider's result identity — is exercised through the real service further down,
 * against the real mock provider.
 */
function seedDelivery(
  postId: string,
  targets: {
    channel: SignalChannel;
    accountId: number;
    resultId?: string;
    handle?: string;
    outcome?: 'SUCCESS' | 'FAILURE';
  }[],
  options: { publicationId?: string; createdAt?: string } = {},
) {
  const publicationId = options.publicationId ?? `publication-${postId}`;
  const createdAt = options.createdAt ?? '2026-08-18T09:00:00.000Z';
  db.prepare(
    `INSERT INTO signal_publications(
       id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
       sent_caption,sent_channels,sent_media,sent_configurations,created_at,updated_at
     ) VALUES(?,?,'CONFIRMED','post-bridge',?,?,?,?,?,?,'[]','[]',?,?)`,
  ).run(
    publicationId,
    postId,
    `provider-${publicationId}`,
    `key-${publicationId}`,
    '2026-08-18T13:00:00.000Z',
    'America/New_York',
    'A clear campaign post',
    JSON.stringify(targets.map((target) => target.channel)),
    createdAt,
    createdAt,
  );
  const insert = db.prepare(
    `INSERT INTO signal_publication_targets(
       publication_id,channel,provider_account_id,handle,mode,outcome,post_result_id
     ) VALUES(?,?,?,?,'AUTOMATIC',?,?)`,
  );
  for (const target of targets)
    insert.run(
      publicationId,
      target.channel,
      target.accountId,
      target.handle ?? `@account-${target.accountId}`,
      target.outcome ?? 'SUCCESS',
      target.resultId ?? null,
    );
  return publicationId;
}

const service = (provider: MockAnalyticsProvider, jitter = () => 1) =>
  new PublishAnalyticsService(db, provider, clock, jitter);

/** A provider holding one measured record per platform, with two days of history each. */
function loadedProvider() {
  const provider = new MockAnalyticsProvider();
  provider.records = [
    {
      analyticsId: 'analytics-tt',
      postResultId: 'result-tt',
      platform: 'tiktok',
      views: 4210,
      likes: 318,
      comments: 24,
      shares: 61,
      lastSyncedAt: '2026-08-19T11:00:00.000Z',
      shareUrl: 'https://tiktok.example/video/1',
    },
    {
      analyticsId: 'analytics-yt',
      postResultId: 'result-yt',
      platform: 'youtube',
      views: 902,
      likes: 44,
      comments: 6,
      shares: 3,
    },
    {
      analyticsId: 'analytics-ig',
      postResultId: 'result-ig',
      platform: 'instagram',
      views: 1500,
      likes: 210,
      comments: 11,
      shares: 9,
    },
  ];
  provider.daysByRecord = {
    'analytics-tt': [
      { date: '2026-08-18', views: 3000, likes: 200, comments: 20, shares: 50 },
      { date: '2026-08-19', views: 4210, likes: 318, comments: 24, shares: 61 },
    ],
  };
  return provider;
}

const targetFor = (summary: PostMetricsSummary, channel: SignalChannel) =>
  summary.targets.find((target) => target.channel === channel);

describe('reading figures', () => {
  it('makes no provider call, and reports every delivery’s state without inventing a number', () => {
    const post = seedSignalPost(db, { channels: ['tt', 'x', 'blog'] });
    seedDelivery(post.id, [
      { channel: 'tt', accountId: 1, resultId: 'result-tt' },
      { channel: 'x', accountId: 2, resultId: 'result-x' },
      { channel: 'blog', accountId: 3 },
    ]);
    const provider = new MockAnalyticsProvider();
    const summary = service(provider).read(post.id);

    expect(provider.syncs).toEqual([]);
    expect(provider.lists).toEqual([]);
    // A measured platform with no reading yet, an unmeasured one, and a channel with no provider at
    // all. Three different sentences, and not one zero between them.
    expect(targetFor(summary, 'tt')?.availability).toBe('AWAITING_SYNC');
    expect(targetFor(summary, 'x')?.availability).toBe('NOT_AVAILABLE');
    expect(targetFor(summary, 'blog')?.availability).toBe('NOT_AVAILABLE');
    for (const target of summary.targets) expect(target.totals).toBeUndefined();
    expect(summary.lastSyncedAt).toBeUndefined();
    expect(summary.refresh.allowed).toBe(true);
  });

  it('says a delivery has no result identity yet rather than that it has no figures', () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1 }]);
    expect(targetFor(service(new MockAnalyticsProvider()).read(post.id), 'tt')?.availability).toBe(
      'AWAITING_RESULT',
    );
  });

  it('does not describe a failed delivery as awaiting figures', () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    seedDelivery(post.id, [
      { channel: 'ig', accountId: 1, resultId: 'result-ig', outcome: 'FAILURE' },
    ]);
    const target = targetFor(service(new MockAnalyticsProvider()).read(post.id), 'ig');
    expect(target?.availability).toBe('NOT_AVAILABLE');
    expect(target?.outcome).toBe('FAILURE');
  });
});

describe('an on-demand refresh', () => {
  it('covers every analytics platform the provider exposes and stores totals and daily snapshots', async () => {
    const post = seedSignalPost(db, { channels: ['tt', 'yt', 'ig', 'x'] });
    seedDelivery(post.id, [
      { channel: 'tt', accountId: 1, resultId: 'result-tt' },
      { channel: 'yt', accountId: 2, resultId: 'result-yt' },
      { channel: 'ig', accountId: 3, resultId: 'result-ig' },
      { channel: 'x', accountId: 4, resultId: 'result-x' },
    ]);
    const provider = loadedProvider();
    const summary = await service(provider).refresh(post.id);

    // One sync, covering all three platforms: the vendor's own "omit to sync all", rather than one
    // narrowed request per platform against the endpoint whose 429 is the documented one.
    expect(provider.syncs).toEqual([ANALYTICS_PLATFORMS]);
    // Every measured delivery was asked about, and the unmeasured one was not.
    expect(provider.lists).toEqual([['result-tt', 'result-yt', 'result-ig']]);
    for (const platform of ANALYTICS_PLATFORMS)
      expect(
        summary.targets.some(
          (target) => target.platform === platform && target.availability === 'AVAILABLE',
        ),
      ).toBe(true);

    expect(targetFor(summary, 'tt')?.totals).toEqual({
      views: 4210,
      likes: 318,
      comments: 24,
      shares: 61,
    });
    expect(targetFor(summary, 'tt')?.providerSyncedAt).toBe('2026-08-19T11:00:00.000Z');
    expect(targetFor(summary, 'tt')?.shareUrl).toBe('https://tiktok.example/video/1');
    expect(targetFor(summary, 'tt')?.days).toEqual([
      { date: '2026-08-18', views: 3000, likes: 200, comments: 20, shares: 50 },
      { date: '2026-08-19', views: 4210, likes: 318, comments: 24, shares: 61 },
    ]);
    // Daily snapshots only where the provider keeps them. An empty history is not a zeroed one.
    expect(targetFor(summary, 'yt')?.totals?.views).toBe(902);
    expect(targetFor(summary, 'yt')?.days).toEqual([]);
    // The last-synchronised time the panel shows is this app's own, recorded once for the refresh.
    expect(summary.lastSyncedAt).toBe(NOW.toISOString());
    expect(summary.refresh).toEqual({ allowed: true, attempts: 0, exhausted: false });
  });

  it('leaves an unmeasured channel with a sentence and no figures, however often it is refreshed', async () => {
    const post = seedSignalPost(db, { channels: ['tt', 'x'] });
    seedDelivery(post.id, [
      { channel: 'tt', accountId: 1, resultId: 'result-tt' },
      { channel: 'x', accountId: 2, resultId: 'result-x' },
    ]);
    const provider = loadedProvider();
    const analytics = service(provider);
    await analytics.refresh(post.id);
    const summary = await analytics.refresh(post.id);

    const twitter = targetFor(summary, 'x');
    expect(twitter?.availability).toBe('NOT_AVAILABLE');
    expect(twitter?.totals).toBeUndefined();
    expect(twitter?.days).toEqual([]);
    // Nothing was stored against it either, so a later build cannot start rendering a zero from a row
    // that should not exist.
    expect(
      db.prepare('SELECT COUNT(*) AS total FROM signal_post_metrics').get() as { total: number },
    ).toEqual({ total: 1 });
  });

  it('does not ask the provider about a failed delivery that carries a result identity', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    seedDelivery(post.id, [
      { channel: 'ig', accountId: 1, resultId: 'result-ig', outcome: 'FAILURE' },
    ]);
    const provider = loadedProvider();
    const summary = await service(provider).refresh(post.id);

    expect(provider.syncs).toEqual([]);
    expect(provider.lists).toEqual([]);
    expect(targetFor(summary, 'ig')?.availability).toBe('NOT_AVAILABLE');
    expect(summary.refresh.allowed).toBe(false);
    expect(summary.refresh.reason).toMatch(/did not go out/);
  });

  it('reaches no provider at all when nothing on the post can be measured', async () => {
    const post = seedSignalPost(db, { channels: ['x', 'blog'] });
    seedDelivery(post.id, [
      { channel: 'x', accountId: 1, resultId: 'result-x' },
      { channel: 'blog', accountId: 2 },
    ]);
    const provider = new MockAnalyticsProvider();
    const summary = await service(provider).refresh(post.id);

    expect(provider.syncs).toEqual([]);
    expect(summary.refresh.allowed).toBe(false);
    expect(summary.refresh.reason).toContain('reports figures for');
  });

  it('asks for a delivery refresh first when the provider’s result identity is not known yet', async () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1 }]);
    const provider = new MockAnalyticsProvider();
    const summary = await service(provider).refresh(post.id);

    expect(provider.syncs).toEqual([]);
    expect(summary.refresh.reason).toContain('Refresh the delivery first');
  });

  it('records one integration event, and reports PARTIAL when the provider had figures for some', async () => {
    const post = seedSignalPost(db, { channels: ['tt', 'yt'] });
    seedDelivery(post.id, [
      { channel: 'tt', accountId: 1, resultId: 'result-tt' },
      { channel: 'yt', accountId: 2, resultId: 'result-yt' },
    ]);
    const provider = loadedProvider();
    provider.records = provider.records.filter((record) => record.platform === 'tiktok');
    await service(provider).refresh(post.id);

    const events = listIntegrationEvents(db, {});
    expect(events).toHaveLength(1);
    expect(events[0]?.operation).toBe('signal.analytics-sync');
    expect(events[0]?.outcome).toBe('PARTIAL');
    expect(events[0]?.summary).toContain('1 of 2');
    expect(events[0]?.entities).toEqual([
      { type: 'signalPost', id: post.id, label: 'A clear campaign post' },
    ]);
  });

  it('changes no post, publication, or delivery row', async () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    const publicationId = seedDelivery(post.id, [
      { channel: 'tt', accountId: 1, resultId: 'result-tt' },
    ]);
    const before = {
      post: db.prepare('SELECT * FROM signal_posts WHERE id=?').get(post.id),
      publication: db.prepare('SELECT * FROM signal_publications WHERE id=?').get(publicationId),
      targets: db.prepare('SELECT * FROM signal_publication_targets').all(),
    };
    await service(loadedProvider()).refresh(post.id);

    // The figures path stores figures. The planning status stays the user's own claim and the
    // delivery answer stays the provider's, and neither is reachable from here.
    expect(db.prepare('SELECT * FROM signal_posts WHERE id=?').get(post.id)).toEqual(before.post);
    expect(db.prepare('SELECT * FROM signal_publications WHERE id=?').get(publicationId)).toEqual(
      before.publication,
    );
    expect(db.prepare('SELECT * FROM signal_publication_targets').all()).toEqual(before.targets);
  });

  it('says analytics is not configured rather than showing an empty panel', async () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1, resultId: 'result-tt' }]);
    const analytics = new PublishAnalyticsService(db, new UnavailableAnalyticsProvider(), clock);
    const summary = await analytics.refresh(post.id);
    expect(summary.refresh.reason).toBe('Analytics needs POST_BRIDGE_API_KEY.');
  });
});

describe('a refresh the provider refuses', () => {
  const rateLimited = (retryAfterSeconds?: number) =>
    new PublishProviderError('Post Bridge refused the request (429).', false, {
      rateLimited: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });

  /** A post whose figures have already been read once, so there is something to preserve. */
  async function withStoredFigures() {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1, resultId: 'result-tt' }]);
    const provider = loadedProvider();
    const analytics = service(provider);
    const first = await analytics.refresh(post.id);
    expect(first.targets[0]?.totals?.views).toBe(4210);
    return { post, provider, analytics };
  }

  it('keeps the last known good values, records a bounded wait, and reports the limit', async () => {
    const { post, provider, analytics } = await withStoredFigures();
    provider.records = [
      { ...(provider.records[0] as (typeof provider.records)[number]), views: 999999 },
    ];
    provider.syncFailure = rateLimited();
    const summary = await analytics.refresh(post.id);

    // The figures on screen are the ones the provider last gave, not zeros and not the ones the
    // failed call was going to fetch.
    expect(summary.targets[0]?.totals?.views).toBe(4210);
    expect(summary.targets[0]?.availability).toBe('AVAILABLE');
    expect(summary.refresh.allowed).toBe(false);
    // Attempt one: base 1 s, and the jitter is pinned at the top of the window.
    expect(summary.refresh.retryAfterSeconds).toBe(1);
    expect(summary.refresh.waitingUntil).toBe('2026-08-19T12:00:01.000Z');
    expect(summary.refresh.reason).toContain('rate-limiting');
    // A limit is a fact about the connection, so the shared record carries it and the queue-health
    // summary reports it without a second alert kind.
    expect(readSyncHealth(db)?.rateLimitedUntil).toBe('2026-08-19T12:00:01.000Z');
    // And the last-synchronised time is still the successful one, because that is when figures were
    // last actually read.
    expect(summary.lastSyncedAt).toBe(NOW.toISOString());
  });

  it('refuses the next attempt from storage, without asking the provider again', async () => {
    const { post, provider, analytics } = await withStoredFigures();
    provider.syncFailure = rateLimited(45);
    await analytics.refresh(post.id);
    const syncsSoFar = provider.syncs.length;

    const summary = await analytics.refresh(post.id);
    expect(provider.syncs).toHaveLength(syncsSoFar);
    expect(summary.refresh.allowed).toBe(false);
    expect(summary.targets[0]?.totals?.views).toBe(4210);
  });

  it('honours a Retry-After longer than its own backoff', async () => {
    const { post, provider, analytics } = await withStoredFigures();
    provider.syncFailure = rateLimited(300);
    const summary = await analytics.refresh(post.id);
    // Waiting longer than asked never breaks a limit; waiting less than asked does. The provider's
    // figure wins whenever it is the larger of the two.
    expect(summary.refresh.retryAfterSeconds).toBe(300);
  });

  it('widens the wait with each consecutive refusal and reports the bound', async () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1, resultId: 'result-tt' }]);
    const provider = loadedProvider();
    // One clock the test advances, so each refusal is taken after the previous wait has passed —
    // which is the only way a second attempt happens at all.
    let now = new Date('2026-08-19T12:00:00.000Z');
    const analytics = new PublishAnalyticsService(
      db,
      provider,
      () => now,
      () => 1,
    );
    provider.syncFailure = rateLimited();
    const waits: number[] = [];
    for (let attempt = 1; attempt <= ANALYTICS_BACKOFF_MAX_ATTEMPTS; attempt += 1) {
      const summary = await analytics.refresh(post.id);
      waits.push(summary.refresh.retryAfterSeconds as number);
      now = new Date(Date.parse(summary.refresh.waitingUntil as string) + 1000);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16]);

    // At the bound the app still lets a person try — and says the provider has been refusing.
    provider.syncFailure = undefined;
    const recovered = await analytics.refresh(post.id);
    expect(recovered.targets[0]?.totals?.views).toBe(4210);
    // A sync that gets through clears the wait and the count: getting an answer is proof the limit
    // has passed.
    expect(readAnalyticsSync(db)).toEqual({ lastSyncedAt: now.toISOString() });
    expect(recovered.refresh).toEqual({ allowed: true, attempts: 0, exhausted: false });
  });

  it('names an ordinary failure without inventing a wait for it', async () => {
    const { post, provider, analytics } = await withStoredFigures();
    provider.listFailure = new Error('socket hang up');
    const summary = await analytics.refresh(post.id);

    expect(summary.targets[0]?.totals?.views).toBe(4210);
    expect(summary.refresh.reason).toContain('socket hang up');
    // A network blip is not the provider telling this app to slow down, so nothing is locked and the
    // shared rate-limit record is untouched.
    expect(summary.refresh.waitingUntil).toBeUndefined();
    expect(readSyncHealth(db)?.rateLimitedUntil).toBeUndefined();
    // Nothing is locked: the next press is allowed immediately rather than after a wait this app
    // made up.
    expect(analytics.read(post.id).refresh.allowed).toBe(true);
    expect(readAnalyticsSync(db)?.waitingUntil).toBeUndefined();
  });

  it('keeps the daily history it already had when only the day read fails', async () => {
    const { post, provider, analytics } = await withStoredFigures();
    provider.daysFailure = new Error('Post Bridge refused the request (500).');
    provider.records = [
      { ...(provider.records[0] as (typeof provider.records)[number]), views: 5000 },
    ];
    const summary = await analytics.refresh(post.id);

    // The total that was read is stored, and the history that could not be read is the one that was
    // stored before — not an empty list.
    expect(summary.targets[0]?.totals?.views).toBe(5000);
    expect(summary.targets[0]?.days).toHaveLength(2);
  });
});

describe('reconciliation and the provider’s result identity', () => {
  const targets = [{ id: 1, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' }];
  const publisher = (provider: MockPublishProvider) =>
    new PublishService(db, new LocalSignalProvider(db), provider, 'America/New_York', clock);

  async function submitted(provider: MockPublishProvider) {
    const post = seedSignalPost(db, { channels: ['x'], date: '2027-08-14' });
    const service = publisher(provider);
    const plan = await service.preview(post.id);
    return { post, service, publication: await service.submit(post.id, plan.planHash) };
  }

  it('captures it per target, so there is something to ask analytics about', async () => {
    const provider = new MockPublishProvider(targets);
    const { service, publication } = await submitted(provider);
    // The submit response carried no per-account rows, which is the ordinary case: `post-results`
    // exists only once the provider has tried to deliver.
    expect(publication.targets[0]?.resultId).toBeUndefined();

    provider.result = {
      providerPostId: 'mock-publication',
      state: 'CONFIRMED',
      targets: [
        {
          accountId: 1,
          outcome: 'SUCCESS',
          resultId: 'result-x-1',
          permalink: 'https://x.example/status/1',
        },
      ],
    };
    const checked = await service.reconcile(publication.id);
    expect(checked.targets[0]?.resultId).toBe('result-x-1');
    expect(
      db.prepare('SELECT post_result_id FROM signal_publication_targets').get() as {
        post_result_id: string;
      },
    ).toEqual({ post_result_id: 'result-x-1' });
  });

  it('never erases a captured identity with a later answer that omits one', async () => {
    const provider = new MockPublishProvider(targets);
    const { service, publication } = await submitted(provider);
    provider.result = {
      providerPostId: 'mock-publication',
      state: 'CONFIRMED',
      targets: [{ accountId: 1, outcome: 'SUCCESS', resultId: 'result-x-1' }],
    };
    await service.reconcile(publication.id);
    // An answer that says nothing about the identity has said nothing about it — it is not a claim
    // that the delivery no longer has one.
    provider.result = {
      providerPostId: 'mock-publication',
      state: 'CONFIRMED',
      targets: [{ accountId: 1, outcome: 'SUCCESS', permalink: 'https://x.example/status/1' }],
    };
    const again = await service.reconcile(publication.id);
    expect(again.targets[0]?.resultId).toBe('result-x-1');
    expect(again.targets[0]?.permalink).toBe('https://x.example/status/1');
  });
});

describe('the figures routes', () => {
  it('reads without touching the provider and refreshes only when asked', async () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1, resultId: 'result-tt' }]);
    const provider = loadedProvider();
    const app = createApp(db, {
      publish: new MockPublishProvider(),
      analytics: provider,
      publishTimezone: 'America/New_York',
      now: clock,
    });

    const stored = await request(app).get(`/api/signal/posts/${post.id}/metrics`).expect(200);
    expect(stored.body.targets[0].availability).toBe('AWAITING_SYNC');
    expect(provider.syncs).toEqual([]);

    const refreshed = await request(app)
      .post(`/api/signal/posts/${post.id}/metrics/refresh`)
      .expect(200);
    expect(refreshed.body.targets[0].totals.views).toBe(4210);
    expect(provider.syncs).toHaveLength(1);
  });

  it('answers a refused refresh with the stored figures rather than an error status', async () => {
    const post = seedSignalPost(db, { channels: ['tt'] });
    seedDelivery(post.id, [{ channel: 'tt', accountId: 1, resultId: 'result-tt' }]);
    const provider = loadedProvider();
    const app = createApp(db, {
      publish: new MockPublishProvider(),
      analytics: provider,
      publishTimezone: 'America/New_York',
      now: clock,
    });
    await request(app).post(`/api/signal/posts/${post.id}/metrics/refresh`).expect(200);
    provider.syncFailure = new PublishProviderError(
      'Post Bridge refused the request (429).',
      false,
      {
        rateLimited: true,
        retryAfterSeconds: 30,
      },
    );

    // A 4xx here would leave the panel showing nothing where it should be showing the last known
    // good values, which is the whole point of the criterion.
    const refused = await request(app)
      .post(`/api/signal/posts/${post.id}/metrics/refresh`)
      .expect(200);
    expect(refused.body.targets[0].totals.views).toBe(4210);
    expect(refused.body.refresh.allowed).toBe(false);
    expect(refused.body.refresh.retryAfterSeconds).toBe(30);
  });
});
