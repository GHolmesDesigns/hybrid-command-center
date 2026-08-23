import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from '../db.ts';
import { createApp } from '../app.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { MockAnalyticsWindowProvider, MockPublishProvider } from './mock-provider.ts';
import { AnalyticsWindowService, analyticsWindowQuery } from './analytics-window.ts';
import { UnavailableAnalyticsWindowProvider } from './analytics-window-provider.ts';
import { PublishProviderError } from './provider.ts';
import { readSyncHealth, recordSyncHealth } from './sync-health.ts';
import {
  ANALYTICS_WINDOW_PAGE_MAX,
  ANALYTICS_WINDOW_ROW_MAX,
  type AnalyticsWindowRow,
  type AnalyticsWindowSnapshot,
} from '../../shared/publish-analytics-window.ts';

/**
 * The window refresh: every page read before anything is written, one generation replaced or none.
 *
 * The fixtures are the card's own list — several pages, a repeated offset, an unreadable page, a page
 * that fails, an unmapped row — and each is checked for the same three things: what the snapshot holds
 * afterwards, what the log says happened, and whether the per-delivery figures were touched. A refresh
 * that could not finish must leave the *complete* previous generation, which is why the failure cases
 * assert on the rows that were already there rather than only on the absence of new ones.
 *
 * Every test that reaches the provider passes an explicit offered-window set, because the app itself
 * offers none: `ANALYTICS_WINDOW_EVIDENCE` records §14's four unverified rows, and the refusal that
 * produces is its own case below.
 */

let db: Db;
const NOW = new Date('2026-08-23T12:00:00.000Z');
const clock = () => NOW;

beforeEach(() => {
  db = createDb(':memory:');
});

/** A service that may ask about `30d`, which is the seam a fixture needs. See the class comment. */
const service = (provider: MockAnalyticsWindowProvider | UnavailableAnalyticsWindowProvider) =>
  new AnalyticsWindowService(db, provider, clock, ['30d']);

const row = (overrides: Partial<AnalyticsWindowRow> = {}): AnalyticsWindowRow => ({
  analyticsId: 'an-1',
  postResultId: 'result-1',
  platform: 'instagram',
  views: 100,
  likes: 10,
  comments: 2,
  shares: 1,
  ...overrides,
});

/** A provider holding one complete page. */
const holding = (rows: AnalyticsWindowRow[], warnings: string[] = []) => {
  const provider = new MockAnalyticsWindowProvider();
  provider.hold(rows, warnings);
  return provider;
};

/**
 * A delivery this app made, carrying the provider's result identity.
 *
 * Written directly rather than through `PublishService.submit`: these cases are about a window read,
 * and driving them through preflight would make each one also a statement about media bounds.
 */
function seedDelivery(
  resultId: string,
  options: { accountId?: number; handle?: string; channel?: string } = {},
) {
  const post = seedSignalPost(db);
  const id = `publication-${resultId}`;
  db.prepare(
    `INSERT INTO signal_publications(
       id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
       sent_caption,sent_channels,created_at,updated_at
     ) VALUES(?,?,'CONFIRMED','post-bridge',?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    post.id,
    `remote-${resultId}`,
    `key-${resultId}`,
    '2026-08-21T15:35:00.000Z',
    'America/New_York',
    'A clear campaign post',
    '["ig"]',
    '2026-08-21T09:00:00.000Z',
    '2026-08-21T09:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO signal_publication_targets(
       publication_id,channel,provider_account_id,handle,mode,outcome,post_result_id
     ) VALUES(?,?,?,?,'AUTOMATIC','SUCCESS',?)`,
  ).run(
    id,
    options.channel ?? 'ig',
    options.accountId ?? 901,
    options.handle ?? 'gholmesdesigns',
    resultId,
  );
  return post;
}

const events = () =>
  listIntegrationEvents(db).filter(
    (event) => event.operation === 'signal.analytics-window-refresh',
  );

const storedResultIds = () =>
  (
    db
      .prepare('SELECT post_result_id FROM signal_analytics_window_metrics ORDER BY post_result_id')
      .all() as { post_result_id: string }[]
  ).map((entry) => entry.post_result_id);

describe('reading is local', () => {
  it('makes no provider call on any path through read', () => {
    seedDelivery('result-1');
    const provider = holding([row()]);
    const snapshot = service(provider).read('instagram', '30d');
    expect(provider.reads).toEqual([]);
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]).toMatchObject({ deliveries: 1, measuredDeliveries: 0 });
    expect(snapshot.lastRefreshAt).toBeUndefined();
  });

  it('reports the windows the app may offer, which today is none', () => {
    const snapshot = new AnalyticsWindowService(db, holding([]), clock).read('instagram', '30d');
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.verified).toBe(false);
    expect(snapshot.meaning).toContain('has not been observed');
  });
});

describe('a window with no dated result is refused before any provider call', () => {
  /**
   * The gate this card ships behind. Asking would return rows this app has no verified way to
   * describe, so the refusal happens before a request is built — and it is not an *attempt*, so it
   * writes no event, exactly as an unconfigured provider does not.
   */
  it('refuses, contacts nothing, writes nothing, and says why', async () => {
    seedDelivery('result-1');
    const provider = holding([row()]);
    // The real offered set: the evidence table's own, which verifies nothing.
    const snapshot = await new AnalyticsWindowService(db, provider, clock).refresh(
      'instagram',
      '30d',
    );
    expect(provider.reads).toEqual([]);
    expect(storedResultIds()).toEqual([]);
    expect(events()).toEqual([]);
    expect(snapshot.reason).toContain('has not been observed');
    expect(snapshot.verified).toBe(false);
  });

  it('offers the fixture sentence rather than a verified meaning when only a seam allows it', () => {
    const snapshot = service(holding([])).read('instagram', '30d');
    expect(snapshot.verified).toBe(true);
    expect(snapshot.meaning).toContain('test fixture');
    // A seam window must never borrow a verified window's description.
    expect(snapshot.meaning).toContain('still unverified');
  });
});

describe('reading every page before writing anything', () => {
  it('walks each page in turn and stores the whole window once', async () => {
    seedDelivery('result-1');
    seedDelivery('result-2', { accountId: 901 });
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [
      { rows: [row({ postResultId: 'result-1' })], next: { offset: 100 }, warnings: [] },
      {
        rows: [row({ analyticsId: 'an-2', postResultId: 'result-2', views: 50 })],
        next: { done: true },
        warnings: [],
      },
    ];
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(provider.reads.map((read) => read.pageToken)).toEqual([0, 100]);
    expect(provider.reads.every((read) => read.timeframe === '30d')).toBe(true);
    expect(storedResultIds()).toEqual(['result-1', 'result-2']);
    expect(snapshot.groups[0]).toMatchObject({
      deliveries: 2,
      measuredDeliveries: 2,
      totals: { views: 150, likes: 20, comments: 4, shares: 2 },
    });
    expect(snapshot.lastRefreshAt).toBe(NOW.toISOString());
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ outcome: 'SUCCESS' });
  });

  it('replaces the whole generation rather than merging into it', async () => {
    seedDelivery('result-1');
    seedDelivery('result-2');
    await service(holding([row({ postResultId: 'result-1' })])).refresh('instagram', '30d');
    expect(storedResultIds()).toEqual(['result-1']);
    // A later read that names a different delivery leaves no trace of the first.
    await service(holding([row({ analyticsId: 'an-2', postResultId: 'result-2' })])).refresh(
      'instagram',
      '30d',
    );
    expect(storedResultIds()).toEqual(['result-2']);
  });

  it('keeps each platform and window in its own generation', async () => {
    seedDelivery('result-1');
    // Three complete pages, because the mock answers in call order and this drives three refreshes.
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = Array.from({ length: 3 }, () => ({
      rows: [row()],
      next: { done: true } as const,
      warnings: [],
    }));
    const wide = new AnalyticsWindowService(db, provider, clock, ['30d', 'all']);
    await wide.refresh('instagram', '30d');
    await wide.refresh('instagram', 'all');
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM signal_analytics_window_metrics WHERE platform=? AND timeframe=?',
        )
        .get('instagram', '30d'),
    ).toMatchObject({ n: 1 });
    expect(wide.read('instagram', 'all').counts.rows).toBe(1);
    // Replacing one window leaves the other exactly as it was.
    await wide.refresh('instagram', '30d');
    expect(wide.read('instagram', 'all').counts.rows).toBe(1);
  });

  it('keeps the last page’s version of a row that moved while the walk ran', async () => {
    seedDelivery('result-1');
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [
      { rows: [row({ views: 1 })], next: { offset: 100 }, warnings: [] },
      { rows: [row({ views: 999 })], next: { done: true }, warnings: [] },
    ];
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(snapshot.groups[0]?.totals?.views).toBe(999);
    expect(storedResultIds()).toEqual(['result-1']);
  });
});

describe('a read that cannot finish replaces nothing', () => {
  /** The prior generation has to survive whole, which is why each case seeds one first. */
  const seedPriorGeneration = async () => {
    seedDelivery('result-1');
    await service(holding([row({ postResultId: 'result-1', views: 7 })])).refresh(
      'instagram',
      '30d',
    );
    expect(storedResultIds()).toEqual(['result-1']);
  };

  it('leaves the previous window in place when the provider refuses a page', async () => {
    await seedPriorGeneration();
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [
      { rows: [row({ postResultId: 'other' })], next: { offset: 100 }, warnings: [] },
    ];
    provider.failureAt = 2;
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(storedResultIds()).toEqual(['result-1']);
    expect(snapshot.groups[0]?.totals?.views).toBe(7);
    expect(snapshot.reason).toContain('could not be read, so nothing was replaced');
    expect(events()).toHaveLength(2);
    expect(events()[0]).toMatchObject({ outcome: 'FAILURE' });
    // The last complete read is still reported, beside the reason the newest one failed.
    expect(snapshot.lastRefreshAt).toBe(NOW.toISOString());
  });

  it('refuses a next-page token nobody has verified', async () => {
    await seedPriorGeneration();
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [{ rows: [], next: { unknown: 'NEXT' }, warnings: [] }];
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(storedResultIds()).toEqual(['result-1']);
    expect(snapshot.reason).toContain('has not verified');
  });

  it('names a missing pagination envelope as its own failure', async () => {
    await seedPriorGeneration();
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [{ rows: [], next: { unknown: 'META' }, warnings: [] }];
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(snapshot.reason).toContain('without the pagination envelope');
    expect(storedResultIds()).toEqual(['result-1']);
  });

  it('stops a walk whose token does not advance rather than repeating it', async () => {
    await seedPriorGeneration();
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [
      { rows: [row({ postResultId: 'other' })], next: { offset: 0 }, warnings: [] },
    ];
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(provider.reads).toHaveLength(1);
    expect(snapshot.reason).toContain('did not advance past offset 0');
    expect(storedResultIds()).toEqual(['result-1']);
  });

  it('stops at the page bound rather than walking for ever', async () => {
    await seedPriorGeneration();
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = Array.from({ length: ANALYTICS_WINDOW_PAGE_MAX }, (_unused, index) => ({
      rows: [row({ analyticsId: `an-${index}`, postResultId: `page-${index}` })],
      next: { offset: (index + 1) * 100 },
      warnings: [],
    }));
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(provider.reads).toHaveLength(ANALYTICS_WINDOW_PAGE_MAX);
    expect(snapshot.reason).toContain('safety bound');
    expect(storedResultIds()).toEqual(['result-1']);
  });

  it('stops at the row bound rather than storing an unbounded window', async () => {
    await seedPriorGeneration();
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [
      {
        rows: Array.from({ length: ANALYTICS_WINDOW_ROW_MAX + 1 }, (_unused, index) => ({
          ...row({ analyticsId: `an-${index}`, postResultId: `bulk-${index}` }),
        })),
        next: { offset: 100 },
        warnings: [],
      },
    ];
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(snapshot.reason).toContain('past the safety bound');
    expect(storedResultIds()).toEqual(['result-1']);
  });

  it('records a rate limit against the shared connection record', async () => {
    seedDelivery('result-1');
    const provider = new MockAnalyticsWindowProvider();
    provider.pages = [];
    provider.failureAt = 1;
    provider.failure = new PublishProviderError('Rate limited.', false, {
      rateLimited: true,
      retryAfterSeconds: 30,
    });
    await service(provider).refresh('instagram', '30d');
    expect(readSyncHealth(db)?.rateLimitedUntil).toBe(
      new Date(NOW.getTime() + 30_000).toISOString(),
    );
  });

  it('does not ask while a rate limit is in force, and records no attempt', async () => {
    seedDelivery('result-1');
    recordSyncHealth(db, { rateLimitedUntil: new Date(NOW.getTime() + 60_000).toISOString() });
    const provider = holding([row()]);
    const snapshot = await service(provider).refresh('instagram', '30d');
    expect(provider.reads).toEqual([]);
    expect(events()).toEqual([]);
    expect(snapshot.reason).toContain('rate-limiting this app until');
  });

  /**
   * The guard on the unconfigured provider itself. The service checks `available` and never reaches
   * it, so this asserts the guard is a named failure rather than an empty page — "the provider reports
   * nothing" and "this app cannot ask" are different claims.
   */
  it('fails rather than answering an empty page when nothing is configured', async () => {
    await expect(
      new UnavailableAnalyticsWindowProvider().listWindow({
        platform: 'instagram',
        timeframe: '30d',
      }),
    ).rejects.toThrow(/POST_BRIDGE_API_KEY/);
  });

  it('explains an unconfigured provider rather than recording an attempt', async () => {
    const snapshot = await service(new UnavailableAnalyticsWindowProvider()).refresh(
      'instagram',
      '30d',
    );
    expect(events()).toEqual([]);
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toContain('POST_BRIDGE_API_KEY');
  });
});

describe('rows the provider named that no delivery here claims', () => {
  it('stores and counts them, and calls the refresh a success', async () => {
    seedDelivery('result-1');
    const snapshot = await service(
      holding([
        row({ postResultId: 'result-1', views: 100 }),
        row({ analyticsId: 'an-x', postResultId: 'made-elsewhere', views: 9_000 }),
      ]),
    ).refresh('instagram', '30d');
    expect(snapshot.counts).toEqual({ rows: 2, mapped: 1, unmapped: 1 });
    expect(snapshot.unmapped.map((entry) => entry.postResultId)).toEqual(['made-elsewhere']);
    // Visible, and excluded from the account it cannot belong to.
    expect(snapshot.groups[0]?.totals?.views).toBe(100);
    const [event] = events();
    expect(event).toMatchObject({ outcome: 'SUCCESS' });
    expect(event?.summary).toContain('1 of them matching no delivery here');
  });

  it('carries a refused provenance value into the log without failing the read', async () => {
    seedDelivery('result-1');
    const snapshot = await service(holding([row()], ['Ignored the match value on x.'])).refresh(
      'instagram',
      '30d',
    );
    expect(snapshot.counts.rows).toBe(1);
    expect(events()[0]?.summary).toContain('Ignored the match value on x.');
    expect(events()[0]).toMatchObject({ outcome: 'SUCCESS' });
  });
});

describe('what this path must never touch', () => {
  it('writes no per-delivery figure, post, publication, or target', async () => {
    seedDelivery('result-1');
    const before = {
      metrics: db.prepare('SELECT COUNT(*) AS n FROM signal_post_metrics').get(),
      days: db.prepare('SELECT COUNT(*) AS n FROM signal_post_metric_days').get(),
      posts: db.prepare('SELECT COUNT(*) AS n FROM signal_posts').get(),
      targets: db.prepare('SELECT * FROM signal_publication_targets').all(),
    };
    await service(holding([row()])).refresh('instagram', '30d');
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_post_metrics').get()).toEqual(
      before.metrics,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_post_metric_days').get()).toEqual(
      before.days,
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_posts').get()).toEqual(before.posts);
    expect(db.prepare('SELECT * FROM signal_publication_targets').all()).toEqual(before.targets);
  });

  /**
   * The interface it holds has one method and that method lists, so there is no `sync` to spend. This
   * asserts the shape rather than the behaviour, because the guarantee is structural.
   */
  it('holds a provider with no way to synchronise, submit, update, or cancel', () => {
    const provider = holding([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(provider))).toEqual(
      expect.arrayContaining(['listWindow']),
    );
    expect(provider).not.toHaveProperty('sync');
    expect(provider).not.toHaveProperty('submit');
  });

  it('counts a delivery with no provider result identity in no denominator', async () => {
    const post = seedSignalPost(db);
    db.prepare(
      `INSERT INTO signal_publications(
         id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
         sent_caption,sent_channels,created_at,updated_at
       ) VALUES('pub-none',?,'CONFIRMED','post-bridge','remote-none','key-none',
                '2026-08-21T15:35:00.000Z','America/New_York','A post','["ig"]',
                '2026-08-21T09:00:00.000Z','2026-08-21T09:00:00.000Z')`,
    ).run(post.id);
    db.prepare(
      `INSERT INTO signal_publication_targets(
         publication_id,channel,provider_account_id,handle,mode,outcome
       ) VALUES('pub-none','ig',901,'gholmesdesigns','AUTOMATIC','SUCCESS')`,
    ).run();
    expect(service(holding([])).read('instagram', '30d').groups).toEqual([]);
  });

  it('counts a delivery on another platform in no denominator', () => {
    seedDelivery('result-x', { channel: 'x', accountId: 902, handle: '@studio' });
    expect(service(holding([])).read('instagram', '30d').groups).toEqual([]);
    expect(service(holding([])).read('tiktok', '30d').groups).toEqual([]);
  });
});

describe('the request boundary', () => {
  it('requires a real platform and a real window', () => {
    expect(analyticsWindowQuery.parse({ platform: 'instagram', timeframe: '30d' })).toEqual({
      platform: 'instagram',
      timeframe: '30d',
    });
    expect(() => analyticsWindowQuery.parse({ platform: 'threads', timeframe: '30d' })).toThrow();
    expect(() => analyticsWindowQuery.parse({ platform: 'instagram', timeframe: '1d' })).toThrow();
    expect(() => analyticsWindowQuery.parse({ platform: 'instagram' })).toThrow();
  });

  it('answers a stored read over HTTP and spends no provider request doing it', async () => {
    seedDelivery('result-1');
    const provider = holding([row()]);
    const app = createApp(db, {
      publish: new MockPublishProvider(),
      analyticsWindow: provider,
      analyticsWindows: ['30d'],
    });
    const response = await request(app)
      .get('/api/signal/analytics/window')
      .query({ platform: 'instagram', timeframe: '30d' });
    expect(response.status).toBe(200);
    expect((response.body as AnalyticsWindowSnapshot).groups).toHaveLength(1);
    expect(provider.reads).toEqual([]);
  });

  it('refreshes on a person’s own press and answers with the new snapshot', async () => {
    seedDelivery('result-1');
    const provider = holding([row()]);
    const app = createApp(db, {
      publish: new MockPublishProvider(),
      analyticsWindow: provider,
      analyticsWindows: ['30d'],
    });
    const response = await request(app)
      .post('/api/signal/analytics/window/refresh')
      .send({ platform: 'instagram', timeframe: '30d' });
    expect(response.status).toBe(200);
    expect((response.body as AnalyticsWindowSnapshot).counts.rows).toBe(1);
    expect(provider.reads).toHaveLength(1);
  });

  /**
   * A failed read is not a `4xx`. The panel needs the stored snapshot and the reason together, because
   * showing nothing where a stored window belongs would present a failure as an empty window.
   */
  it('answers a failed refresh with the stored snapshot and the reason', async () => {
    seedDelivery('result-1');
    const provider = new MockAnalyticsWindowProvider();
    provider.failureAt = 1;
    const app = createApp(db, {
      publish: new MockPublishProvider(),
      analyticsWindow: provider,
      analyticsWindows: ['30d'],
    });
    const response = await request(app)
      .post('/api/signal/analytics/window/refresh')
      .send({ platform: 'instagram', timeframe: '30d' });
    expect(response.status).toBe(200);
    expect((response.body as AnalyticsWindowSnapshot).reason).toContain('nothing was replaced');
  });

  it('rejects a window the request invented', async () => {
    const app = createApp(db, { publish: new MockPublishProvider() });
    const response = await request(app)
      .get('/api/signal/analytics/window')
      .query({ platform: 'instagram', timeframe: 'forever' });
    expect(response.status).toBe(400);
  });

  /** The default build offers nothing, so the route says so rather than reaching a provider. */
  it('refuses a refresh in a build with no verified window', async () => {
    seedDelivery('result-1');
    const provider = holding([row()]);
    const app = createApp(db, {
      publish: new MockPublishProvider(),
      analyticsWindow: provider,
    });
    const response = await request(app)
      .post('/api/signal/analytics/window/refresh')
      .send({ platform: 'instagram', timeframe: '30d' });
    expect(response.status).toBe(200);
    expect((response.body as AnalyticsWindowSnapshot).windows).toEqual([]);
    expect(provider.reads).toEqual([]);
    expect(events()).toEqual([]);
  });
});
