import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { UnavailableBufferReadProvider } from '../publish/buffer/read-provider.ts';
import { buildPublishPlan } from '../publish/plan.ts';
import { seedSignalPost } from './test-fixture.ts';
import {
  SignalPublishTargetError,
  getPost,
  getPostPublishTargets,
  replacePostPublishTargets,
  signalPublishTargetsInput,
} from './service.ts';
import type { PublishTarget } from '../publish/provider.ts';
import type { SignalPost } from '../../shared/signal.ts';
import { MockPublishProvider } from '../publish/mock-provider.ts';

/**
 * An **explicit** choice of which provider accounts a Signal channel publishes to (C77, first
 * piece: the store and the boundary, with no planning change yet).
 *
 * The claim this suite exists to keep true is the additive one. C77 is only safe to land in pieces
 * because a post with no selection behaves exactly as it did before the table existed, so the
 * planning assertions below are deliberately about *sameness*: rows in this table must not change
 * what `buildPublishPlan` produces until the piece that teaches it to read them.
 *
 * The other half is that a selection is validated against the account list the preview was built
 * from, and that the three ways it can be wrong stay three different sentences.
 */

const FB_GHD = 85300;
const FB_WILD = 85301;
const FB_ADDRIVE = 85299;
const IG = 85292;

const CONNECTED: PublishTarget[] = [
  { id: FB_GHD, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: FB_WILD, platform: 'facebook', handle: 'wildeyephoto', name: 'Wild Eye Photography' },
  { id: FB_ADDRIVE, platform: 'facebook', handle: 'addrivemedia', name: 'AdDrive Media' },
  { id: IG, platform: 'instagram', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
];

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const app = () =>
  createApp(db, {
    publish: new MockPublishProvider(CONNECTED),
    bufferRead: new UnavailableBufferReadProvider(),
  });

const save = (postId: string, targets: unknown[], connected: PublishTarget[] = CONNECTED) =>
  replacePostPublishTargets(db, postId, signalPublishTargetsInput.parse({ targets }), connected);

const rows = (postId: string) =>
  db
    .prepare(
      'SELECT * FROM signal_post_publish_targets WHERE post_id=? ORDER BY channel, provider_account_id',
    )
    .all(postId) as unknown as Record<string, unknown>[];

describe('an explicit publish target selection', () => {
  it('starts empty, which is not the same as choosing nothing', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    expect(getPostPublishTargets(db, post.id)).toEqual([]);
  });

  it('stores one row per account and reads back ordered by channel then id', () => {
    const post = seedSignalPost(db, { channels: ['fb', 'ig'] });
    const saved = save(post.id, [
      { channel: 'ig', providerAccountIds: [IG] },
      { channel: 'fb', providerAccountIds: [FB_WILD, FB_GHD] },
    ]);
    expect(saved).toEqual([
      { channel: 'fb', providerAccountId: FB_GHD },
      { channel: 'fb', providerAccountId: FB_WILD },
      { channel: 'ig', providerAccountId: IG },
    ]);
    expect(rows(post.id)).toHaveLength(3);
  });

  it('replaces rather than patches, so a channel dropped from the request is dropped', () => {
    const post = seedSignalPost(db, { channels: ['fb', 'ig'] });
    save(post.id, [
      { channel: 'fb', providerAccountIds: [FB_GHD] },
      { channel: 'ig', providerAccountIds: [IG] },
    ]);
    expect(save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }])).toEqual([
      { channel: 'fb', providerAccountId: FB_GHD },
    ]);
  });

  it('is idempotent: the same selection written twice is the same rows', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    const once = save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD, FB_WILD] }]);
    const twice = save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD, FB_WILD] }]);
    expect(twice).toEqual(once);
    expect(rows(post.id)).toHaveLength(2);
  });

  it('collapses a repeated account rather than refusing it', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    expect(save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD, FB_GHD] }])).toEqual([
      { channel: 'fb', providerAccountId: FB_GHD },
    ]);
  });

  it('clears a selection when the channel is sent with an empty list', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }]);
    expect(save(post.id, [{ channel: 'fb', providerAccountIds: [] }])).toEqual([]);
  });

  it('goes away with the post', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }]);
    db.prepare('DELETE FROM signal_posts WHERE id=?').run(post.id);
    expect(rows(post.id)).toEqual([]);
  });
});

describe('what a selection refuses, and in which words', () => {
  it('refuses an account the connected list does not carry', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    expect(() => save(post.id, [{ channel: 'fb', providerAccountIds: [999999] }])).toThrow(
      SignalPublishTargetError,
    );
    expect(() => save(post.id, [{ channel: 'fb', providerAccountIds: [999999] }])).toThrow(
      /not in the connected list/,
    );
  });

  it('refuses an account that is connected but on another platform', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    expect(() => save(post.id, [{ channel: 'fb', providerAccountIds: [IG] }])).toThrow(
      /is a instagram account/,
    );
  });

  it('refuses a channel the provider cannot reach', () => {
    const post = seedSignalPost(db, { channels: ['blog'] });
    expect(() => save(post.id, [{ channel: 'blog', providerAccountIds: [FB_GHD] }])).toThrow(
      /not reachable through this provider/,
    );
  });

  it('names one channel twice as a refusal rather than letting one win', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    expect(() =>
      save(post.id, [
        { channel: 'fb', providerAccountIds: [FB_GHD] },
        { channel: 'fb', providerAccountIds: [FB_WILD] },
      ]),
    ).toThrow(/two target lists at once/);
  });

  it('refuses an account that has since been disconnected, against the list it is given', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }]);
    const withoutGhd = CONNECTED.filter((target) => target.id !== FB_GHD);
    expect(() =>
      save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }], withoutGhd),
    ).toThrow(/not in the connected list/);
  });

  it('writes nothing at all when one account in the request is refused', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }]);
    expect(() => save(post.id, [{ channel: 'fb', providerAccountIds: [FB_WILD, 999999] }])).toThrow(
      SignalPublishTargetError,
    );
    expect(getPostPublishTargets(db, post.id)).toEqual([
      { channel: 'fb', providerAccountId: FB_GHD },
    ]);
  });

  it('refuses a post that is not there', () => {
    expect(() => save('no-such-post', [{ channel: 'fb', providerAccountIds: [FB_GHD] }])).toThrow(
      /No Signal post/,
    );
  });
});

describe('the route', () => {
  it('answers the stored selection', async () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD] }]);
    const response = await request(app()).get(`/api/signal/posts/${post.id}/publish-targets`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ channel: 'fb', providerAccountId: FB_GHD }]);
  });

  it('saves a selection and answers what it stored', async () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    const response = await request(app())
      .put(`/api/signal/posts/${post.id}/publish-targets`)
      .send({
        targets: [{ channel: 'fb', providerAccountIds: [FB_GHD, FB_WILD] }],
        revision: post.revision,
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { channel: 'fb', providerAccountId: FB_GHD },
      { channel: 'fb', providerAccountId: FB_WILD },
    ]);
  });

  it('answers 400 for an account the provider does not list', async () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    const response = await request(app())
      .put(`/api/signal/posts/${post.id}/publish-targets`)
      .send({
        targets: [{ channel: 'fb', providerAccountIds: [424242] }],
        revision: post.revision,
      });
    expect(response.status).toBe(400);
  });

  it('answers 400 for a channel that is not a Signal channel', async () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    const response = await request(app())
      .put(`/api/signal/posts/${post.id}/publish-targets`)
      .send({
        targets: [{ channel: 'mastodon', providerAccountIds: [FB_GHD] }],
        revision: post.revision,
      });
    expect(response.status).toBe(400);
  });

  it('answers 404 for a post that is not there', async () => {
    const response = await request(app())
      .put('/api/signal/posts/no-such-post/publish-targets')
      .send({ targets: [], revision: 1 });
    expect(response.status).toBe(404);
  });

  it('records no integration activity: this is Signal editing its own data', async () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    await request(app())
      .put(`/api/signal/posts/${post.id}/publish-targets`)
      .send({
        targets: [{ channel: 'fb', providerAccountIds: [FB_GHD] }],
        revision: post.revision,
      });
    const events = db.prepare('SELECT COUNT(*) AS n FROM integration_events').get() as {
      n: number;
    };
    expect(events.n).toBe(0);
  });
});

describe('until the planner reads them, a selection changes nothing', () => {
  /**
   * The whole reason C77 can land in pieces. `buildPublishPlan` has not been taught about this
   * table yet, so a post carrying rows must plan byte for byte as the same post without them —
   * including the channel with two accounts selected, which is the case the later pieces change.
   */
  const plan = (postId: string) =>
    buildPublishPlan(
      getPost(db, postId) as SignalPost,
      CONNECTED,
      'America/New_York',
      new Date('2027-08-01T00:00:00.000Z'),
    );

  it('plans identically before and after a selection is written', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    const before = JSON.stringify(plan(post.id));
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_GHD, FB_WILD] }]);
    // The same post, so the plan hash is comparable: writing targets must not move it, or every
    // open confirmation would go stale the moment this table gained a row.
    expect(JSON.stringify(plan(post.id))).toBe(before);
  });

  it('still resolves Facebook to its one permitted page while three are connected', () => {
    const post = seedSignalPost(db, { channels: ['fb'] });
    save(post.id, [{ channel: 'fb', providerAccountIds: [FB_WILD] }]);
    const report = plan(post.id).channels.find((entry) => entry.channel === 'fb');
    // The selection names Wild Eye; §3.1's rule has not been replaced yet, so the plan still
    // resolves G.Holmes Designs and the row is inert.
    expect(report?.accountId).toBe(FB_GHD);
  });
});
