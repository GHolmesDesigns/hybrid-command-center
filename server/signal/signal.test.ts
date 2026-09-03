import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { LocalSignalProvider, listPostsInRange } from './read.ts';
import { UnavailableSignalProvider } from './provider.ts';
import {
  SignalPostNotFoundError,
  SignalSlotConflictError,
  applyPostSlot,
  createPost,
  deletePost,
  duplicatePost,
  getPost,
  listQueue,
  signalPostInput,
  signalPostPatch,
  suggestPostSlot,
  updatePost,
} from './service.ts';
import { listCampaigns } from './campaigns.ts';
import {
  SIGNAL_RANGE_LIMIT,
  isSignalPostInRange,
  signalMediaKind,
  signalMonthBounds,
} from '../../shared/signal.ts';

let db: Db;
const originalTimeZone = process.env.TZ;
beforeEach(() => {
  db = createDb(':memory:');
});
afterEach(() => {
  // The zone cases below set TZ; put it back so nothing else in this run inherits one.
  process.env.TZ = originalTimeZone;
});

/** A valid post, so each test states only the field it is about. */
const post = (overrides: Record<string, unknown> = {}) =>
  signalPostInput.parse({ text: 'Clarity as competitive advantage', ...overrides });

const add = (overrides: Record<string, unknown> = {}) => createPost(db, post(overrides));

describe('the date/time vocabulary', () => {
  it('puts a post in the cell matching its own date string, with both bounds inclusive', () => {
    expect(isSignalPostInRange({ date: '2026-09-01' }, '2026-09-01', '2026-09-30')).toBe(true);
    expect(isSignalPostInRange({ date: '2026-09-30' }, '2026-09-01', '2026-09-30')).toBe(true);
    expect(isSignalPostInRange({ date: '2026-08-31' }, '2026-09-01', '2026-09-30')).toBe(false);
    expect(isSignalPostInRange({ date: '2026-10-01' }, '2026-09-01', '2026-09-30')).toBe(false);
  });

  it('leaves an unscheduled post out of every range', () => {
    expect(isSignalPostInRange({ date: null }, '0000-01-01', '9999-12-31')).toBe(false);
  });

  it('bounds a month by its own length, leap years included', () => {
    expect(signalMonthBounds('2026-09-14')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(signalMonthBounds('2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(signalMonthBounds('2028-02-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(signalMonthBounds('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it.each([
    ['a zone that is hours behind UTC', 'America/Los_Angeles'],
    ['a zone that is hours ahead', 'Asia/Tokyo'],
    ['UTC itself', 'UTC'],
  ])('keeps a post on its own day in %s', async (_label, timeZone) => {
    // The cell rule compares stored strings and derives no instant, so the server's zone cannot
    // move a post across a day boundary. Asserting it here is what keeps that true.
    process.env.TZ = timeZone;
    const created = await add({ date: '2026-09-14', time: '23:30' });
    const { posts } = listPostsInRange(db, '2026-09-14', '2026-09-14');
    expect(posts.map((p) => p.id)).toEqual([created.id]);
    expect(listPostsInRange(db, '2026-09-15', '2026-09-15').posts).toEqual([]);
  });
});

describe('writing posts', () => {
  it('binds a post to the client of its project and leaves an unassigned post unbound', async () => {
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO clients(id,name,slug,branding_color_one,branding_color_two,created_at,updated_at)
       VALUES('client-1','Acme Studio','acme-studio','#18201d','#ffffff',?,?)`,
    ).run(timestamp, timestamp);
    db.prepare(
      `INSERT INTO projects(id,client_id,name,created_at,updated_at)
       VALUES('project-1','client-1','Launch',?,?)`,
    ).run(timestamp, timestamp);

    const bound = await add({ projectId: 'project-1', date: '2026-09-14' });
    const unbound = await add({ date: '2026-09-14' });

    expect(bound.client).toEqual({
      id: 'client-1',
      name: 'Acme Studio',
      branding: { logoUrl: '', colorOne: '#18201d', colorTwo: '#ffffff' },
    });
    expect(unbound.client).toBeUndefined();
    expect(listPostsInRange(db, '2026-09-14', '2026-09-14').posts).toHaveLength(2);
  });

  it('creates an unscheduled post by default and puts it in the queue', async () => {
    const created = await add();
    expect(created.date).toBeNull();
    expect(created.status).toBe('DRAFT');
    expect(created.cta).toBe('NONE');
    expect(listQueue(db).map((p) => p.id)).toEqual([created.id]);
    expect(listPostsInRange(db, '0001-01-01', '9999-12-31').posts).toEqual([]);
  });

  it('queues new posts behind the ones already there, and appends a post sent back', async () => {
    const first = await add({ text: 'First idea' });
    const second = await add({ text: 'Second idea' });
    const dated = await add({ text: 'Third idea', date: '2026-09-14' });
    expect(listQueue(db).map((p) => p.id)).toEqual([first.id, second.id]);

    const returned = await updatePost(db, dated.id, { date: null });
    expect(returned.date).toBeNull();
    expect(listQueue(db).map((p) => p.id)).toEqual([first.id, second.id, dated.id]);
  });

  it('stores channels as rows and hands them back deduplicated and ordered', async () => {
    const created = await add({ channels: ['li', 'ig', 'li', 'blog'] });
    expect(created.channels).toEqual(['blog', 'ig', 'li']);
    const rows = db
      .prepare('SELECT COUNT(*) n FROM signal_post_channels WHERE post_id=?')
      .get(created.id) as { n: number };
    expect(rows.n).toBe(3);
  });

  it('replaces channels on patch and leaves them alone when the patch omits them', async () => {
    const created = await add({ channels: ['li', 'ig'] });
    expect((await updatePost(db, created.id, { channels: ['x'] })).channels).toEqual(['x']);
    expect((await updatePost(db, created.id, { text: 'Reworded' })).channels).toEqual(['x']);
  });

  it('stores ordered media rows, replaces them on patch, and leaves them alone when omitted', async () => {
    const first = 'https://cdn.example.com/first.jpg';
    const second = 'https://cdn.example.com/second.mp4?download=1';
    const created = await add({ mediaUrls: [second, first] });
    expect(created.mediaUrls).toEqual([second, first]);
    expect(
      db
        .prepare('SELECT position, url FROM signal_post_media WHERE post_id=? ORDER BY position')
        .all(created.id),
    ).toEqual([
      { position: 0, url: second },
      { position: 1, url: first },
    ]);

    expect((await updatePost(db, created.id, { mediaUrls: [first, second] })).mediaUrls).toEqual([
      first,
      second,
    ]);
    expect((await updatePost(db, created.id, { text: 'Reworded' })).mediaUrls).toEqual([
      first,
      second,
    ]);
  });

  it('changes only what a patch names', async () => {
    const created = await add({
      date: '2026-09-14',
      time: '13:00',
      campaigns: ['Wk4'],
      status: 'SCHEDULED',
    });
    const patched = await updatePost(db, created.id, { status: 'PUBLISHED' });
    expect(patched).toMatchObject({
      date: '2026-09-14',
      time: '13:00',
      status: 'PUBLISHED',
      text: created.text,
    });
    expect(patched.campaigns.map((campaign) => campaign.name)).toEqual(['Wk4']);
  });

  it('distinguishes clearing a nullable field from leaving it alone', async () => {
    const created = await add({ date: '2026-09-14', time: '13:00' });
    expect((await updatePost(db, created.id, { text: 'Reworded' })).date).toBe('2026-09-14');
    expect((await updatePost(db, created.id, { date: null })).date).toBeNull();
  });

  /**
   * Campaigns are a join and behave like the channel and media joins: a patch that names them
   * replaces the set, a patch that omits them leaves it alone, and an empty array is the deliberate
   * answer *this post belongs to none* rather than a request to leave it as it was.
   */
  it('replaces campaigns on patch, leaves them alone when omitted, and takes an empty set', async () => {
    const created = await add({ campaigns: ['Clarity Campaign'] });
    expect(created.campaigns.map((campaign) => campaign.name)).toEqual(['Clarity Campaign']);

    const both = await updatePost(db, created.id, { campaigns: ['Clarity Campaign', 'Wk1'] });
    expect(both.campaigns.map((campaign) => campaign.name)).toEqual(['Clarity Campaign', 'Wk1']);
    expect((await updatePost(db, created.id, { text: 'Reworded' })).campaigns).toHaveLength(2);
    expect((await updatePost(db, created.id, { campaigns: [] })).campaigns).toEqual([]);
    // Detaching a post never removes the campaign from the workspace's own list.
    expect(listCampaigns(db).map((campaign) => campaign.name)).toEqual(['Clarity Campaign', 'Wk1']);
  });

  it('resolves two spellings of one campaign to a single row, keeping the first', async () => {
    const first = await add({ campaigns: ['Clarity Campaign'] });
    const second = await add({ campaigns: ['CLARITY campaign'] });
    expect(second.campaigns.map((campaign) => campaign.name)).toEqual(['Clarity Campaign']);
    expect(second.campaigns[0]!.id).toBe(first.campaigns[0]!.id);
    expect(listCampaigns(db)).toHaveLength(1);
  });

  it('refuses more campaigns than a post may carry, and deduplicates what it takes', async () => {
    const created = await add({ campaigns: ['Wk1', 'wk1  ', ' Wk1'] });
    expect(created.campaigns.map((campaign) => campaign.name)).toEqual(['Wk1']);
    expect(() =>
      signalPostInput.parse({
        text: 'Too many',
        campaigns: Array.from({ length: 13 }, (_, index) => `Campaign ${index}`),
      }),
    ).toThrow();
  });

  it('takes the channel and media rows with the post when it is deleted', async () => {
    const created = await add({
      channels: ['li', 'ig'],
      mediaUrls: ['https://cdn.example.com/post.jpg'],
    });
    deletePost(db, created.id);
    expect(getPost(db, created.id)).toBeUndefined();
    const rows = db.prepare('SELECT COUNT(*) n FROM signal_post_channels').get() as { n: number };
    expect(rows.n).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_post_media').get()).toEqual({ n: 0 });
  });

  /**
   * The route parses the body before it patches, so what the schema does with an absent field is
   * what the API does with it. A field declared with a default keeps that default inside
   * `.partial()`'s optional wrapper, which turned a patch that named only the text into one that
   * cleared the channels, the media, the campaigns, and the date — `signalPostPatch` strips the
   * defaults for exactly this reason, and this is the test that says so.
   */
  it('leaves every unnamed field alone when a patch is parsed rather than written by hand', async () => {
    const created = await add({
      channels: ['li'],
      mediaUrls: ['https://cdn.example.com/one.jpg'],
      campaigns: ['Wk4'],
      date: '2026-09-14',
      time: '13:00',
    });
    const parsed = signalPostPatch.parse({ text: 'Reworded' });
    expect(parsed).toEqual({ text: 'Reworded' });

    const patched = await updatePost(db, created.id, parsed);
    expect(patched).toMatchObject({
      text: 'Reworded',
      channels: ['li'],
      mediaUrls: ['https://cdn.example.com/one.jpg'],
      date: '2026-09-14',
      time: '13:00',
    });
    expect(patched.campaigns.map((campaign) => campaign.name)).toEqual(['Wk4']);
  });

  it('refuses to edit or delete a post that does not exist', async () => {
    await expect(updatePost(db, 'nope', { text: 'x' })).rejects.toThrow(SignalPostNotFoundError);
    expect(() => deletePost(db, 'nope')).toThrow(SignalPostNotFoundError);
  });

  it('duplicates content, media, campaign, and channels into the queue without publications', async () => {
    const source = await add({
      text: 'Teach first. Sell second.',
      channels: ['li', 'ig'],
      mediaUrls: ['https://cdn.example.com/launch.jpg'],
      date: '2026-09-14',
      time: '13:00',
      format: 'ARTICLE',
      status: 'PUBLISHED',
      campaigns: ['Wk4'],
      cta: 'SOFT',
    });
    db.prepare(
      `INSERT INTO signal_publications(
        id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
        sent_caption,sent_channels,error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'pub-1',
      source.id,
      'CONFIRMED',
      'post-bridge',
      'ext-1',
      'key-1',
      '2026-09-14T17:00:00.000Z',
      'America/New_York',
      source.text,
      '["li","ig"]',
      null,
      '2026-09-14T12:00:00.000Z',
      '2026-09-14T12:00:00.000Z',
    );

    const copy = duplicatePost(db, source.id);
    expect(copy.id).not.toBe(source.id);
    expect(copy).toMatchObject({
      text: source.text,
      channels: ['ig', 'li'],
      mediaUrls: ['https://cdn.example.com/launch.jpg'],
      date: null,
      time: '13:00',
      format: 'ARTICLE',
      status: 'DRAFT',
      cta: 'SOFT',
    });
    // The duplicate joins the campaigns the original belongs to rather than creating second rows.
    expect(copy.campaigns.map((campaign) => campaign.name)).toEqual(['Wk4']);
    expect(copy.campaigns[0]!.id).toBe(source.campaigns[0]!.id);
    expect(listQueue(db).map((item) => item.id)).toEqual([copy.id]);
    expect(getPost(db, source.id)).toMatchObject({
      date: '2026-09-14',
      status: 'PUBLISHED',
      text: source.text,
    });
    expect(
      db.prepare('SELECT COUNT(*) n FROM signal_publications WHERE post_id=?').get(source.id),
    ).toEqual({ n: 1 });
    expect(
      db.prepare('SELECT COUNT(*) n FROM signal_publications WHERE post_id=?').get(copy.id),
    ).toEqual({ n: 0 });
  });

  it('suggests the next free Signal cell and writes it only on confirm', async () => {
    const original = await add({ text: 'Already booked', date: '2026-09-14', time: '09:00' });
    const queued = duplicatePost(db, original.id);
    expect(suggestPostSlot(db, queued.id, '2026-09-14')).toEqual({
      date: '2026-09-15',
      time: '09:00',
    });
    expect(getPost(db, queued.id)?.date).toBeNull();

    const placed = applyPostSlot(db, queued.id, {
      date: '2026-09-15',
      time: '09:00',
      from: '2026-09-14',
    });
    expect(placed).toMatchObject({ date: '2026-09-15', time: '09:00', id: queued.id });
    expect(getPost(db, original.id)?.date).toBe('2026-09-14');
  });

  it('recalculates occupancy immediately before saving a confirmed slot', async () => {
    const queued = await add({ text: 'Waiting for a day', time: '09:00' });
    await add({ text: 'Takes the suggested cell', date: '2026-09-14', time: '09:00' });
    expect(() =>
      applyPostSlot(db, queued.id, { date: '2026-09-14', time: '09:00', from: '2026-09-14' }),
    ).toThrow(SignalSlotConflictError);
    try {
      applyPostSlot(db, queued.id, { date: '2026-09-14', time: '09:00', from: '2026-09-14' });
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        message: 'That slot is no longer open.',
        suggestion: { date: '2026-09-15', time: '09:00' },
      });
    }
    expect(getPost(db, queued.id)?.date).toBeNull();
  });

  it('leaves nothing behind when the channel writes fail part-way', async () => {
    // Duplicate channels only reach the join if validation is bypassed, and the join's primary
    // key then rejects the second one. The transaction is what keeps the post row from
    // surviving on its own: a create either lands whole or does not land.
    await expect(createPost(db, { ...post(), channels: ['li', 'li'] as never })).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM signal_posts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM signal_post_channels').get()).toEqual({ n: 0 });
  });

  it('leaves the post as it was when a patch fails part-way', async () => {
    const created = await add({ text: 'Original', channels: ['li'] });
    await expect(
      updatePost(db, created.id, { text: 'Changed', channels: ['x', 'x'] as never }),
    ).rejects.toThrow();
    expect(getPost(db, created.id)).toMatchObject({ text: 'Original', channels: ['li'] });
  });
});

describe('validation', () => {
  it.each([
    ['an empty post', { text: '   ' }],
    ['an unknown channel', { channels: ['myspace'] }],
    ['an unknown status', { status: 'SENT' }],
    ['an unknown format', { format: 'HOLOGRAM' }],
    ['an unknown call to action', { cta: 'HARD' }],
    ['a malformed date', { date: '14-09-2026' }],
    ['a date that does not exist', { date: '2026-02-31' }],
    ['a malformed time', { date: '2026-09-14', time: '9am' }],
    ['an impossible time', { date: '2026-09-14', time: '25:00' }],
    ['an insecure media URL', { mediaUrls: ['http://example.com/post.jpg'] }],
    ['a malformed media URL', { mediaUrls: ['not a URL'] }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => post(overrides)).toThrow();
  });

  it('accepts the boundary times of a day', () => {
    expect(post({ time: '00:00' }).time).toBe('00:00');
    expect(post({ time: '23:59' }).time).toBe('23:59');
  });

  it('accepts a leap day in a leap year', () => {
    expect(post({ date: '2028-02-29' }).date).toBe('2028-02-29');
  });

  it.each([
    ['https://cdn.example.com/post.JPG?download=1', 'image'],
    ['https://cdn.example.com/post.tiff#page', 'image'],
    ['https://cdn.example.com/post.MP4?download=1', 'video'],
    ['https://cdn.example.com/brief.pdf', 'pdf'],
    ['https://cdn.example.com/extensionless', 'unknown'],
    ['not a URL', 'unknown'],
  ])('infers media kind for %s as %s', (url, kind) => {
    expect(signalMediaKind(url)).toBe(kind);
  });
});

describe('the read provider', () => {
  it('orders a range by date, then time', async () => {
    await add({ text: 'Later that day', date: '2026-09-14', time: '15:00' });
    await add({ text: 'Earlier that day', date: '2026-09-14', time: '09:00' });
    await add({ text: 'The day before', date: '2026-09-13', time: '23:00' });

    const { posts } = await new LocalSignalProvider(db).listPosts({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(posts.map((p) => p.text)).toEqual([
      'The day before',
      'Earlier that day',
      'Later that day',
    ]);
  });

  it('reports available, and has no method that writes', () => {
    const provider = new LocalSignalProvider(db);
    expect(provider.available).toBe(true);
    // The guarantee the calendar leans on: this interface cannot change a schedule.
    expect(Object.keys(Object.getPrototypeOf(provider))).not.toContain('createPost');
    for (const method of ['create', 'update', 'delete', 'save', 'write', 'schedule']) {
      expect(provider).not.toHaveProperty(method);
    }
  });

  it('fails by name when Signal is unavailable, rather than answering an empty schedule', async () => {
    const provider = new UnavailableSignalProvider();
    expect(provider.available).toBe(false);
    await expect(provider.listPosts()).rejects.toThrow('Signal Campaign is unavailable.');
    await expect(provider.listVariants()).rejects.toThrow('Signal Campaign is unavailable.');
    await expect(provider.listPublishTargets()).rejects.toThrow('Signal Campaign is unavailable.');
  });

  it('flags a range it had to cut short', async () => {
    const provider = new LocalSignalProvider(db);
    const within = await provider.listPosts({ from: '2026-09-01', to: '2026-09-30' });
    expect(within.truncated).toBe(false);

    for (let n = 0; n <= SIGNAL_RANGE_LIMIT; n += 1)
      await add({ text: `Post ${n}`, date: '2026-09-14' });
    const over = await provider.listPosts({ from: '2026-09-01', to: '2026-09-30' });
    expect(over.posts).toHaveLength(SIGNAL_RANGE_LIMIT);
    expect(over.truncated).toBe(true);
  });
});

describe('the HTTP boundary', () => {
  const app = () => createApp(db);

  it('creates, reads, patches, and deletes a post', async () => {
    const created = await request(app())
      .post('/api/signal/posts')
      .send({
        text: 'Teach first. Sell second.',
        channels: ['li'],
        mediaUrls: ['https://cdn.example.com/first.jpg', 'https://cdn.example.com/second.mp4'],
        date: '2026-09-21',
      })
      .expect(201);
    expect(created.body).toMatchObject({
      date: '2026-09-21',
      channels: ['li'],
      mediaUrls: ['https://cdn.example.com/first.jpg', 'https://cdn.example.com/second.mp4'],
      status: 'DRAFT',
    });

    await request(app()).get(`/api/signal/posts/${created.body.id}`).expect(200);
    const patched = await request(app())
      .patch(`/api/signal/posts/${created.body.id}`)
      .send({
        status: 'SCHEDULED',
        mediaUrls: ['https://cdn.example.com/second.mp4', 'https://cdn.example.com/first.jpg'],
        revision: created.body.revision,
      })
      .expect(200);
    expect(patched.body.status).toBe('SCHEDULED');
    expect(patched.body.mediaUrls).toEqual([
      'https://cdn.example.com/second.mp4',
      'https://cdn.example.com/first.jpg',
    ]);

    await request(app()).delete(`/api/signal/posts/${created.body.id}`).expect(200);
    await request(app()).get(`/api/signal/posts/${created.body.id}`).expect(404);
  });

  it('marks published with the current revision and refuses a stale revision without overwriting', async () => {
    const created = await request(app())
      .post('/api/signal/posts')
      .send({ text: 'Publish this version', channels: ['li'], date: '2026-09-21' })
      .expect(201);

    const published = await request(app())
      .patch(`/api/signal/posts/${created.body.id}`)
      .send({ status: 'PUBLISHED', revision: created.body.revision })
      .expect(200);
    expect(published.body).toMatchObject({
      text: 'Publish this version',
      status: 'PUBLISHED',
      revision: created.body.revision + 1,
    });

    const stale = await request(app())
      .patch(`/api/signal/posts/${created.body.id}`)
      .send({ status: 'SCHEDULED', revision: created.body.revision })
      .expect(409);
    expect(stale.body).toMatchObject({
      code: 'conflict',
      currentRevision: created.body.revision + 1,
      changedFields: ['status'],
    });
    expect(
      (await request(app()).get(`/api/signal/posts/${created.body.id}`).expect(200)).body,
    ).toMatchObject({
      text: 'Publish this version',
      status: 'PUBLISHED',
      revision: created.body.revision + 1,
    });
  });

  it('answers 404 for a patch or delete against a post that is not there', async () => {
    await request(app())
      .patch('/api/signal/posts/nope')
      .send({ text: 'x', revision: 1 })
      .expect(404);
    await request(app()).delete('/api/signal/posts/nope').expect(404);
  });

  it('rejects an unknown channel at the boundary with the reason', async () => {
    const response = await request(app())
      .post('/api/signal/posts')
      .send({ text: 'Anywhere', channels: ['myspace'] })
      .expect(400);
    expect(response.body.error).toBeTruthy();
  });

  it('rejects a non-https media reference at the HTTP boundary with the reason', async () => {
    const response = await request(app())
      .post('/api/signal/posts')
      .send({ text: 'Do not fetch this', mediaUrls: ['http://example.com/post.jpg'] })
      .expect(400);
    expect(response.body.error).toBe('Media URLs must use https.');
  });

  it('reads a range and refuses one that ends before it starts', async () => {
    await add({ text: 'In range', date: '2026-09-14' });
    await add({ text: 'Out of range', date: '2026-10-14' });

    const response = await request(app())
      .get('/api/signal/posts?from=2026-09-01&to=2026-09-30')
      .expect(200);
    expect(response.body.posts.map((p: { text: string }) => p.text)).toEqual(['In range']);
    expect(response.body).toMatchObject({ from: '2026-09-01', to: '2026-09-30', truncated: false });

    await request(app()).get('/api/signal/posts?from=2026-09-30&to=2026-09-01').expect(400);
    await request(app()).get('/api/signal/posts?from=nope&to=2026-09-30').expect(400);
  });

  it('serves the queue separately, and never inside a range', async () => {
    const queued = await add({ text: 'Unscheduled idea' });
    await add({ text: 'Scheduled', date: '2026-09-14' });

    const queue = await request(app()).get('/api/signal/queue').expect(200);
    expect(queue.body.map((p: { id: string }) => p.id)).toEqual([queued.id]);

    const range = await request(app())
      .get('/api/signal/posts?from=0001-01-01&to=9999-12-31')
      .expect(200);
    expect(range.body.posts.map((p: { text: string }) => p.text)).toEqual(['Scheduled']);
  });

  it('duplicates a post over HTTP and confirms a suggested slot after a conflict', async () => {
    const created = await request(app())
      .post('/api/signal/posts')
      .send({
        text: 'The September launch post',
        channels: ['li'],
        mediaUrls: ['https://cdn.example.com/launch.jpg'],
        date: '2026-09-14',
        time: '09:00',
        campaigns: ['Wk4'],
        status: 'SCHEDULED',
      })
      .expect(201);

    const copy = await request(app())
      .post(`/api/signal/posts/${created.body.id}/duplicate`)
      .expect(201);
    expect(copy.body).toMatchObject({
      text: 'The September launch post',
      channels: ['li'],
      mediaUrls: ['https://cdn.example.com/launch.jpg'],
      date: null,
      time: '09:00',
      status: 'DRAFT',
    });
    expect(copy.body.campaigns.map((c: { name: string }) => c.name)).toEqual(['Wk4']);
    expect(copy.body.id).not.toBe(created.body.id);

    const suggestion = await request(app())
      .get(`/api/signal/posts/${copy.body.id}/next-slot?from=2026-09-14`)
      .expect(200);
    expect(suggestion.body).toEqual({ date: '2026-09-15', time: '09:00' });
    expect(
      (await request(app()).get(`/api/signal/posts/${copy.body.id}`).expect(200)).body.date,
    ).toBeNull();

    await request(app())
      .post('/api/signal/posts')
      .send({ text: 'Takes Tuesday', date: '2026-09-15', time: '09:00' })
      .expect(201);

    const refused = await request(app())
      .post(`/api/signal/posts/${copy.body.id}/slot`)
      .send({ date: '2026-09-15', time: '09:00', from: '2026-09-14', revision: copy.body.revision })
      .expect(409);
    expect(refused.body).toMatchObject({
      error: 'That slot is no longer open.',
      code: 'SLOT_TAKEN',
      suggestion: { date: '2026-09-16', time: '09:00' },
    });

    const placed = await request(app())
      .post(`/api/signal/posts/${copy.body.id}/slot`)
      .send({ ...refused.body.suggestion, from: '2026-09-14', revision: copy.body.revision })
      .expect(200);
    expect(placed.body).toMatchObject({ date: '2026-09-16', time: '09:00', id: copy.body.id });
    expect(
      (await request(app()).get(`/api/signal/posts/${created.body.id}`).expect(200)).body.date,
    ).toBe('2026-09-14');
  });
});
