import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { backfillProviderAccounts, createDb, type Db } from '../db.ts';
import { createApp } from '../app.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { readQueueHealth } from '../signal/queue-health.ts';
import { seedSignalPost } from '../signal/test-fixture.ts';
import { MockProviderInventoryProvider, MockPublishProvider } from './mock-provider.ts';
import { ProviderInventoryService, readProviderInventoryRecord } from './inventory.ts';
import { UnavailableProviderInventoryProvider } from './inventory-provider.ts';
import { readProviderInventoryEntries } from './inventory-rows.ts';
import { PublishProviderError } from './provider.ts';
import { readSyncHealth, recordSyncHealth } from './sync-health.ts';
import {
  PROVIDER_INVENTORY_PAGE_MAX,
  PROVIDER_INVENTORY_ROW_MAX,
  type ProviderInventoryPost,
  type ProviderInventorySnapshot,
} from '../../shared/provider-inventory.ts';

/**
 * The inventory refresh: every page read before anything is written, and one generation replaced or
 * none.
 *
 * The fixtures here are the card's own list — several pages, a repeated offset, a malformed row, a
 * page that fails — and each of them is checked for the same two things: what the inventory holds
 * afterwards, and what the log says happened. A refresh that could not finish must leave the
 * *complete* previous generation, not a subset of it, which is why the failure cases assert on the
 * rows that were already there rather than only on the absence of new ones.
 */

let db: Db;
const NOW = new Date('2026-08-19T12:00:00.000Z');
const clock = () => NOW;

beforeEach(() => {
  db = createDb(':memory:');
});

const listed = (overrides: Partial<ProviderInventoryPost> = {}): ProviderInventoryPost => ({
  providerPostId: 'remote-1',
  state: 'SCHEDULED',
  scheduledInstant: '2026-08-20T13:00:00.000Z',
  captionExcerpt: 'Scheduled straight in Post Bridge',
  accountIds: [901],
  ...overrides,
});

const service = (provider: MockProviderInventoryProvider) =>
  new ProviderInventoryService(db, provider, clock);

/** A provider holding one page of posts and saying so. */
const holding = (posts: ProviderInventoryPost[]) => {
  const provider = new MockProviderInventoryProvider();
  provider.hold(posts);
  return provider;
};

/**
 * A delivery this app made, which is what claims a provider id.
 *
 * Written directly rather than through `PublishService.submit`: these cases are about an inventory,
 * and driving them through preflight would make each one also a statement about media bounds.
 */
function seedPublication(
  providerPostId: string,
  options: { accountId?: number; handle?: string; channel?: string } = {},
) {
  const post = seedSignalPost(db);
  const id = `publication-${providerPostId}`;
  db.prepare(
    `INSERT INTO signal_publications(
       id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
       sent_caption,sent_channels,created_at,updated_at
     ) VALUES(?,?,'CONFIRMED','post-bridge',?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    post.id,
    providerPostId,
    `key-${providerPostId}`,
    '2026-08-18T13:00:00.000Z',
    'America/New_York',
    'A clear campaign post',
    '["x"]',
    '2026-08-18T09:00:00.000Z',
    '2026-08-18T09:00:00.000Z',
  );
  db.prepare(
    `INSERT INTO signal_publication_targets(
       publication_id,channel,provider_account_id,handle,mode,outcome
     ) VALUES(?,?,?,?,'AUTOMATIC','SUCCESS')`,
  ).run(id, options.channel ?? 'x', options.accountId ?? 901, options.handle ?? '@studio');
  backfillProviderAccounts(db);
  return post;
}

const events = () =>
  listIntegrationEvents(db).filter(
    (event) => event.operation === 'signal.provider-inventory-refresh',
  );

const storedIds = () =>
  (
    db
      .prepare(
        `SELECT provider_post_id FROM signal_provider_inventory_posts
          WHERE provider='post-bridge' ORDER BY provider_post_id`,
      )
      .all() as { provider_post_id: string }[]
  ).map((row) => row.provider_post_id);

describe('reading every page before writing anything', () => {
  it('walks each page in turn and stores the whole inventory once', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [
      { posts: [listed({ providerPostId: 'a' })], next: { offset: 100 } },
      { posts: [listed({ providerPostId: 'b' })], next: { offset: 200 } },
      { posts: [listed({ providerPostId: 'c' })], next: { done: true } },
    ];
    const snapshot = await service(provider).refresh();
    expect(provider.reads).toEqual([0, 100, 200]);
    expect(storedIds()).toEqual(['a', 'b', 'c']);
    expect(snapshot.counts).toEqual({ posts: 3, orphans: 3 });
    expect(snapshot.lastRefreshAt).toBe(NOW.toISOString());
    expect(snapshot.reason).toBeUndefined();
    expect(events()).toHaveLength(1);
    expect(events()[0]?.outcome).toBe('SUCCESS');
  });

  it('follows a next-page URL the same way it follows an offset', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [
      { posts: [listed({ providerPostId: 'a' })], next: { offset: 100 } },
      { posts: [listed({ providerPostId: 'b' })], next: { done: true } },
    ];
    await service(provider).refresh();
    expect(provider.reads).toEqual([0, 100]);
    expect(storedIds()).toEqual(['a', 'b']);
  });

  it('counts a post that shifts between pages once, keeping what the later page said', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [
      { posts: [listed({ providerPostId: 'a', state: 'SCHEDULED' })], next: { offset: 100 } },
      { posts: [listed({ providerPostId: 'a', state: 'PUBLISHED' })], next: { done: true } },
    ];
    const snapshot = await service(provider).refresh();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.state).toBe('PUBLISHED');
  });

  it('writes nothing at all when a later page fails', async () => {
    await service(holding([listed({ providerPostId: 'kept' })])).refresh();
    const provider = new MockProviderInventoryProvider();
    provider.pages = [{ posts: [listed({ providerPostId: 'new' })], next: { offset: 100 } }];
    provider.failureAt = 2;
    provider.failure = new PublishProviderError('Post Bridge refused the request (500).', false);
    const snapshot = await service(provider).refresh();
    // The prior generation is whole: the page that did arrive was never written.
    expect(storedIds()).toEqual(['kept']);
    expect(snapshot.lastRefreshAt).toBe(NOW.toISOString());
    expect(snapshot.reason).toContain('nothing was replaced');
    expect(snapshot.reason).toContain('refused the request (500)');
    expect(events().map((event) => event.outcome)).toEqual(['FAILURE', 'SUCCESS']);
  });

  it('writes nothing when a page cannot be read at all', async () => {
    await service(holding([listed({ providerPostId: 'kept' })])).refresh();
    const provider = new MockProviderInventoryProvider();
    provider.failureAt = 1;
    provider.failure = new PublishProviderError(
      'Post Bridge listed a post this app cannot read: a row carries no id',
      false,
    );
    const snapshot = await service(provider).refresh();
    expect(storedIds()).toEqual(['kept']);
    expect(snapshot.reason).toContain('a row carries no id');
  });

  it('stops rather than repeating a page when the next offset does not advance', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [
      { posts: [listed({ providerPostId: 'a' })], next: { offset: 100 } },
      { posts: [listed({ providerPostId: 'b' })], next: { offset: 100 } },
    ];
    const snapshot = await service(provider).refresh();
    expect(provider.reads).toEqual([0, 100]);
    expect(storedIds()).toEqual([]);
    expect(snapshot.reason).toContain('did not advance past offset 100');
  });

  it('refuses a next-page token nobody has verified rather than guessing at a cursor', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [{ posts: [listed()], next: { unknown: 'NEXT_STRING' } }];
    const snapshot = await service(provider).refresh();
    expect(storedIds()).toEqual([]);
    expect(snapshot.reason).toContain('has not verified');
  });

  it('refuses a page with no pagination envelope', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [{ posts: [listed()], next: { unknown: 'META' } }];
    expect((await service(provider).refresh()).reason).toContain('without the pagination envelope');
    expect(storedIds()).toEqual([]);
  });

  it('stops at the page bound rather than walking for ever', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = Array.from({ length: PROVIDER_INVENTORY_PAGE_MAX + 1 }, (_, index) => ({
      posts: [listed({ providerPostId: `page-${index}` })],
      next: { offset: (index + 1) * 100 },
    }));
    const snapshot = await service(provider).refresh();
    expect(provider.reads).toHaveLength(PROVIDER_INVENTORY_PAGE_MAX);
    expect(storedIds()).toEqual([]);
    expect(snapshot.reason).toContain(`${PROVIDER_INVENTORY_PAGE_MAX} pages`);
  });

  it('stops at the row bound when one page carries more than a whole read may hold', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [
      {
        posts: Array.from({ length: PROVIDER_INVENTORY_ROW_MAX + 1 }, (_, index) =>
          listed({ providerPostId: `row-${index}` }),
        ),
        next: { done: true },
      },
    ];
    const snapshot = await service(provider).refresh();
    expect(storedIds()).toEqual([]);
    expect(snapshot.reason).toContain('past the safety bound');
  });
});

describe('replacing one generation with another', () => {
  it('removes what the provider no longer lists, updates what changed, and adds what is new', async () => {
    await service(
      holding([listed({ providerPostId: 'gone' }), listed({ providerPostId: 'moved' })]),
    ).refresh();
    const later = new Date('2026-08-19T15:00:00.000Z');
    const snapshot = await new ProviderInventoryService(
      db,
      holding([
        listed({ providerPostId: 'moved', state: 'PUBLISHED', captionExcerpt: 'Now published' }),
        listed({ providerPostId: 'fresh' }),
      ]),
      () => later,
    ).refresh();
    expect(storedIds()).toEqual(['fresh', 'moved']);
    expect(snapshot.entries.find((entry) => entry.providerPostId === 'moved')).toMatchObject({
      state: 'PUBLISHED',
      captionExcerpt: 'Now published',
    });
    // One generation: every row carries the same stamp, so nothing on screen is from two reads.
    expect([...new Set(snapshot.entries.map((entry) => entry.snapshotAt))]).toEqual([
      later.toISOString(),
    ]);
  });

  it('stores an empty inventory as an empty inventory, which is a real answer', async () => {
    await service(holding([listed()])).refresh();
    const snapshot = await service(holding([])).refresh();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.counts).toEqual({ posts: 0, orphans: 0 });
    expect(snapshot.lastRefreshAt).toBe(NOW.toISOString());
  });

  it('stores the fields a row is, and nothing beyond them', async () => {
    await service(
      holding([
        listed({
          providerPostId: 'remote-7',
          scheduledInstant: null,
          providerUrl: 'https://p.example/remote-7',
          accountIds: [901, 902],
        }),
      ]),
    ).refresh();
    expect(readProviderInventoryEntries(db)[0]).toEqual({
      provider: 'post-bridge',
      providerPostId: 'remote-7',
      state: 'SCHEDULED',
      scheduledInstant: null,
      captionExcerpt: 'Scheduled straight in Post Bridge',
      accountIds: [],
      accountRefs: ['901', '902'],
      providerUrl: 'https://p.example/remote-7',
      snapshotAt: NOW.toISOString(),
      orphan: true,
      accounts: [
        { provider: 'post-bridge', accountRef: '901' },
        { provider: 'post-bridge', accountRef: '902' },
      ],
    });
  });

  it('labels an account this workspace has delivered to, and leaves the rest as ids', async () => {
    seedPublication('remote-1', { accountId: 901, handle: '@studio', channel: 'ig' });
    await service(holding([listed({ providerPostId: 'other', accountIds: [901, 999] })])).refresh();
    expect(readProviderInventoryEntries(db)[0]?.accounts).toEqual([
      {
        accountId: 901,
        provider: 'post-bridge',
        accountRef: '901',
        handle: '@studio',
        channel: 'ig',
      },
      { provider: 'post-bridge', accountRef: '999' },
    ]);
  });
});

describe('what the log says happened', () => {
  it('writes one honest success per attempt, counting the posts nobody here sent', async () => {
    seedPublication('ours');
    await service(
      holding([listed({ providerPostId: 'ours' }), listed({ providerPostId: 'theirs' })]),
    ).refresh();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      source: 'signal-campaign',
      operation: 'signal.provider-inventory-refresh',
      outcome: 'SUCCESS',
      summary: 'Read the whole provider inventory: 2 posts, 1 of them not created here.',
    });
    // It touched no local record, so it names none.
    expect(events()[0]?.entities).toEqual([]);
  });

  it('reads one post in the singular', async () => {
    await service(holding([listed()])).refresh();
    expect(events()[0]?.summary).toBe(
      'Read the whole provider inventory: 1 post, 1 of them not created here.',
    );
  });

  it('writes one failure per failed attempt, with the provider’s words redacted', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.failureAt = 1;
    provider.failure = new Error('refused for api_key=pb_live_secret_value');
    await service(provider).refresh();
    expect(events()).toHaveLength(1);
    expect(events()[0]?.outcome).toBe('FAILURE');
    expect(events()[0]?.error).toContain('api_key=[redacted]');
    expect(events()[0]?.error).not.toContain('pb_live_secret_value');
    expect(events()[0]?.summary).toContain('no snapshot row was replaced');
  });

  it('never reports PARTIAL, because the write is one transaction after every read', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.pages = [{ posts: [listed()], next: { offset: 0 } }];
    await service(provider).refresh();
    await service(holding([listed()])).refresh();
    expect(
      events()
        .map((event) => event.outcome)
        .sort(),
    ).toEqual(['FAILURE', 'SUCCESS']);
  });
});

describe('the two refusals that reach no provider', () => {
  it('says so when publishing is not configured, and writes nothing', async () => {
    const snapshot = await new ProviderInventoryService(
      db,
      new UnavailableProviderInventoryProvider(),
      clock,
    ).refresh();
    expect(snapshot.available).toBe(false);
    expect(snapshot.reason).toContain('POST_BRIDGE_API_KEY');
    expect(events()).toEqual([]);
    expect(storedIds()).toEqual([]);
  });

  it('refuses a direct page call rather than answering with an empty one', async () => {
    await expect(new UnavailableProviderInventoryProvider().page(0)).rejects.toThrow(
      'POST_BRIDGE_API_KEY',
    );
  });

  it('waits out a rate limit the provider already declared rather than asking again', async () => {
    await service(holding([listed()])).refresh();
    recordSyncHealth(db, { rateLimitedUntil: '2026-08-19T12:30:00.000Z' });
    const provider = holding([]);
    const snapshot = await service(provider).refresh();
    expect(provider.reads).toEqual([]);
    expect(snapshot.reason).toContain('rate-limiting this app until 2026-08-19T12:30:00.000Z');
    expect(storedIds()).toEqual(['remote-1']);
    expect(events()).toHaveLength(1);
    expect(events()[0]?.outcome).toBe('SUCCESS');
  });

  it('asks again once the declared limit has passed', async () => {
    recordSyncHealth(db, { rateLimitedUntil: '2026-08-19T11:00:00.000Z' });
    const provider = holding([listed()]);
    await service(provider).refresh();
    expect(provider.reads).toEqual([0]);
  });

  it('records a fresh rate limit against the whole connection, as §9 requires', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.failureAt = 1;
    provider.failure = new PublishProviderError('Post Bridge refused the request (429).', false, {
      rateLimited: true,
      retryAfterSeconds: 120,
    });
    await service(provider).refresh();
    expect(readSyncHealth(db)?.rateLimitedUntil).toBe('2026-08-19T12:02:00.000Z');
    // The delivery answers were not synchronised by this read, so it claims nothing about them.
    expect(readSyncHealth(db)?.lastSyncedAt).toBeUndefined();
  });

  it('falls back to the documented wait when the provider named none', async () => {
    const provider = new MockProviderInventoryProvider();
    provider.failureAt = 1;
    provider.failure = new PublishProviderError('Post Bridge refused the request (429).', false, {
      rateLimited: true,
    });
    await service(provider).refresh();
    expect(readSyncHealth(db)?.rateLimitedUntil).toBe('2026-08-19T12:01:00.000Z');
  });
});

describe('reading the stored inventory', () => {
  it('makes no provider call, and says when it was last read', async () => {
    const provider = holding([listed()]);
    await service(provider).refresh();
    const reads = provider.reads.length;
    const snapshot = service(provider).read();
    expect(provider.reads).toHaveLength(reads);
    expect(snapshot.lastRefreshAt).toBe(NOW.toISOString());
    expect(snapshot.entries).toHaveLength(1);
  });

  it('reports nothing read yet for a workspace that has never refreshed', () => {
    const snapshot = service(holding([])).read();
    expect(snapshot).toMatchObject({
      available: true,
      entries: [],
      counts: { posts: 0, orphans: 0 },
    });
    expect(snapshot.lastRefreshAt).toBeUndefined();
  });

  it('treats a record it cannot parse as absent rather than guessing at it', () => {
    db.prepare(
      "INSERT INTO settings(key,value,updated_at) VALUES('signal_provider_inventory','{oops',?)",
    ).run(NOW.toISOString());
    expect(readProviderInventoryRecord(db)).toEqual({});
  });

  it('reads a stored state this build does not know as the fail-closed one', async () => {
    await service(holding([listed()])).refresh();
    db.prepare(
      "UPDATE signal_provider_inventory_posts SET state='INVENTED', account_refs='oops'",
    ).run();
    expect(readProviderInventoryEntries(db)[0]).toMatchObject({
      state: 'PROCESSING',
      accountIds: [],
    });
  });
});

describe('the alert derived from the stored rows', () => {
  it('raises one for a provider post no publication claims, and none for one that is claimed', async () => {
    seedPublication('ours');
    const provider = holding([
      listed({ providerPostId: 'ours' }),
      listed({ providerPostId: 'theirs' }),
    ]);
    await service(provider).refresh();
    const reads = provider.reads.length;
    const summary = readQueueHealth(db, NOW);
    const orphans = summary.alerts.filter((alert) => alert.kind === 'PROVIDER_ORPHAN');
    expect(orphans).toHaveLength(1);
    expect(orphans[0]?.title).toBe('1 post in Post Bridge this app did not send');
    // Deriving the summary contacted nothing and stored nothing.
    expect(provider.reads).toHaveLength(reads);
    expect(db.prepare('SELECT COUNT(*) AS n FROM signal_alert_acks').get()).toMatchObject({ n: 0 });
  });

  it('still claims a post whose publication is older than the health window', async () => {
    seedPublication('ours');
    db.prepare("UPDATE signal_publications SET created_at='2020-01-01T00:00:00.000Z'").run();
    await service(holding([listed({ providerPostId: 'ours' })])).refresh();
    expect(readQueueHealth(db, NOW).alerts.some((alert) => alert.kind === 'PROVIDER_ORPHAN')).toBe(
      false,
    );
  });
});

describe('over the API', () => {
  const app = (provider: MockProviderInventoryProvider) =>
    createApp(db, {
      publish: new MockPublishProvider(),
      inventory: provider,
      publishTimezone: 'America/New_York',
      now: clock,
    });

  it('answers a read from stored rows without contacting the provider', async () => {
    const provider = holding([listed()]);
    await service(provider).refresh();
    const reads = provider.reads.length;
    const response = await request(app(provider)).get('/api/signal/provider-inventory').expect(200);
    expect((response.body as ProviderInventorySnapshot).entries).toHaveLength(1);
    expect(provider.reads).toHaveLength(reads);
  });

  it('refreshes when asked, and answers a failed refresh with the rows it kept', async () => {
    const provider = holding([listed()]);
    const refreshed = await request(app(provider))
      .post('/api/signal/provider-inventory/refresh')
      .expect(200);
    expect((refreshed.body as ProviderInventorySnapshot).counts).toEqual({ posts: 1, orphans: 1 });

    const failing = new MockProviderInventoryProvider();
    failing.failureAt = 1;
    failing.failure = new PublishProviderError('Post Bridge refused the request (503).', false);
    const failed = await request(app(failing))
      .post('/api/signal/provider-inventory/refresh')
      .expect(200);
    const body = failed.body as ProviderInventorySnapshot;
    expect(body.entries).toHaveLength(1);
    expect(body.reason).toContain('nothing was replaced');
  });

  it('acknowledges the orphan alert, and touches nothing else', async () => {
    const provider = holding([listed()]);
    const server = app(provider);
    await request(server).post('/api/signal/provider-inventory/refresh').expect(200);
    const health = await request(server).get('/api/signal/health').expect(200);
    const alert = (health.body.alerts as { id: string; kind: string }[]).find(
      (candidate) => candidate.kind === 'PROVIDER_ORPHAN',
    );
    const acknowledged = await request(server)
      .post(`/api/signal/health/alerts/${encodeURIComponent(alert?.id as string)}/acknowledge`)
      .expect(200);
    expect(
      (acknowledged.body.alerts as { kind: string; acknowledged: boolean }[]).find(
        (candidate) => candidate.kind === 'PROVIDER_ORPHAN',
      )?.acknowledged,
    ).toBe(true);
    // The inventory itself is untouched by an acknowledgement.
    expect(storedIds()).toEqual(['remote-1']);
  });
});
