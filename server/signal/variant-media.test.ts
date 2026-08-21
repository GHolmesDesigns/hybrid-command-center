import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { backfillSignalVariantRoleMedia, createDb, type Db } from '../db.ts';
import { MockDriveMediaProvider } from '../drive/mock-provider.ts';
import { buildPublishPlan } from '../publish/plan.ts';
import { seedSignalPost } from './test-fixture.ts';
import {
  SignalMediaError,
  SignalVariantError,
  getPost,
  getPostVariants,
  recheckVariantMedia,
  replacePostVariants,
  signalVariantsInput,
} from './service.ts';
import type { PublishTarget } from '../publish/provider.ts';
import type { SignalPost } from '../../shared/signal.ts';

/**
 * A media **role** on a variant layer: the cover image and the thumbnail, as version-bound
 * references rather than URL strings (C76).
 *
 * Two claims this suite keeps returning to, because both are the kind that stay true only while
 * something checks them:
 *
 * 1. **One writable source of truth.** The legacy `cover_image_url` and `thumbnail_url` columns are
 *    moved into role rows once and then hold nothing, so a role a person removes afterwards does not
 *    come back on the next boot.
 * 2. **A preview makes no Drive call**, roles included. Every case that plans asserts the mock
 *    provider's call list afterwards.
 */

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const OTHER_ID = '2ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;

let db: Db;
let drive: MockDriveMediaProvider;
beforeEach(() => {
  db = createDb(':memory:');
  drive = new MockDriveMediaProvider();
  drive.seed(FILE_ID, { name: 'cover.png', mimeType: 'image/png', size: '2048' });
  drive.seed(OTHER_ID, { name: 'other-cover.png', mimeType: 'image/png', size: '4096' });
});

const app = () => createApp(db, { driveMedia: () => drive });

const roleRows = (postId: string) =>
  db
    .prepare('SELECT * FROM signal_post_variant_media WHERE post_id=? ORDER BY platform, role')
    .all(postId) as unknown as Record<string, unknown>[];

const save = (postId: string, variants: unknown[]) =>
  replacePostVariants(db, postId, signalVariantsInput.parse({ variants }), drive);

/**
 * Puts the post's `updated_at` back to a known instant.
 *
 * Two writes inside one millisecond produce the same ISO string, so "did the bump happen" is not
 * answerable by comparing two timestamps taken in the same test tick. Standing the value back to a
 * fixed past instant first makes the question deterministic without a clock seam the service does
 * not have.
 */
const rewind = (postId: string) => {
  db.prepare("UPDATE signal_posts SET updated_at='2026-01-01T00:00:00.000Z' WHERE id=?").run(
    postId,
  );
  return '2026-01-01T00:00:00.000Z';
};

const postStamp = (postId: string) =>
  (
    db.prepare('SELECT updated_at FROM signal_posts WHERE id=?').get(postId) as {
      updated_at: string;
    }
  ).updated_at;

const targets: PublishTarget[] = [
  { id: 905, platform: 'instagram', handle: '@gholmes', name: 'G.Holmes Designs' },
  { id: 906, platform: 'youtube', handle: '@gholmes', name: 'G.Holmes Designs' },
];

describe('the normalized role table and its migration', () => {
  it('moves a legacy URL into a role row once, clears the column, and stays put', () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    db.prepare(
      `INSERT INTO signal_post_variants(post_id,platform,account_id,cover_image_url,thumbnail_url,updated_at)
       VALUES(?,?,NULL,?,?,?)`,
    ).run(post.id, 'instagram', 'https://cdn.example.com/legacy-cover.png', null, 'legacy-time');

    expect(backfillSignalVariantRoleMedia(db)).toBe(1);
    expect(roleRows(post.id)).toMatchObject([
      {
        platform: 'instagram',
        account_id: null,
        role: 'COVER_IMAGE',
        url: 'https://cdn.example.com/legacy-cover.png',
        source: 'URL',
        drive_file_id: null,
        updated_at: 'legacy-time',
      },
    ]);
    // The column it came from now holds nothing, which is what makes the move a move.
    expect(
      db.prepare('SELECT cover_image_url FROM signal_post_variants WHERE post_id=?').get(post.id),
    ).toEqual({ cover_image_url: null });

    // Idempotent, and — the point — a role removed afterwards is not resurrected by the next boot.
    expect(backfillSignalVariantRoleMedia(db)).toBe(0);
    db.prepare('DELETE FROM signal_post_variant_media WHERE post_id=?').run(post.id);
    expect(backfillSignalVariantRoleMedia(db)).toBe(0);
    expect(roleRows(post.id)).toEqual([]);
  });

  it('moves both roles on one layer and ignores a blank column', () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    db.prepare(
      `INSERT INTO signal_post_variants(post_id,platform,account_id,cover_image_url,thumbnail_url,updated_at)
       VALUES(?,?,?,?,?,?)`,
    ).run(
      post.id,
      'youtube',
      907,
      'https://cdn.example.com/c.png',
      'https://cdn.example.com/t.png',
      't',
    );
    db.prepare(
      `INSERT INTO signal_post_variants(post_id,platform,account_id,cover_image_url,thumbnail_url,updated_at)
       VALUES(?,?,NULL,?,?,?)`,
    ).run(post.id, 'instagram', '   ', null, 't');

    expect(backfillSignalVariantRoleMedia(db)).toBe(2);
    expect(roleRows(post.id).map((row) => [row.platform, row.account_id, row.role])).toEqual([
      ['youtube', 907, 'COVER_IMAGE'],
      ['youtube', 907, 'THUMBNAIL'],
    ]);
  });

  it('refuses a half-described Drive role and a URL role wearing Drive fields', () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    const insert = (columns: string, values: string) =>
      db.prepare(
        `INSERT INTO signal_post_variant_media(post_id,platform,role,url,updated_at,${columns})
         VALUES(?,?,?,?,'t',${values})`,
      );
    expect(() =>
      insert('source,drive_file_id', "'DRIVE',?").run(
        post.id,
        'instagram',
        'COVER_IMAGE',
        'u',
        'f',
      ),
    ).toThrow(/at least one version signal/);
    expect(() =>
      insert('source,drive_file_id', "'URL',?").run(post.id, 'instagram', 'COVER_IMAGE', 'u', 'f'),
    ).toThrow(/carries no Drive fields/);
    // One row per role per layer, over the coalesced key: a platform layer written twice is refused.
    insert('source', "'URL'").run(post.id, 'instagram', 'COVER_IMAGE', 'u');
    expect(() => insert('source', "'URL'").run(post.id, 'instagram', 'COVER_IMAGE', 'u2')).toThrow(
      /UNIQUE/,
    );
    // And a role the schema does not know is refused outright rather than stored and skipped later.
    expect(() => insert('source', "'URL'").run(post.id, 'instagram', 'BANNER', 'u')).toThrow(
      /CHECK/,
    );
  });

  it('goes when the post does', () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    db.prepare(
      `INSERT INTO signal_post_variant_media(post_id,platform,role,url,source,updated_at)
       VALUES(?,'instagram','COVER_IMAGE','u','URL','t')`,
    ).run(post.id);
    db.prepare('DELETE FROM signal_posts WHERE id=?').run(post.id);
    expect(roleRows(post.id)).toEqual([]);
  });
});

describe('writing a role', () => {
  it('stores a public URL role and a Drive role side by side, and reads both back', async () => {
    const post = seedSignalPost(db, { channels: ['ig', 'yt'] });
    const stored = await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
      {
        platform: 'youtube',
        accountId: null,
        title: 'The talk',
        thumbnail: { source: 'URL', url: 'https://cdn.example.com/thumb.png' },
      },
    ]);
    expect(stored.find((layer) => layer.platform === 'instagram')?.coverImage).toMatchObject({
      source: 'DRIVE',
      driveFileId: FILE_ID,
      driveName: 'cover.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      driveVersion: '7',
    });
    expect(stored.find((layer) => layer.platform === 'youtube')?.thumbnail).toMatchObject({
      source: 'URL',
      url: 'https://cdn.example.com/thumb.png',
      driveFileId: null,
    });
    // The Instagram layer overrides nothing but a role, so it has no text row and is composed from
    // the role table alone — and it still arrives as a layer.
    expect(
      db.prepare('SELECT platform FROM signal_post_variants WHERE post_id=?').all(post.id),
    ).toEqual([{ platform: 'youtube' }]);
    expect(
      getPostVariants(db, post.id)
        .map((layer) => layer.platform)
        .sort(),
    ).toEqual(['instagram', 'youtube']);
  });

  it('carries an existing Drive role forward and resolves only a new one', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    const layer = { platform: 'instagram', accountId: null };
    await save(post.id, [{ ...layer, coverImage: { source: 'DRIVE', url: link(FILE_ID) } }]);
    const firstCalls = drive.calls.length;
    expect(firstCalls).toBe(1);

    // The same file again, alongside an unrelated edit: nothing is looked up, so a file replaced
    // under the same id cannot be adopted by an edit that was about the caption.
    await save(post.id, [
      { ...layer, caption: 'Tailored', coverImage: { source: 'DRIVE', url: link(FILE_ID) } },
    ]);
    expect(drive.calls.length).toBe(firstCalls);

    // A different file is a new reference and is resolved.
    await save(post.id, [{ ...layer, coverImage: { source: 'DRIVE', url: link(OTHER_ID) } }]);
    expect(drive.calls.length).toBe(firstCalls + 1);
    expect(getPostVariants(db, post.id)[0]?.coverImage).toMatchObject({ driveFileId: OTHER_ID });
  });

  it('moves the post updated_at exactly when a role changes', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    const layer = { platform: 'instagram', accountId: null };

    const before = rewind(post.id);
    await save(post.id, [{ ...layer, coverImage: { source: 'DRIVE', url: link(FILE_ID) } }]);
    expect(postStamp(post.id)).not.toBe(before);

    // A text-only edit leaves it alone: the plan hash already covers the configurations text
    // overrides become, and bumping for one would stale every open confirmation twice over.
    const unchanged = rewind(post.id);
    await save(post.id, [
      { ...layer, caption: 'Tailored', coverImage: { source: 'DRIVE', url: link(FILE_ID) } },
    ]);
    expect(postStamp(post.id)).toBe(unchanged);

    // Removing the role is a change like adding one.
    rewind(post.id);
    await save(post.id, [{ ...layer, caption: 'Tailored' }]);
    expect(postStamp(post.id)).not.toBe(unchanged);
  });

  it('refuses a role the provider names no field for, and one the provider would reject', async () => {
    const post = seedSignalPost(db, { channels: ['x', 'ig'] });
    await expect(
      save(post.id, [
        {
          platform: 'twitter',
          accountId: null,
          coverImage: { source: 'URL', url: 'https://cdn.example.com/c.png' },
        },
      ]),
    ).rejects.toThrow(SignalVariantError);
    await expect(
      save(post.id, [
        {
          platform: 'instagram',
          accountId: null,
          coverImage: { source: 'URL', url: 'https://cdn.example.com/clip.mp4' },
        },
      ]),
    ).rejects.toThrow(/cover image has to be an image/);
    // A Drive file the role cannot be: Drive's own type is what classifies it, and a video is not a
    // cover. Refused before it is stored, and nothing lands.
    drive.seed('3video000000000000000000000000000', {
      name: 'clip.mp4',
      mimeType: 'video/mp4',
      size: '4096',
    });
    await expect(
      save(post.id, [
        {
          platform: 'instagram',
          accountId: null,
          coverImage: { source: 'DRIVE', url: link('3video000000000000000000000000000') },
        },
      ]),
    ).rejects.toThrow(/cover image has to be an image/);
    expect(roleRows(post.id)).toEqual([]);
  });

  it('refuses a Drive link that is not a Drive file link at all', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    await expect(
      save(post.id, [
        {
          platform: 'instagram',
          accountId: null,
          coverImage: {
            source: 'DRIVE',
            url: 'https://drive.google.com.evil.example/file/d/x/view',
          },
        },
      ]),
    ).rejects.toThrow(/is not Google Drive/);
  });

  it('answers the routes and refuses a bad role with a 400', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    await request(app())
      .put(`/api/signal/posts/${post.id}/variants`)
      .send({
        variants: [
          {
            platform: 'instagram',
            accountId: null,
            coverImage: { source: 'DRIVE', url: link(FILE_ID) },
          },
        ],
      })
      .expect(200)
      .expect((response) =>
        expect(response.body[0].coverImage).toMatchObject({ driveName: 'cover.png' }),
      );
    await request(app())
      .put(`/api/signal/posts/${post.id}/variants`)
      .send({
        variants: [
          {
            platform: 'instagram',
            accountId: null,
            coverImage: { source: 'URL', url: 'not-a-url' },
          },
        ],
      })
      .expect(400);
  });
});

describe('rechecking a role', () => {
  it('replaces the fingerprint, moves updated_at, and leaves other layers alone', async () => {
    const post = seedSignalPost(db, { channels: ['ig', 'yt'] });
    await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
      { platform: 'youtube', accountId: null, title: 'Unchanged' },
    ]);
    const before = rewind(post.id);

    // Drive replaced the bytes under the same id, which is the case the fingerprint exists for.
    drive.seed(FILE_ID, {
      name: 'cover.png',
      mimeType: 'image/png',
      size: '3072',
      version: '9',
    });
    const stored = await recheckVariantMedia(
      db,
      post.id,
      { platform: 'instagram', accountId: null, role: 'COVER_IMAGE' },
      drive,
    );
    expect(stored.find((layer) => layer.platform === 'instagram')?.coverImage).toMatchObject({
      sizeBytes: 3072,
      driveVersion: '9',
    });
    expect(stored.find((layer) => layer.platform === 'youtube')?.title).toBe('Unchanged');
    expect(postStamp(post.id)).not.toBe(before);
  });

  it('leaves updated_at alone when the file has not moved', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
    ]);
    const before = rewind(post.id);
    await recheckVariantMedia(
      db,
      post.id,
      { platform: 'instagram', accountId: null, role: 'COVER_IMAGE' },
      drive,
    );
    expect(postStamp(post.id)).toBe(before);
  });

  it('writes nothing when Drive refuses, and refuses a role that is not stored', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
    ]);
    drive.error = 'Drive is unreachable';
    await expect(
      recheckVariantMedia(
        db,
        post.id,
        { platform: 'instagram', accountId: null, role: 'COVER_IMAGE' },
        drive,
      ),
    ).rejects.toThrow(/Drive is unreachable/);
    // The last metadata Drive gave is still there, beside the reason.
    expect(getPostVariants(db, post.id)[0]?.coverImage).toMatchObject({ sizeBytes: 2048 });
    drive.error = undefined;
    await expect(
      recheckVariantMedia(
        db,
        post.id,
        { platform: 'youtube', accountId: null, role: 'THUMBNAIL' },
        drive,
      ),
    ).rejects.toThrow(SignalMediaError);
  });

  it('answers the route and 404s an unknown post', async () => {
    const post = seedSignalPost(db, { channels: ['ig'] });
    await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
    ]);
    await request(app())
      .post(`/api/signal/posts/${post.id}/variants/media/recheck`)
      .send({ platform: 'instagram', accountId: null, role: 'COVER_IMAGE' })
      .expect(200);
    await request(app())
      .post('/api/signal/posts/missing/variants/media/recheck')
      .send({ platform: 'instagram', accountId: null, role: 'COVER_IMAGE' })
      .expect(404);
  });
});

describe('what a plan says about a role', () => {
  const plan = (postId: string) =>
    buildPublishPlan(
      getPost(db, postId) as SignalPost,
      targets,
      'America/New_York',
      new Date('2026-01-01'),
      getPostVariants(db, postId),
    );

  it('warns that a stored role is not sent, and never contacts Drive to say so', async () => {
    const post = seedSignalPost(db, {
      channels: ['ig'],
      date: '2026-06-01',
      format: 'REEL',
      mediaUrls: ['https://cdn.example.com/clip.mp4'],
    });
    await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
    ]);
    const calls = drive.calls.length;
    const preview = plan(post.id);
    const report = preview.channels.find((channel) => channel.channel === 'ig');
    expect(report?.warnings).toContainEqual(
      expect.stringMatching(/names a cover image field for Instagram, but the live probe/),
    );
    // The absence warning is not also emitted: one fact, one sentence.
    expect(report?.warnings.join(' ')).not.toMatch(/chooses its own cover image/);
    expect(drive.calls.length).toBe(calls);
  });

  it('warns that the platform picks its own where no role is set', async () => {
    const post = seedSignalPost(db, {
      channels: ['ig'],
      date: '2026-06-01',
      format: 'REEL',
      mediaUrls: ['https://cdn.example.com/clip.mp4'],
    });
    const report = plan(post.id).channels.find((channel) => channel.channel === 'ig');
    expect(report?.warnings).toContain(
      'Instagram chooses its own cover image; this provider sends none.',
    );
  });

  it('refuses the confirmation once a role has moved', async () => {
    const post = seedSignalPost(db, {
      channels: ['ig'],
      date: '2026-06-01',
      format: 'REEL',
      mediaUrls: ['https://cdn.example.com/clip.mp4'],
    });
    const withoutRole = plan(post.id).planHash;
    await save(post.id, [
      {
        platform: 'instagram',
        accountId: null,
        coverImage: { source: 'DRIVE', url: link(FILE_ID) },
      },
    ]);
    const withRole = plan(post.id).planHash;
    expect(withRole).not.toBe(withoutRole);

    // A file replaced under the same id: the viewer link is identical and the fingerprint is not.
    drive.seed(FILE_ID, { name: 'cover.png', mimeType: 'image/png', size: '3072', version: '9' });
    await recheckVariantMedia(
      db,
      post.id,
      { platform: 'instagram', accountId: null, role: 'COVER_IMAGE' },
      drive,
    );
    expect(plan(post.id).planHash).not.toBe(withRole);
  });
});
