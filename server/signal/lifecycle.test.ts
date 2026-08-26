import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { listPostsInRange } from './read.ts';
import {
  createPost,
  deletePost,
  getPost,
  listQueue,
  retirePost,
  SignalPostProtectedError,
  signalPostInput,
  updatePost,
} from './service.ts';
import { createApp } from '../app.ts';
import request from 'supertest';

/**
 * C107: lifecycle RETIRED and Outside-of-Signal provenance stay off the planning-status select.
 */
describe('Signal lifecycle and delivery provenance', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const add = (overrides: Record<string, unknown> = {}) =>
    createPost(
      db,
      signalPostInput.parse({
        text: 'A plan',
        channels: ['x'],
        date: '2099-10-12',
        time: '09:00',
        status: 'SCHEDULED',
        ...overrides,
      }),
    );

  it('defaults every historical shape to an active in-Signal plan', async () => {
    const post = await add();
    expect(post).toMatchObject({
      status: 'SCHEDULED',
      lifecycle: 'ACTIVE',
      retiredAt: null,
      deliveryProvenance: 'IN_SIGNAL',
    });
  });

  it('keeps planning status Draft/Scheduled/Published when retiring', async () => {
    const post = await add({ status: 'PUBLISHED' });
    const retired = retirePost(db, post.id);
    expect(retired.status).toBe('PUBLISHED');
    expect(retired.lifecycle).toBe('RETIRED');
    expect(retired.retiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(listPostsInRange(db, '2099-10-01', '2099-10-31').posts).toEqual([]);
    expect(listPostsInRange(db, '2099-10-01', '2099-10-31', 'retired').posts).toHaveLength(1);
    expect(listPostsInRange(db, '2099-10-01', '2099-10-31', 'all').posts).toHaveLength(1);
  });

  it('refuses hard-delete when publication history exists and retires instead via HTTP', async () => {
    const post = await add();
    db.prepare(
      `INSERT INTO signal_publications(
        id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
        sent_caption,sent_channels,error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'pub-1',
      post.id,
      'CONFIRMED',
      'post-bridge',
      'ext-1',
      'key-1',
      '2099-10-12T13:00:00.000Z',
      'America/New_York',
      post.text,
      '["x"]',
      null,
      '2099-10-01T00:00:00.000Z',
      '2099-10-01T00:00:00.000Z',
    );
    expect(() => deletePost(db, post.id)).toThrow(SignalPostProtectedError);
    expect(getPost(db, post.id)?.lifecycle).toBe('ACTIVE');

    const app = createApp(db);
    await request(app).delete(`/api/signal/posts/${post.id}`).expect(409);
    const retired = await request(app).post(`/api/signal/posts/${post.id}/retire`).expect(200);
    expect(retired.body.lifecycle).toBe('RETIRED');
    expect(retired.body.status).toBe('SCHEDULED');
    expect(
      db.prepare('SELECT COUNT(*) n FROM signal_publications WHERE post_id=?').get(post.id),
    ).toEqual({ n: 1 });
  });

  it('refuses retire while a provider submission is still in flight', async () => {
    const post = await add();
    db.prepare(
      `INSERT INTO signal_publications(
        id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
        sent_caption,sent_channels,error,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      'pub-live',
      post.id,
      'SUBMITTED',
      'post-bridge',
      'ext-live',
      'key-live',
      '2099-10-12T13:00:00.000Z',
      'America/New_York',
      post.text,
      '["x"]',
      null,
      '2099-10-01T00:00:00.000Z',
      '2099-10-01T00:00:00.000Z',
    );
    expect(() => retirePost(db, post.id)).toThrow(/Withdraw or reconcile/);
  });

  it('lets a person mark and clear Outside of Signal without inventing delivery', async () => {
    const post = await add();
    const marked = await updatePost(db, post.id, { deliveryProvenance: 'OUTSIDE_SIGNAL' });
    expect(marked.deliveryProvenance).toBe('OUTSIDE_SIGNAL');
    expect(marked.status).toBe('SCHEDULED');
    expect(
      db.prepare('SELECT COUNT(*) n FROM signal_publications WHERE post_id=?').get(post.id),
    ).toEqual({ n: 0 });

    const cleared = await updatePost(db, post.id, { deliveryProvenance: 'IN_SIGNAL' });
    expect(cleared.deliveryProvenance).toBe('IN_SIGNAL');
  });

  it('filters the unscheduled queue by lifecycle and hard-deletes drafts without history', async () => {
    const queued = await add({ date: null, status: 'DRAFT' });
    retirePost(db, queued.id);
    expect(listQueue(db)).toEqual([]);
    expect(listQueue(db, 'retired')).toHaveLength(1);

    const draft = await add({ date: null, text: 'Throwaway', status: 'DRAFT' });
    deletePost(db, draft.id);
    expect(getPost(db, draft.id)).toBeUndefined();
  });

  it('exposes lifecycle on the range route and never puts RETIRED on planning status', async () => {
    const post = await add();
    retirePost(db, post.id);
    const app = createApp(db);
    const active = await request(app)
      .get('/api/signal/posts?from=2099-10-01&to=2099-10-31')
      .expect(200);
    expect(active.body.posts).toEqual([]);
    const retired = await request(app)
      .get('/api/signal/posts?from=2099-10-01&to=2099-10-31&lifecycle=retired')
      .expect(200);
    expect(retired.body.posts[0]).toMatchObject({
      id: post.id,
      status: 'SCHEDULED',
      lifecycle: 'RETIRED',
    });
    expect(retired.body.posts[0].status).not.toBe('RETIRED');
  });
});
