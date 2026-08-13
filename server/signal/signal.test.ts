import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { LocalSignalProvider, listPostsInRange } from './read.ts';
import { UnavailableSignalProvider } from './provider.ts';
import {
  SignalPostNotFoundError,
  createPost,
  deletePost,
  getPost,
  listQueue,
  signalPostInput,
  updatePost,
} from './service.ts';
import { SIGNAL_RANGE_LIMIT, isSignalPostInRange, signalMonthBounds } from '../../shared/signal.ts';

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
  ])('keeps a post on its own day in %s', (_label, timeZone) => {
    // The cell rule compares stored strings and derives no instant, so the server's zone cannot
    // move a post across a day boundary. Asserting it here is what keeps that true.
    process.env.TZ = timeZone;
    const created = add({ date: '2026-09-14', time: '23:30' });
    const { posts } = listPostsInRange(db, '2026-09-14', '2026-09-14');
    expect(posts.map((p) => p.id)).toEqual([created.id]);
    expect(listPostsInRange(db, '2026-09-15', '2026-09-15').posts).toEqual([]);
  });
});

describe('writing posts', () => {
  it('creates an unscheduled post by default and puts it in the queue', () => {
    const created = add();
    expect(created.date).toBeNull();
    expect(created.status).toBe('DRAFT');
    expect(created.cta).toBe('NONE');
    expect(listQueue(db).map((p) => p.id)).toEqual([created.id]);
    expect(listPostsInRange(db, '0001-01-01', '9999-12-31').posts).toEqual([]);
  });

  it('queues new posts behind the ones already there, and appends a post sent back', () => {
    const first = add({ text: 'First idea' });
    const second = add({ text: 'Second idea' });
    const dated = add({ text: 'Third idea', date: '2026-09-14' });
    expect(listQueue(db).map((p) => p.id)).toEqual([first.id, second.id]);

    const returned = updatePost(db, dated.id, { date: null });
    expect(returned.date).toBeNull();
    expect(listQueue(db).map((p) => p.id)).toEqual([first.id, second.id, dated.id]);
  });

  it('stores channels as rows and hands them back deduplicated and ordered', () => {
    const created = add({ channels: ['li', 'ig', 'li', 'blog'] });
    expect(created.channels).toEqual(['blog', 'ig', 'li']);
    const rows = db
      .prepare('SELECT COUNT(*) n FROM signal_post_channels WHERE post_id=?')
      .get(created.id) as { n: number };
    expect(rows.n).toBe(3);
  });

  it('replaces channels on patch and leaves them alone when the patch omits them', () => {
    const created = add({ channels: ['li', 'ig'] });
    expect(updatePost(db, created.id, { channels: ['x'] }).channels).toEqual(['x']);
    expect(updatePost(db, created.id, { text: 'Reworded' }).channels).toEqual(['x']);
  });

  it('changes only what a patch names', () => {
    const created = add({
      date: '2026-09-14',
      time: '13:00',
      campaign: 'Wk4',
      status: 'SCHEDULED',
    });
    const patched = updatePost(db, created.id, { status: 'PUBLISHED' });
    expect(patched).toMatchObject({
      date: '2026-09-14',
      time: '13:00',
      campaign: 'Wk4',
      status: 'PUBLISHED',
      text: created.text,
    });
  });

  it('distinguishes clearing a nullable field from leaving it alone', () => {
    const created = add({ campaign: 'Wk4', date: '2026-09-14' });
    expect(updatePost(db, created.id, { text: 'Reworded' }).campaign).toBe('Wk4');
    expect(updatePost(db, created.id, { campaign: null }).campaign).toBeNull();
  });

  it('takes the channel rows with the post when it is deleted', () => {
    const created = add({ channels: ['li', 'ig'] });
    deletePost(db, created.id);
    expect(getPost(db, created.id)).toBeUndefined();
    const rows = db.prepare('SELECT COUNT(*) n FROM signal_post_channels').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('refuses to edit or delete a post that does not exist', () => {
    expect(() => updatePost(db, 'nope', { text: 'x' })).toThrow(SignalPostNotFoundError);
    expect(() => deletePost(db, 'nope')).toThrow(SignalPostNotFoundError);
  });

  it('leaves nothing behind when the channel writes fail part-way', () => {
    // Duplicate channels only reach the join if validation is bypassed, and the join's primary
    // key then rejects the second one. The transaction is what keeps the post row from
    // surviving on its own: a create either lands whole or does not land.
    expect(() => createPost(db, { ...post(), channels: ['li', 'li'] as never })).toThrow();
    expect(db.prepare('SELECT COUNT(*) n FROM signal_posts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM signal_post_channels').get()).toEqual({ n: 0 });
  });

  it('leaves the post as it was when a patch fails part-way', () => {
    const created = add({ text: 'Original', channels: ['li'] });
    expect(() =>
      updatePost(db, created.id, { text: 'Changed', channels: ['x', 'x'] as never }),
    ).toThrow();
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
});

describe('the read provider', () => {
  it('orders a range by date, then time', async () => {
    add({ text: 'Later that day', date: '2026-09-14', time: '15:00' });
    add({ text: 'Earlier that day', date: '2026-09-14', time: '09:00' });
    add({ text: 'The day before', date: '2026-09-13', time: '23:00' });

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
  });

  it('flags a range it had to cut short', async () => {
    const provider = new LocalSignalProvider(db);
    const within = await provider.listPosts({ from: '2026-09-01', to: '2026-09-30' });
    expect(within.truncated).toBe(false);

    for (let n = 0; n <= SIGNAL_RANGE_LIMIT; n += 1) add({ text: `Post ${n}`, date: '2026-09-14' });
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
      .send({ text: 'Teach first. Sell second.', channels: ['li'], date: '2026-09-21' })
      .expect(201);
    expect(created.body).toMatchObject({ date: '2026-09-21', channels: ['li'], status: 'DRAFT' });

    await request(app()).get(`/api/signal/posts/${created.body.id}`).expect(200);
    const patched = await request(app())
      .patch(`/api/signal/posts/${created.body.id}`)
      .send({ status: 'SCHEDULED' })
      .expect(200);
    expect(patched.body.status).toBe('SCHEDULED');

    await request(app()).delete(`/api/signal/posts/${created.body.id}`).expect(200);
    await request(app()).get(`/api/signal/posts/${created.body.id}`).expect(404);
  });

  it('answers 404 for a patch or delete against a post that is not there', async () => {
    await request(app()).patch('/api/signal/posts/nope').send({ text: 'x' }).expect(404);
    await request(app()).delete('/api/signal/posts/nope').expect(404);
  });

  it('rejects an unknown channel at the boundary with the reason', async () => {
    const response = await request(app())
      .post('/api/signal/posts')
      .send({ text: 'Anywhere', channels: ['myspace'] })
      .expect(400);
    expect(response.body.error).toBeTruthy();
  });

  it('reads a range and refuses one that ends before it starts', async () => {
    add({ text: 'In range', date: '2026-09-14' });
    add({ text: 'Out of range', date: '2026-10-14' });

    const response = await request(app())
      .get('/api/signal/posts?from=2026-09-01&to=2026-09-30')
      .expect(200);
    expect(response.body.posts.map((p: { text: string }) => p.text)).toEqual(['In range']);
    expect(response.body).toMatchObject({ from: '2026-09-01', to: '2026-09-30', truncated: false });

    await request(app()).get('/api/signal/posts?from=2026-09-30&to=2026-09-01').expect(400);
    await request(app()).get('/api/signal/posts?from=nope&to=2026-09-30').expect(400);
  });

  it('serves the queue separately, and never inside a range', async () => {
    const queued = add({ text: 'Unscheduled idea' });
    add({ text: 'Scheduled', date: '2026-09-14' });

    const queue = await request(app()).get('/api/signal/queue').expect(200);
    expect(queue.body.map((p: { id: string }) => p.id)).toEqual([queued.id]);

    const range = await request(app())
      .get('/api/signal/posts?from=0001-01-01&to=9999-12-31')
      .expect(200);
    expect(range.body.posts.map((p: { text: string }) => p.text)).toEqual(['Scheduled']);
  });
});
