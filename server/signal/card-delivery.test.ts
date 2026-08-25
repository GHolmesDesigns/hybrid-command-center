import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { MockPublishProvider } from '../publish/mock-provider.ts';
import { seedSignalPost } from './test-fixture.ts';
import { readCardDeliveries } from './card-delivery.ts';
import { publicationsForPosts } from '../publish/read.ts';
import type { PublicationState } from '../../shared/publish.ts';

/**
 * The gathering half for planner-card delivery.
 *
 * Derivation rules live in `shared/card-delivery.test.ts`. What is checked here is that one
 * bounded local read covers the range and the queue, contacts no provider, and refuses a backwards
 * range the same way the posts endpoint does.
 */

let db: Db;
let publicationSequence = 0;

beforeEach(() => {
  db = createDb(':memory:');
  publicationSequence = 0;
});

const seedPublication = (
  postId: string,
  overrides: {
    state?: PublicationState;
    createdAt?: string;
    targets?: {
      channel: string;
      accountId: number;
      mode?: string;
      outcome?: 'SUCCESS' | 'FAILURE';
      manualCompletedAt?: string;
    }[];
  } = {},
) => {
  const id = `pub-${++publicationSequence}`;
  const createdAt = overrides.createdAt ?? '2026-09-14T09:00:00.000Z';
  db.prepare(
    `INSERT INTO signal_publications(
       id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
       sent_caption,sent_channels,sent_media,check_attempts,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    postId,
    overrides.state ?? 'SUBMITTED',
    'post-bridge',
    'provider-1',
    `idem-${id}`,
    '2026-09-20T13:00:00.000Z',
    'America/New_York',
    'Caption',
    JSON.stringify(['x']),
    JSON.stringify([]),
    0,
    createdAt,
    createdAt,
  );
  for (const target of overrides.targets ?? [
    { channel: 'x', accountId: 4, mode: 'AUTOMATIC', outcome: undefined },
  ]) {
    db.prepare(
      `INSERT INTO signal_publication_targets(
         publication_id,channel,provider_account_id,outcome,handle,mode,manual_completed_at)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(
      id,
      target.channel,
      target.accountId,
      target.outcome ?? null,
      '@gholmes',
      target.mode ?? 'AUTOMATIC',
      target.manualCompletedAt ?? null,
    );
  }
  return id;
};

const app = () => createApp(db, { publish: new MockPublishProvider() });

describe('card delivery batch', () => {
  it('derives one answer per post in the range and the queue from local rows', () => {
    const dated = seedSignalPost(db, {
      id: 'dated',
      date: '2026-09-14',
      status: 'SCHEDULED',
      text: 'Dated post',
    });
    const queued = seedSignalPost(db, {
      id: 'queued',
      date: null,
      status: 'DRAFT',
      text: 'Queued post',
    });
    const otherMonth = seedSignalPost(db, {
      id: 'other',
      date: '2026-10-01',
      status: 'SCHEDULED',
      text: 'Outside range',
    });
    seedPublication(dated.id, { state: 'PARTIAL' });
    seedPublication(queued.id, { state: 'FAILED' });
    seedPublication(otherMonth.id, { state: 'CONFIRMED' });

    const snapshot = readCardDeliveries(db, '2026-09-01', '2026-09-30');
    expect(snapshot.from).toBe('2026-09-01');
    expect(snapshot.to).toBe('2026-09-30');
    expect(snapshot.deliveries).toEqual(
      expect.arrayContaining([
        { postId: 'dated', state: 'PARTIAL', label: 'Partly delivered' },
        { postId: 'queued', state: 'FAILED', label: 'Not delivered' },
      ]),
    );
    expect(snapshot.deliveries.find((entry) => entry.postId === 'other')).toBeUndefined();
  });

  it('answers through the HTTP boundary without writing planning status', async () => {
    const post = seedSignalPost(db, {
      id: 'http-post',
      date: '2026-09-14',
      status: 'SCHEDULED',
      text: 'HTTP card',
    });
    seedPublication(post.id, {
      state: 'SUBMITTED',
      targets: [
        {
          channel: 'tt',
          accountId: 8,
          mode: 'MANUAL_FINISH',
          outcome: 'SUCCESS',
        },
      ],
    });

    const response = await request(app())
      .get('/api/signal/card-delivery?from=2026-09-01&to=2026-09-30')
      .expect(200);
    expect(response.body.deliveries).toContainEqual({
      postId: 'http-post',
      state: 'MANUAL',
      label: 'Finish by hand',
    });
    expect(
      (
        db.prepare('SELECT status FROM signal_posts WHERE id=?').get('http-post') as {
          status: string;
        }
      ).status,
    ).toBe('SCHEDULED');
  });

  it('refuses a backwards range', async () => {
    await request(app()).get('/api/signal/card-delivery?from=2026-09-30&to=2026-09-01').expect(400);
  });

  it('returns an empty batch when the range and queue hold no posts', () => {
    expect(readCardDeliveries(db, '2026-01-01', '2026-01-31')).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      deliveries: [],
    });
    expect(publicationsForPosts(db, [])).toEqual([]);
  });
});
