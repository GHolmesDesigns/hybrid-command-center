/**
 * The whole run, against a provider that only exists in this file.
 *
 * The fake below answers the shapes `docs/post-bridge-api-surface.md` read out of the OpenAPI
 * document, and every test drives `runProbe` through it. Nothing here reaches a network: the
 * transport is a function, and `transport.ts` — the one that is `fetch` — is never imported.
 *
 * The fake is deliberately configurable in the ways the real provider might disappoint: it can refuse
 * an encoding by name, cite its duplicate-content policy, hand back a cursor nothing can follow,
 * refuse to delete an asset, or say a post has already gone out. Those are the branches worth having,
 * because they are the ones that decide whether the result matrix tells the truth.
 */
import { describe, expect, it } from 'vitest';
import { RequestBudget } from './budget.ts';
import { ProbeClient, type ProbeHttpRequest, type ProbeHttpResponse } from './client.ts';
import type { ProbeConfig } from './config.ts';
import type { ProbeFixture, ProbeFixtureKey } from './fixtures.ts';
import { nextInventoryOffset, runProbe, type ProbeRunResult } from './probe.ts';

const BASE = 'https://api.example.test/v1';
const UPLOAD_HOST = 'https://storage.example.test';
const LABEL = 'hcc-probe-0820';
const SCHEDULED = '2026-08-25T14:00:00.000Z';
const NOW = new Date('2026-08-20T12:00:00Z');
const API_KEY = 'pb_live_secret';

/** A caption a real account would carry. No test may find this string in a probe's output. */
const CUSTOMER_CAPTION = 'Client Q3 launch — internal draft, do not share';

interface FakePost {
  id: string;
  caption?: string;
  status: string;
  media?: unknown;
  platform_configurations?: unknown;
  account_configurations?: unknown;
}

interface FakeOptions {
  accounts?: { id: number; platform: string }[];
  existingPosts?: FakePost[];
  /** How `account_configurations` is treated. */
  accountConfigurations?: 'accepted' | 'keyed-only' | 'refused-by-name' | 'duplicate-policy';
  mediaDeleteStatus?: number;
  postDeleteStatus?: number;
  uploadStatus?: number;
  /** What `meta.next` says when there is more to read. */
  pagination?: 'offset' | 'cursor';
  /** A state a read-back reports for a post the probe created. */
  readBackStatus?: string;
  /** Posts the delete call pretends to remove but the inventory keeps listing. */
  undeletable?: boolean;
  analytics?: Record<string, unknown>[];
  rateLimitOn?: string;
  /**
   * Refuse one route with one status. The key is `<METHOD> <path>` as the fake sees it, matched by
   * prefix — `GET /media`, `POST /posts`, `PATCH /posts/`.
   */
  refuse?: Record<string, number>;
  /** A 2xx from `create-upload-url` that is missing half of what it has to carry. */
  omitUploadUrl?: boolean;
  /** A 2xx from `POST /posts` that names nothing, so nothing can delete what it made. */
  omitPostId?: boolean;
  /** Accept things the documented contract says should be refused. */
  acceptAnySize?: boolean;
  acceptAnyMime?: boolean;
  /** Take the account overrides on create and then not mention them on the read. */
  forgetAccountConfigurations?: boolean;
}

const DEFAULT_ACCOUNTS = [
  { id: 101, platform: 'linkedin' },
  { id: 102, platform: 'linkedin' },
  { id: 201, platform: 'youtube' },
  { id: 301, platform: 'instagram' },
  { id: 401, platform: 'tiktok' },
  { id: 501, platform: 'facebook' },
];

const DEFAULT_ANALYTICS = [
  {
    id: 'a1',
    post_result_id: 'r1',
    platform: 'instagram',
    match_confidence: 'exact',
    view_count: 12,
    video_description: CUSTOMER_CAPTION,
  },
  { id: 'a2', post_result_id: 'r2', platform: 'instagram', view_count: 3 },
];

function fakeProvider(options: FakeOptions = {}) {
  const accounts = options.accounts ?? DEFAULT_ACCOUNTS;
  const existing = options.existingPosts ?? [
    { id: 'ui-1', caption: CUSTOMER_CAPTION, status: 'draft' },
    { id: 'ui-2', caption: 'Weekly tip', status: 'scheduled' },
  ];
  const posts = new Map<string, FakePost>(existing.map((post) => [post.id, { ...post }]));
  const sent: ProbeHttpRequest[] = [];
  let nextPost = 0;
  let nextMedia = 0;

  const json = (status: number, body: unknown): ProbeHttpResponse => ({
    status,
    headers: {},
    body,
  });
  const page = (rows: FakePost[], offset: number, limit: number, filtered: FakePost[]) => {
    const slice = rows.slice(offset, offset + limit);
    const more = offset + limit < rows.length;
    const next = !more ? null : options.pagination === 'cursor' ? 'eyJvIjoxfQ' : offset + limit;
    return json(200, {
      data: slice,
      meta: { total: filtered.length, offset, limit, next },
    });
  };

  const transport = async (request: ProbeHttpRequest): Promise<ProbeHttpResponse> => {
    sent.push(request);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v1/, '');
    const parameters = url.searchParams;
    if (options.rateLimitOn && path.includes(options.rateLimitOn))
      return { status: 429, headers: { 'retry-after': '42' }, body: {} };
    for (const [route, status] of Object.entries(options.refuse ?? {}))
      if (`${request.method} ${path}${url.search}`.startsWith(route))
        return json(status, { message: `the fake refuses ${route}` });

    if (request.method === 'PUT' && url.origin === UPLOAD_HOST)
      return json(options.uploadStatus ?? 200, undefined);

    if (path === '/social-accounts')
      return json(200, {
        data: accounts.map((account) => ({ ...account, username: '@private-handle' })),
        meta: { total: accounts.length, offset: 0, limit: 100, next: null },
      });

    if (path === '/media/create-upload-url') {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      if (body.mime_type === 'image/webp' && !options.acceptAnyMime)
        return json(400, {
          message: [
            'mime_type must be one of: image/png, image/jpeg, video/mp4, video/quicktime, application/pdf',
          ],
        });
      if (Number(body.size_bytes) > 512 * 1024 * 1024 && !options.acceptAnySize)
        return json(400, { message: ['size_bytes exceeds the 512 MB limit for this plan'] });
      nextMedia += 1;
      return json(201, {
        media_id: `m${nextMedia}`,
        ...(options.omitUploadUrl
          ? {}
          : { upload_url: `${UPLOAD_HOST}/bucket/m${nextMedia}?X-Amz-Signature=deadbeef` }),
      });
    }
    if (/^\/media\/[^/]+$/.test(path)) {
      if (request.method === 'DELETE') {
        const status = options.mediaDeleteStatus ?? 200;
        return status >= 400
          ? json(status, { message: 'media cannot be deleted once created' })
          : json(status, {});
      }
      return json(200, { id: path.split('/')[2], type: 'image', created_at: NOW.toISOString() });
    }

    if (path === '/posts' && request.method === 'POST') {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      if (body.account_configurations !== undefined) {
        if (options.accountConfigurations === 'refused-by-name')
          return json(400, { message: ['account_configurations is not allowed on this endpoint'] });
        if (options.accountConfigurations === 'duplicate-policy')
          return json(400, {
            message: ['you cannot post the same content to multiple accounts on the same platform'],
          });
        if (
          options.accountConfigurations === 'keyed-only' &&
          Array.isArray(body.account_configurations)
        )
          return json(400, { message: ['account_configurations must be keyed by account_id'] });
      }
      nextPost += 1;
      const created: FakePost = {
        id: `p${nextPost}`,
        caption: String(body.caption),
        status: options.readBackStatus ?? 'scheduled',
        media: Array.isArray(body.media) ? body.media : undefined,
        platform_configurations: body.platform_configurations,
        ...(options.forgetAccountConfigurations
          ? {}
          : { account_configurations: body.account_configurations }),
      };
      posts.set(created.id, created);
      return json(201, {
        ...(options.omitPostId ? {} : { id: created.id }),
        status: created.status,
      });
    }
    if (path === '/posts') {
      const bracket = parameters.getAll('status[]');
      const all = [...posts.values()];
      // The fake honours only the bracketed encoding, which is what question 4 has to discover.
      const filtered = bracket.length ? all.filter((post) => bracket.includes(post.status)) : all;
      return page(
        filtered,
        Number(parameters.get('offset') ?? 0),
        Number(parameters.get('limit') ?? 10),
        filtered,
      );
    }
    const postMatch = /^\/posts\/([^/]+)$/.exec(path);
    if (postMatch) {
      const id = decodeURIComponent(postMatch[1]);
      const post = posts.get(id);
      if (!post) return json(404, { message: 'not found' });
      if (request.method === 'DELETE') {
        const status = options.postDeleteStatus ?? 200;
        if (status >= 400) return json(status, { message: 'a published post cannot be deleted' });
        if (!options.undeletable) posts.delete(id);
        return json(status, {});
      }
      if (request.method === 'PATCH') {
        const body = JSON.parse(String(request.body)) as Record<string, unknown>;
        posts.set(id, {
          ...post,
          caption: String(body.caption),
          platform_configurations: body.platform_configurations,
          ...(options.forgetAccountConfigurations
            ? {}
            : { account_configurations: body.account_configurations }),
        });
        return json(200, { id, status: post.status });
      }
      return json(200, post);
    }

    if (path === '/analytics') {
      const rows = options.analytics ?? DEFAULT_ANALYTICS;
      const timeframe = parameters.get('timeframe');
      const selected = timeframe === '7d' ? rows.slice(0, 1) : rows;
      return json(200, {
        data: selected,
        meta: { total: selected.length, offset: 0, limit: 5, next: null },
      });
    }
    return json(404, { message: `no such fake route: ${request.method} ${path}` });
  };
  return { transport, sent, posts };
}

function fixture(
  key: ProbeFixtureKey,
  mimeType: ProbeFixture['mimeType'],
  name: string,
): ProbeFixture {
  const bytes = new Uint8Array([key.length, 1, 2, 3]);
  return { key, name, mimeType, sizeBytes: bytes.byteLength, sha256: `sha-${key}`, bytes };
}

function allFixtures(keys: ProbeFixtureKey[] = ['image', 'cover', 'document', 'video']) {
  const map = new Map<ProbeFixtureKey, ProbeFixture>();
  if (keys.includes('image')) map.set('image', fixture('image', 'image/png', 'probe-image.png'));
  if (keys.includes('cover')) map.set('cover', fixture('cover', 'image/png', 'probe-cover.png'));
  if (keys.includes('document'))
    map.set('document', fixture('document', 'application/pdf', 'probe-document.pdf'));
  if (keys.includes('video')) map.set('video', fixture('video', 'video/mp4', 'probe-video.mp4'));
  return map;
}

const manyPosts = (count: number): FakePost[] =>
  Array.from({ length: count }, (_, index) => ({ id: `old-${index}`, status: 'scheduled' }));

function config(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return {
    mode: 'live',
    apiKey: API_KEY,
    baseUrl: BASE,
    scheduledAt: SCHEDULED,
    probeLabel: LABEL,
    accounts: DEFAULT_ACCOUNTS.map((account) => ({
      platform: account.platform,
      accountId: account.id,
    })),
    providerUiPostId: 'ui-1',
    ...overrides,
  };
}

async function run(
  options: FakeOptions = {},
  overrides: {
    config?: Partial<ProbeConfig>;
    budget?: RequestBudget;
    keys?: ProbeFixtureKey[];
  } = {},
): Promise<{ result: ProbeRunResult; sent: ProbeHttpRequest[]; posts: Map<string, FakePost> }> {
  const provider = fakeProvider(options);
  const result = await runProbe({
    client: new ProbeClient({
      apiKey: API_KEY,
      baseUrl: BASE,
      transport: provider.transport,
      budget: overrides.budget ?? new RequestBudget(),
    }),
    config: config(overrides.config),
    fixtures: allFixtures(overrides.keys),
    now: NOW,
  });
  return { result, sent: provider.sent, posts: provider.posts };
}

const state = (result: ProbeRunResult, id: string) =>
  result.claims.find((claim) => claim.id === id)?.state;
const evidence = (result: ProbeRunResult, id: string) =>
  (result.claims.find((claim) => claim.id === id)?.evidence ?? []).join(' ');

describe('a complete run against a provider that answers everything', () => {
  it('answers every claim, and leaves exactly the three a session cannot answer', async () => {
    const { result } = await run();
    expect(result.stopped).toBeUndefined();
    const unresolved = result.claims
      .filter((claim) => claim.state === 'still-unverified')
      .map((claim) => claim.id);
    expect(unresolved).toEqual(['media-expiry-lifecycle', 'rate-limit-headers']);
    expect(state(result, 'same-platform-duplicate-policy')).toBe('verified-with-policy-constraint');
    expect(
      result.claims.filter((claim) => claim.state === 'negative').map((claim) => claim.id),
    ).toEqual([]);
  });

  it('never leaves a claim carrying the placeholder evidence', async () => {
    const { result } = await run();
    for (const claim of result.claims) {
      expect(claim.evidence.join('')).not.toBe('Not attempted in this run.');
      expect(claim.evidence.length).toBeGreaterThan(0);
    }
  });

  it('stays inside the request budget, teardown reserve included', async () => {
    const { result } = await run();
    expect(result.budget.total).toBe(50);
    expect(result.budget.used).toBeLessThanOrEqual(50);
    const questions = result.calls.filter((call) => !call.teardown).length;
    expect(questions).toBeLessThanOrEqual(result.budget.total - result.budget.reserve);
    // The measured figures on the fullest run this fake can produce: 31 questions and 10 teardown
    // calls, against a ceiling of 38 and a reserve of 12. Asserted rather than left implicit, so a
    // step that quietly adds four requests fails here instead of failing mid-session at a provider.
    expect(questions).toBe(31);
    expect(result.calls.length - questions).toBe(10);
  });

  it('deletes every post it created and proves the absence independently', async () => {
    const { result, posts } = await run();
    expect(result.teardown.createdPosts.length).toBeGreaterThan(0);
    expect(result.teardown.deletedPosts).toHaveLength(result.teardown.createdPosts.length);
    expect(result.teardown.failedPosts).toEqual([]);
    expect(result.teardown.inventory).toBe('verified-absent');
    // And in the provider, only the two posts the run did not create.
    expect([...posts.keys()]).toEqual(['ui-1', 'ui-2']);
    expect(state(result, 'posts-list-disappearance')).toBe('verified');
    expect(result.leftovers).toEqual([]);
  });

  it('always sends scheduled_at, and never sends null for it', async () => {
    const { sent } = await run();
    const writes = sent.filter(
      (request) => request.method === 'POST' || request.method === 'PATCH',
    );
    const posted = writes.filter(
      (request) => request.url.endsWith('/posts') || /\/posts\//.test(request.url),
    );
    expect(posted.length).toBeGreaterThan(0);
    for (const request of posted) {
      const body = JSON.parse(String(request.body)) as Record<string, unknown>;
      expect(body.scheduled_at).toBe(SCHEDULED);
    }
  });

  it('writes only to the accounts it was given', async () => {
    const { sent } = await run();
    const named = new Set(DEFAULT_ACCOUNTS.map((account) => account.id));
    for (const request of sent.filter(
      (candidate) => candidate.body && /\/posts/.test(candidate.url),
    )) {
      const body = JSON.parse(String(request.body)) as { social_accounts?: number[] };
      for (const account of body.social_accounts ?? []) expect(named.has(account)).toBe(true);
    }
  });

  it('discovers which repeatable encoding actually filters', async () => {
    const { result } = await run();
    expect(state(result, 'posts-list-filter-encoding')).toBe('verified');
    expect(evidence(result, 'posts-list-filter-encoding')).toContain('status[]');
  });

  it('reads the provider’s own words about its size limit and its MIME enum', async () => {
    const { result } = await run();
    expect(evidence(result, 'media-limits')).toContain('512 MB');
    expect(evidence(result, 'media-mime-enum')).toContain('image/webp was refused');
  });

  it('records the match_confidence values it saw and that a row can arrive without one', async () => {
    const { result } = await run();
    expect(evidence(result, 'analytics-match-confidence')).toContain('`exact`');
    expect(evidence(result, 'analytics-match-confidence')).toContain('1 of 2 row(s) carried none');
  });

  it('reads timeframe as row selection because the narrow window returned a subset', async () => {
    const { result } = await run();
    expect(state(result, 'analytics-timeframe-meaning')).toBe('verified');
    expect(evidence(result, 'analytics-timeframe-meaning')).toContain('which rows are included');
  });

  it('says a positive API answer does not erase the vendor’s same-platform policy', async () => {
    const { result } = await run();
    expect(evidence(result, 'same-platform-duplicate-policy')).toContain(
      'does not erase the vendor',
    );
    expect(evidence(result, 'same-platform-duplicate-policy')).toContain('preflight');
  });
});

describe('what the output must never contain', () => {
  it('holds no API key, no signed URL, and no request or response body', async () => {
    const { result } = await run();
    const written = JSON.stringify(result);
    expect(written).not.toContain(API_KEY);
    expect(written).not.toContain('deadbeef');
    expect(written).not.toContain('X-Amz-Signature');
    for (const call of result.calls) expect(call.url).not.toMatch(/\?[^[]/);
  });

  it('holds no caption or handle from a post the run did not create', async () => {
    const { result } = await run();
    const written = JSON.stringify(result);
    expect(written).not.toContain('Client Q3');
    expect(written).not.toContain('private-handle');
    expect(written).not.toContain('Weekly tip');
  });
});

describe('the human stop conditions', () => {
  it('stops before any write when an account is not connected', async () => {
    const { result, sent } = await run(
      {},
      { config: { accounts: [{ platform: 'linkedin', accountId: 999 }] } },
    );
    expect(result.stopped).toContain('999 is not among');
    expect(sent.filter((request) => request.method === 'POST')).toEqual([]);
    expect(result.teardown.createdPosts).toEqual([]);
  });

  it('stops when a named account is on a different platform than claimed', async () => {
    const { result } = await run(
      {},
      { config: { accounts: [{ platform: 'tiktok', accountId: 101 }] } },
    );
    expect(result.stopped).toContain('is a linkedin account and was named as tiktok');
  });

  it('stops before any write when the probe label is already in use', async () => {
    const { result, sent } = await run({
      existingPosts: [
        { id: 'old', caption: `HCC contract probe ${LABEL}: leftover`, status: 'scheduled' },
      ],
    });
    expect(result.stopped).toContain('already appears');
    expect(sent.filter((request) => request.method === 'POST')).toEqual([]);
  });

  it('stops and cleans up when a post comes back in a state it did not schedule', async () => {
    const { result, posts } = await run({ readBackStatus: 'posted' });
    expect(result.stopped).toContain('came back in state "posted"');
    // The post it had already created is still deleted, which is the whole point of the finally.
    expect(result.teardown.deletedPosts.length).toBeGreaterThan(0);
    expect([...posts.keys()]).toEqual(['ui-1', 'ui-2']);
  });

  it('records an unprovoked 429 and stops rather than waiting it out', async () => {
    const { result } = await run({ rateLimitOn: '/analytics' });
    expect(result.stopped).toContain('429');
    expect(state(result, 'rate-limit-headers')).toBe('verified');
    expect(evidence(result, 'rate-limit-headers')).toContain('retry-after');
    expect(evidence(result, 'rate-limit-headers')).toContain('42');
  });

  it('leaves the claims it never reached unverified, saying that the run stopped', async () => {
    const { result } = await run({ rateLimitOn: '/analytics' });
    expect(state(result, 'tiktok-disclosure-toggles')).toBe('still-unverified');
    expect(evidence(result, 'tiktok-disclosure-toggles')).toContain('the run stopped');
  });
});

describe('when the budget runs out', () => {
  it('refuses the next question and still cleans up from the reserve', async () => {
    const { result, posts } = await run({}, { budget: new RequestBudget(20, 6) });
    expect(result.stopped).toContain('Request budget exhausted');
    expect(result.teardown.deletedPosts.length).toBeGreaterThan(0);
    expect([...posts.keys()]).toEqual(['ui-1', 'ui-2']);
    expect(result.budget.used).toBeLessThanOrEqual(20);
  });
});

describe('when cleanup cannot finish', () => {
  it('inventories an undeletable asset without secrets and dates the follow-up', async () => {
    const { result } = await run({ mediaDeleteStatus: 405 });
    expect(state(result, 'media-delete-endpoint')).toBe('negative');
    expect(result.leftovers.some((leftover) => leftover.kind === 'media')).toBe(true);
    expect(evidence(result, 'media-expiry-lifecycle')).toContain(
      'no earlier than 2026-08-21T13:00',
    );
    expect(JSON.stringify(result.leftovers)).not.toContain(API_KEY);
    expect(JSON.stringify(result.leftovers)).not.toContain('deadbeef');
  });

  it('reports a post it could not delete as a leftover to remove by hand', async () => {
    const { result } = await run({ postDeleteStatus: 400 });
    expect(result.teardown.deletedPosts).toEqual([]);
    expect(result.teardown.failedPosts.length).toBeGreaterThan(0);
    expect(result.leftovers[0].note).toContain('Delete it by hand');
    expect(result.teardown.inventory).toBe('still-present');
  });

  it('calls the deletion unproven when the inventory still lists a created post', async () => {
    const { result } = await run({ undeletable: true });
    expect(result.teardown.inventory).toBe('still-present');
    expect(result.teardown.inventoryNote).toContain('Remove them by hand');
    expect(state(result, 'posts-list-disappearance')).toBe('negative');
  });
});

describe('account_configurations', () => {
  it('retries the keyed encoding once when the list form is refused by name', async () => {
    const { result } = await run({ accountConfigurations: 'keyed-only' });
    expect(state(result, 'account-configurations-accepted')).toBe('verified');
    expect(evidence(result, 'account-configuration-encoding')).toContain('keyed by account id');
  });

  it('records a negative when neither encoding is accepted', async () => {
    const { result } = await run({ accountConfigurations: 'refused-by-name' });
    expect(state(result, 'account-configurations-accepted')).toBe('negative');
    expect(state(result, 'account-configuration-encoding')).toBe('negative');
    expect(state(result, 'account-configuration-fields-persist')).toBe('still-unverified');
  });

  it('records the vendor’s duplicate-content refusal as a policy constraint', async () => {
    const { result } = await run({ accountConfigurations: 'duplicate-policy' });
    expect(state(result, 'same-platform-duplicate-policy')).toBe('verified-with-policy-constraint');
    expect(evidence(result, 'same-platform-duplicate-policy')).toContain(
      'multiple accounts on the same platform',
    );
    expect(state(result, 'account-configurations-accepted')).toBe('negative');
  });

  it('cannot be asked at all with only one account on a platform', async () => {
    const { result } = await run(
      {},
      { config: { accounts: [{ platform: 'linkedin', accountId: 101 }] } },
    );
    expect(state(result, 'account-configurations-accepted')).toBe('still-unverified');
    expect(evidence(result, 'account-configurations-accepted')).toContain('two named accounts');
  });

  it('names the missing account rather than leaving a claim with no reason at all', async () => {
    const { result } = await run(
      {},
      { config: { accounts: [{ platform: 'linkedin', accountId: 101 }] } },
    );
    for (const claim of result.claims)
      expect(claim.evidence[0]).not.toBe('Not attempted in this run.');
    expect(evidence(result, 'tiktok-disclosure-toggles')).toBe('No TikTok account was named.');
    expect(evidence(result, 'facebook-story-placement')).toBe('No Facebook account was named.');
  });
});

describe('pagination it cannot follow', () => {
  it('records the shape it saw rather than inventing a cursor parameter', async () => {
    const existingPosts = Array.from({ length: 150 }, (_, index) => ({
      id: `old-${index}`,
      status: 'scheduled',
    }));
    const { result, sent } = await run({ pagination: 'cursor', existingPosts });
    expect(state(result, 'posts-list-pagination')).toBe('still-unverified');
    expect(evidence(result, 'posts-list-pagination')).toContain('carrying no offset');
    for (const request of sent) expect(request.url).not.toContain('cursor=');
  });

  it('walks several pages when meta.next is an offset', async () => {
    const existingPosts = Array.from({ length: 150 }, (_, index) => ({
      id: `old-${index}`,
      status: 'scheduled',
    }));
    const { result } = await run({ existingPosts });
    expect(state(result, 'posts-list-pagination')).toBe('verified');
    expect(evidence(result, 'posts-list-pagination')).toContain('page(s)');
  });
});

describe('nextInventoryOffset', () => {
  it('treats a null, absent, or false next as the last page', () => {
    expect(nextInventoryOffset({ next: null })).toEqual({ done: true });
    expect(nextInventoryOffset({})).toEqual({ done: true });
    expect(nextInventoryOffset({ next: false })).toEqual({ done: true });
  });

  it('follows a number, and an offset lifted out of a URL', () => {
    expect(nextInventoryOffset({ next: 100 })).toEqual({ offset: 100 });
    expect(nextInventoryOffset({ next: 'https://api/v1/posts?limit=100&offset=100' })).toEqual({
      offset: 100,
    });
  });

  it('refuses to guess anything else', () => {
    expect(nextInventoryOffset({ next: 'eyJvIjoxfQ' })).toEqual({
      unknown: 'meta.next is a string carrying no offset',
    });
    const nested = nextInventoryOffset({ next: { cursor: 'x' } });
    expect('unknown' in nested && nested.unknown).toContain('meta.next is');
    const absent = nextInventoryOffset(undefined);
    expect('unknown' in absent && absent.unknown).toContain('meta is');
  });
});

describe('questions this invocation cannot answer', () => {
  it('leaves the video roles unverified, with the reason, when no video was supplied', async () => {
    const { result } = await run({}, { keys: ['image', 'cover', 'document'] });
    expect(state(result, 'youtube-thumbnail-role')).toBe('still-unverified');
    expect(evidence(result, 'youtube-thumbnail-role')).toContain('No video asset was uploaded');
    expect(state(result, 'instagram-cover-image-role')).toBe('still-unverified');
    // The LinkedIn document role needs no video and is still answered.
    expect(state(result, 'linkedin-document-title-role')).toBe('verified');
  });

  it('leaves the provider-UI shape unverified rather than creating a stand-in', async () => {
    const { result } = await run({}, { config: { providerUiPostId: undefined } });
    expect(state(result, 'posts-list-provider-ui-shape')).toBe('still-unverified');
    expect(evidence(result, 'posts-list-provider-ui-shape')).toContain('never creates one');
  });

  it('records a negative for a platform field whose post the provider refused', async () => {
    const { result } = await run(
      {},
      { config: { accounts: [{ platform: 'tiktok', accountId: 401 }] }, keys: ['image'] },
    );
    expect(state(result, 'linkedin-document-title-role')).toBe('still-unverified');
    expect(state(result, 'tiktok-disclosure-toggles')).toBe('verified');
  });
});

describe('the upload path', () => {
  it('sends the bytes to the signed URL with no bearer token', async () => {
    const { sent } = await run();
    const uploads = sent.filter((request) => request.method === 'PUT');
    expect(uploads.length).toBeGreaterThan(0);
    for (const upload of uploads) {
      expect(upload.headers.Authorization).toBeUndefined();
      expect(upload.url.startsWith(UPLOAD_HOST)).toBe(true);
    }
  });

  it('records the fixture hash rather than the bytes', async () => {
    const { result } = await run();
    expect(evidence(result, 'media-upload-contract')).toContain('sha-image');
    expect(result.fixtures.map((fixtureRecord) => fixtureRecord.sha256)).toContain('sha-document');
  });

  it('records a negative and asks nothing media-shaped when the signed PUT is refused', async () => {
    const { result } = await run({ uploadStatus: 403 });
    expect(state(result, 'media-upload-contract')).toBe('negative');
    expect(evidence(result, 'media-upload-contract')).toContain('answered HTTP 403');
    expect(state(result, 'media-ids-override-media-urls')).toBe('still-unverified');
    // The reservation the provider made is still cleaned up.
    expect(result.teardown.deletedMedia.length).toBeGreaterThan(0);
  });
});

describe('when the provider disappoints one question at a time', () => {
  it('records a negative when create-upload-url answers without an upload URL', async () => {
    const { result } = await run({ omitUploadUrl: true });
    expect(state(result, 'media-upload-contract')).toBe('negative');
    expect(evidence(result, 'media-upload-contract')).toContain('without both an id and an');
    expect(state(result, 'media-attach-and-describe')).toBe('still-unverified');
  });

  it('records a negative when create-upload-url refuses the documented three fields', async () => {
    const { result } = await run({ refuse: { 'POST /media/create-upload-url': 400 } });
    expect(state(result, 'media-upload-contract')).toBe('negative');
    expect(evidence(result, 'media-upload-contract')).toContain('refused { name, mime_type');
  });

  it('records a negative when an uploaded asset cannot be described', async () => {
    const { result } = await run({ refuse: { 'GET /media/': 404 } });
    expect(state(result, 'media-upload-contract')).toBe('verified');
    expect(state(result, 'media-attach-and-describe')).toBe('negative');
  });

  it('leaves the limits unverified when an absurd size is accepted, and cleans the reservation up', async () => {
    const { result } = await run({ acceptAnySize: true });
    expect(state(result, 'media-limits')).toBe('still-unverified');
    expect(evidence(result, 'media-limits')).toContain('enforces no size bound of its own');
    expect(result.teardown.deletedMedia.length).toBeGreaterThan(4);
  });

  it('records a negative for the MIME enum when a sixth type is accepted', async () => {
    const { result } = await run({ acceptAnyMime: true });
    expect(state(result, 'media-mime-enum')).toBe('negative');
    expect(evidence(result, 'media-mime-enum')).toContain('wider than the documented five');
  });

  it('stops when a created post comes back with no id to delete it by', async () => {
    const { result, sent } = await run({ omitPostId: true });
    expect(result.stopped).toContain('carried no id');
    expect(result.teardown.createdPosts).toEqual([]);
    // Nothing was deleted because nothing could be named — which is exactly why it stopped there.
    expect(
      sent.filter((request) => request.method === 'POST' && /\/posts$/.test(request.url)),
    ).toHaveLength(1);
  });

  it('records a negative when the account overrides do not survive the read-back', async () => {
    const { result } = await run({ forgetAccountConfigurations: true });
    expect(state(result, 'account-configurations-accepted')).toBe('verified');
    expect(state(result, 'account-configuration-fields-persist')).toBe('negative');
    expect(evidence(result, 'account-configuration-fields-persist')).toContain('undefined');
  });

  it('records a negative when the PATCH is refused', async () => {
    const { result } = await run({ refuse: { 'PATCH /posts/': 400 } });
    expect(state(result, 'account-configuration-fields-persist')).toBe('negative');
    expect(evidence(result, 'account-configuration-fields-persist')).toContain('PATCH was refused');
  });

  it('records a negative for the LinkedIn document role when the post is refused', async () => {
    const { result } = await run({ refuse: { 'POST /posts': 422 } });
    expect(state(result, 'linkedin-document-title-role')).toBe('negative');
    expect(state(result, 'youtube-thumbnail-role')).toBe('still-unverified');
    expect(evidence(result, 'youtube-thumbnail-role')).toContain('refused before any role');
    expect(state(result, 'tiktok-disclosure-toggles')).toBe('negative');
    expect(state(result, 'facebook-story-placement')).toBe('negative');
  });

  it('records a negative when the named provider-UI post cannot be read', async () => {
    const { result } = await run({}, { config: { providerUiPostId: 'gone' } });
    expect(state(result, 'posts-list-provider-ui-shape')).toBe('negative');
    expect(evidence(result, 'posts-list-provider-ui-shape')).toContain('could not be read');
  });

  it('leaves every analytics claim unverified when the endpoint refuses', async () => {
    const { result } = await run({ refuse: { 'GET /analytics': 403 } });
    for (const claim of [
      'analytics-pagination',
      'analytics-timeframe-meaning',
      'analytics-response-grain',
      'analytics-account-mapping',
      'analytics-match-confidence',
    ] as const) {
      expect(state(result, claim)).toBe('still-unverified');
      expect(evidence(result, claim)).toContain('GET /v1/analytics answered HTTP 403');
    }
  });

  it('leaves the grain and the mapping unverified when there is nothing measured yet', async () => {
    const { result } = await run({ analytics: [] });
    expect(state(result, 'analytics-pagination')).toBe('verified');
    expect(state(result, 'analytics-response-grain')).toBe('still-unverified');
    expect(evidence(result, 'analytics-response-grain')).toContain('No analytics rows exist');
    expect(state(result, 'analytics-match-confidence')).toBe('still-unverified');
    expect(state(result, 'analytics-timeframe-meaning')).toBe('still-unverified');
  });

  it('leaves the grain unverified when a row arrives with no post_result_id', async () => {
    const { result } = await run({ analytics: [{ id: 'a1', platform: 'instagram' }] });
    expect(state(result, 'analytics-response-grain')).toBe('still-unverified');
    expect(evidence(result, 'analytics-response-grain')).toContain('not reliably per delivery');
  });

  it('sends no window filter when no named account is on a measured platform', async () => {
    const { result, sent } = await run(
      {},
      { config: { accounts: [{ platform: 'linkedin', accountId: 101 }] } },
    );
    expect(state(result, 'analytics-timeframe-meaning')).toBe('still-unverified');
    expect(evidence(result, 'analytics-timeframe-meaning')).toContain('this provider measures');
    for (const request of sent) expect(request.url).not.toContain('timeframe=');
  });

  it('leaves the pagination and identity claims unverified when the first page is refused', async () => {
    const { result } = await run({ refuse: { 'GET /posts?limit=100': 500 } });
    expect(state(result, 'posts-list-pagination')).toBe('still-unverified');
    expect(evidence(result, 'posts-list-pagination')).toContain('page 1 refused');
    expect(state(result, 'posts-list-identity-fields')).toBe('still-unverified');
    expect(result.teardown.inventory).toBe('not-verified');
  });

  it('leaves the filter-encoding claim unverified when neither encoding filters', async () => {
    const { result } = await run({ refuse: { 'GET /posts?limit=5': 400 } });
    expect(state(result, 'posts-list-filter-encoding')).toBe('still-unverified');
    expect(evidence(result, 'posts-list-filter-encoding')).toContain('Neither encoding');
  });

  it('leaves media precedence unverified when the mixed-key post is refused outright', async () => {
    const { result } = await run({ refuse: { 'POST /posts': 400 } });
    expect(state(result, 'media-ids-override-media-urls')).toBe('still-unverified');
    expect(evidence(result, 'media-ids-override-media-urls')).toContain('neither key winning');
  });

  it('cannot ask about the disclosure fields with no asset to attach', async () => {
    const { result } = await run({ omitUploadUrl: true });
    expect(state(result, 'tiktok-disclosure-toggles')).toBe('still-unverified');
    expect(evidence(result, 'tiktok-disclosure-toggles')).toContain('No asset was uploaded');
  });

  it('says the delete endpoint was never exercised when no asset was created', async () => {
    const { result } = await run({ refuse: { 'POST /media/create-upload-url': 400 } });
    expect(state(result, 'media-delete-endpoint')).toBe('still-unverified');
    expect(evidence(result, 'media-delete-endpoint')).toContain('never exercised');
    expect(evidence(result, 'media-expiry-lifecycle')).toContain('A deletion is not an expiry');
  });

  it('says there was no deletion to observe when it created no post', async () => {
    const { result } = await run({ refuse: { 'POST /posts': 400 } });
    expect(state(result, 'posts-list-disappearance')).toBe('still-unverified');
    expect(evidence(result, 'posts-list-disappearance')).toContain('created no post');
  });

  it('does not claim the deletion is proved when the closing inventory cannot complete', async () => {
    const { result } = await run({ pagination: 'cursor', existingPosts: manyPosts(150) });
    expect(result.teardown.deletedPosts.length).toBeGreaterThan(0);
    expect(result.teardown.inventory).toBe('not-verified');
    expect(result.teardown.inventoryNote).toContain('Check the provider by hand');
    expect(state(result, 'posts-list-disappearance')).toBe('still-unverified');
  });
});
