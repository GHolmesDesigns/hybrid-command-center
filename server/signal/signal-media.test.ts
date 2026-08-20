import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { applyAdditiveMigrations, createDb, triggerSchema, type Db } from '../db.ts';
import { MockDriveMediaProvider } from '../drive/mock-provider.ts';
import { DisconnectedDriveMediaProvider } from '../drive/media.ts';
import {
  SignalMediaError,
  createPost,
  duplicatePost,
  getPost,
  recheckPostMedia,
  signalPostInput,
  signalPostPatch,
  updatePost,
} from './service.ts';
import { buildPublishPlan } from '../publish/plan.ts';
import { signalMediaKindFor } from '../../shared/signal.ts';
import { signalPostMediaIssue, urlPostMedia } from '../../shared/signal-media.ts';
import type { PublishTarget } from '../publish/provider.ts';

/**
 * A Signal media reference that is a version-bound Drive file (C74).
 *
 * The one rule this suite keeps coming back to: **a preview makes no Drive call.** Every case that
 * previews or plans asserts the mock provider's call list afterwards, because "we do not contact
 * Drive here" is the kind of claim that stays true only while something checks it.
 */

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const OTHER_ID = '2ZyXwVuTsRqPoNmLkJiHgFeDcBa987654';
const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;

let db: Db;
let drive: MockDriveMediaProvider;
beforeEach(() => {
  db = createDb(':memory:');
  drive = new MockDriveMediaProvider();
  drive.seed(FILE_ID, { name: 'launch.mp4', mimeType: 'video/mp4', size: '4096' });
  drive.seed(OTHER_ID, { name: 'poster.png', mimeType: 'image/png', size: '2048' });
});

const app = () => createApp(db, { driveMedia: () => drive });

const post = (overrides: Record<string, unknown> = {}) =>
  signalPostInput.parse({ text: 'Clarity as competitive advantage', ...overrides });

const withDrive = (id = FILE_ID, overrides: Record<string, unknown> = {}) =>
  createPost(db, post({ media: [{ source: 'DRIVE', url: link(id) }], ...overrides }), drive);

const mediaRows = (postId: string) =>
  db
    .prepare('SELECT * FROM signal_post_media WHERE post_id=? ORDER BY position')
    .all(postId) as unknown as Record<string, unknown>[];

describe('the additive migration and the contract it carries', () => {
  /**
   * A database created before the columns existed, migrated the way a real one is: the same
   * `applyAdditiveMigrations` the boot path runs, then the triggers. Every URL row has to survive
   * it unchanged and come back out as a `URL` reference with no Drive field set.
   */
  it('preserves every URL row and gives it the URL source', () => {
    const legacy = new DatabaseSync(':memory:');
    legacy.exec(`
      CREATE TABLE signal_posts (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, date TEXT, time TEXT NOT NULL DEFAULT '09:00',
        format TEXT NOT NULL DEFAULT 'TEXT', status TEXT NOT NULL DEFAULT 'DRAFT', campaign TEXT,
        cta TEXT NOT NULL DEFAULT 'NONE', position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE signal_post_media (
        post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0), url TEXT NOT NULL,
        PRIMARY KEY(post_id, position)
      );
      INSERT INTO signal_posts(id,text,created_at,updated_at)
        VALUES('p1','Already here','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
      INSERT INTO signal_post_media(post_id,position,url)
        VALUES('p1',0,'https://cdn.example.com/one.jpg'),('p1',1,'https://cdn.example.com/two.mp4');
    `);

    const statements = applyAdditiveMigrations(
      legacy,
      `
      CREATE TABLE IF NOT EXISTS signal_posts (id TEXT PRIMARY KEY, text TEXT NOT NULL,
        date TEXT, time TEXT NOT NULL DEFAULT '09:00', format TEXT NOT NULL DEFAULT 'TEXT',
        status TEXT NOT NULL DEFAULT 'DRAFT', campaign TEXT, cta TEXT NOT NULL DEFAULT 'NONE',
        position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signal_post_media (
        post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK(position >= 0), url TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'URL' CHECK(source IN ('URL','DRIVE')),
        drive_file_id TEXT, drive_name TEXT, mime_type TEXT, size_bytes INTEGER,
        drive_version TEXT, drive_modified_at TEXT, drive_checksum TEXT, drive_verified_at TEXT,
        PRIMARY KEY(post_id, position));
    `,
    );
    legacy.exec(triggerSchema);

    expect(statements.some((sql) => sql.includes('ADD COLUMN "source"'))).toBe(true);
    expect(
      legacy
        .prepare('SELECT url, source, drive_file_id FROM signal_post_media ORDER BY position')
        .all(),
    ).toEqual([
      { url: 'https://cdn.example.com/one.jpg', source: 'URL', drive_file_id: null },
      { url: 'https://cdn.example.com/two.mp4', source: 'URL', drive_file_id: null },
    ]);

    // And the contract reaches the migrated database, which is the reason the rule is a trigger:
    // `ALTER TABLE ADD COLUMN` cannot reproduce a CHECK, so a migrated table would otherwise carry
    // no constraint whatsoever.
    expect(() =>
      legacy
        .prepare(
          "INSERT INTO signal_post_media(post_id,position,url,source) VALUES('p1',2,'x','SOMETHING')",
        )
        .run(),
    ).toThrow(/signal_post_media/);
    legacy.close();
  });

  it('refuses a half-described Drive row and a URL row wearing Drive fields', () => {
    db.prepare(
      "INSERT INTO signal_posts(id,text,created_at,updated_at) VALUES('p1','x','t','t')",
    ).run();
    const insert = (columns: string, values: string) =>
      db.prepare(
        `INSERT INTO signal_post_media(post_id,position,url,${columns}) VALUES(?,?,?,${values})`,
      );

    // A DRIVE row with an id and nothing else.
    expect(() => insert('source,drive_file_id', "'DRIVE',?").run('p1', 0, 'u', FILE_ID)).toThrow(
      /at least one version signal/,
    );
    // A URL row carrying a Drive field.
    expect(() => insert('source,drive_file_id', "'URL',?").run('p1', 1, 'u', FILE_ID)).toThrow(
      /carries no Drive fields/,
    );
    // A DRIVE row with a zero size, which is a file Drive would not report that way.
    expect(() =>
      insert(
        'source,drive_file_id,drive_name,mime_type,size_bytes,drive_version',
        "'DRIVE',?,?,?,0,'7'",
      ).run('p1', 2, 'u', FILE_ID, 'n', 'image/png'),
    ).toThrow(/positive size/);
    // And an UPDATE cannot walk a good row into a bad one either.
    insert(
      'source,drive_file_id,drive_name,mime_type,size_bytes,drive_version',
      "'DRIVE',?,?,?,2048,'7'",
    ).run('p1', 3, 'u', FILE_ID, 'n', 'image/png');
    expect(() =>
      db.prepare('UPDATE signal_post_media SET drive_name=NULL WHERE position=3').run(),
    ).toThrow(/a DRIVE reference needs/);
  });
});

describe('writing a Drive reference', () => {
  it('stores the canonical metadata and the fingerprint, and returns both shapes of the list', async () => {
    const created = await withDrive();

    expect(created.media).toEqual([
      {
        source: 'DRIVE',
        url: link(FILE_ID),
        driveFileId: FILE_ID,
        driveName: 'launch.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 4096,
        driveVersion: '7',
        driveModifiedAt: '2026-03-01T12:00:00.000Z',
        driveChecksum: 'd41d8cd98f00b204e9800998ecf8427e',
        driveVerifiedAt: expect.any(String),
      },
    ]);
    // `mediaUrls` is derived, so the vocabulary the variant selection speaks still works.
    expect(created.mediaUrls).toEqual([link(FILE_ID)]);
    expect(mediaRows(created.id)[0]).toMatchObject({ source: 'DRIVE', drive_file_id: FILE_ID });
  });

  it('keeps a request that sends only mediaUrls exactly as it was', async () => {
    const created = await createPost(
      db,
      post({ mediaUrls: ['https://cdn.example.com/one.jpg'] }),
      drive,
    );
    expect(created.media).toEqual([urlPostMedia('https://cdn.example.com/one.jpg')]);
    expect(created.mediaUrls).toEqual(['https://cdn.example.com/one.jpg']);
    expect(drive.calls).toEqual([]);
  });

  it('lets media win over mediaUrls when a request sends both', async () => {
    const created = await createPost(
      db,
      post({
        mediaUrls: ['https://cdn.example.com/ignored.jpg'],
        media: [{ source: 'URL', url: 'https://cdn.example.com/chosen.jpg' }],
      }),
      drive,
    );
    expect(created.mediaUrls).toEqual(['https://cdn.example.com/chosen.jpg']);
  });

  it('refuses the same Drive file twice on one post', async () => {
    await expect(
      createPost(
        db,
        post({
          media: [
            { source: 'DRIVE', url: link(FILE_ID) },
            { source: 'DRIVE', url: `https://drive.google.com/open?id=${FILE_ID}` },
          ],
        }),
        drive,
      ),
    ).rejects.toBeInstanceOf(SignalMediaError);
  });

  it('refuses a link that is not a Drive file link, and writes nothing', async () => {
    await expect(
      createPost(
        db,
        post({ media: [{ source: 'DRIVE', url: 'https://example.com/x.png' }] }),
        drive,
      ),
    ).rejects.toThrow(/is not Google Drive/);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_posts').get()).toEqual({ n: 0 });
  });
});

describe('a fingerprint changes only when somebody asks', () => {
  /**
   * The asymmetry the card is built on. A save re-sends the whole media list, so if every Drive
   * item were re-resolved then a file swapped under the same id would be adopted by an edit that
   * was about the caption. Carrying an existing reference forward untouched is what makes the
   * version binding mean anything.
   */
  it('carries an existing reference forward on an unrelated edit, with no Drive call', async () => {
    const created = await withDrive();
    const before = drive.calls.length;

    const edited = await updatePost(
      db,
      created.id,
      signalPostPatch.parse({ text: 'Reworded', media: [{ source: 'DRIVE', url: link(FILE_ID) }] }),
      drive,
    );

    expect(edited.text).toBe('Reworded');
    expect(edited.media).toEqual(created.media);
    expect(drive.calls).toHaveLength(before);
  });

  it('leaves media alone entirely when a patch does not name it', async () => {
    const created = await withDrive();
    const edited = await updatePost(
      db,
      created.id,
      signalPostPatch.parse({ text: 'Reworded' }),
      drive,
    );
    expect(edited.media).toEqual(created.media);
  });

  it('replaces the fingerprint on an explicit recheck, through the ordinary edit transaction', async () => {
    const created = await withDrive();
    drive.seed(FILE_ID, {
      name: 'launch-v2.mp4',
      mimeType: 'video/mp4',
      size: '8192',
      version: '9',
      md5Checksum: 'a-new-checksum',
    });

    const rechecked = await recheckPostMedia(db, created.id, FILE_ID, drive);

    expect(rechecked.media[0]).toMatchObject({
      driveName: 'launch-v2.mp4',
      sizeBytes: 8192,
      driveVersion: '9',
      driveChecksum: 'a-new-checksum',
    });
    // It went through the ordinary edit transaction rather than a path of its own, so the post's
    // own stamp was rewritten. Compared as an ordering rather than as an inequality: a create and a
    // recheck inside the same millisecond produce the same ISO string, which would make an
    // inequality fail for a reason that has nothing to do with the write.
    expect(rechecked.updatedAt >= created.updatedAt).toBe(true);
    const at = new Date('2027-01-01');
    const targets = [{ id: 904, platform: 'tiktok', name: 'G.Holmes Designs', handle: '@gholmes' }];
    // And the consequence that matters: an open preview stops matching, because the hash is over
    // the fingerprint and the fingerprint moved.
    expect(buildPublishPlan(rechecked, targets, 'America/New_York', at).planHash).not.toBe(
      buildPublishPlan(created, targets, 'America/New_York', at).planHash,
    );
  });

  it('keeps the last metadata when a recheck fails, and writes nothing at all', async () => {
    const created = await withDrive();
    drive.error = 'File not found: 404';

    await expect(recheckPostMedia(db, created.id, FILE_ID, drive)).rejects.toThrow(
      /Drive could not return that file/,
    );

    const after = getPost(db, created.id);
    expect(after?.media).toEqual(created.media);
    expect(after?.updatedAt).toBe(created.updatedAt);
  });

  it('refuses a recheck of a file the post does not carry', async () => {
    const created = await withDrive();
    await expect(recheckPostMedia(db, created.id, OTHER_ID, drive)).rejects.toBeInstanceOf(
      SignalMediaError,
    );
  });

  it('copies a duplicate’s references verbatim rather than re-resolving them', async () => {
    const created = await withDrive();
    const before = drive.calls.length;
    const copy = duplicatePost(db, created.id);
    expect(copy.media).toEqual(created.media);
    expect(drive.calls).toHaveLength(before);
  });
});

describe('what a preview reads, and what it does not', () => {
  const connected: PublishTarget[] = [
    { id: 904, platform: 'tiktok', name: 'G.Holmes Designs', handle: '@gholmes' },
  ];

  it('preflights a Drive video from the stored MIME type, with no Drive call', async () => {
    const created = await withDrive(FILE_ID, { channels: ['tt'], date: '2027-08-14' });
    const before = drive.calls.length;

    const plan = buildPublishPlan(created, connected, 'America/New_York', new Date('2027-01-01'));

    // TikTok takes exactly one video and nothing else; the plan agrees, which it could only do by
    // reading `video/mp4` off the row. Classifying the viewer link by pathname answers `unknown`.
    expect(signalMediaKindFor(created.media[0]!)).toBe('video');
    expect(plan.channels[0]?.refusals).toEqual([]);
    expect(drive.calls).toHaveLength(before);
  });

  it('plans provider ids for Drive media without handing over the viewer page', async () => {
    const created = await withDrive(FILE_ID, { channels: ['tt'], date: '2027-08-14' });
    const before = drive.calls.length;
    const plan = buildPublishPlan(created, connected, 'America/New_York', new Date('2027-01-01'));

    expect(plan.refusals).toEqual([]);
    expect(plan.request).toMatchObject({ mediaIds: [] });
    expect(plan.request).not.toHaveProperty('mediaUrls');
    expect(drive.calls).toHaveLength(before);
  });

  it('changes the plan hash when any version-fingerprint field changes', async () => {
    const created = await withDrive(FILE_ID, { channels: ['tt'], date: '2027-08-14' });
    const at = new Date('2027-01-01');
    const first = buildPublishPlan(created, connected, 'America/New_York', at).planHash;

    // Same post, same URL, same everything a pre-C74 hash covered — only the bytes moved.
    const moved = {
      ...created,
      media: [{ ...created.media[0]!, driveVersion: '9', driveChecksum: 'different' }],
    };
    expect(buildPublishPlan(moved, connected, 'America/New_York', at).planHash).not.toBe(first);

    // And the source alone is enough, because a public URL and a Drive file are different plans.
    const asUrl = { ...created, media: [urlPostMedia(created.media[0]!.url)] };
    expect(buildPublishPlan(asUrl, connected, 'America/New_York', at).planHash).not.toBe(first);
  });

  it('leaves the hash alone when only the verification time moves', async () => {
    const created = await withDrive(FILE_ID, { channels: ['tt'], date: '2027-08-14' });
    const at = new Date('2027-01-01');
    const first = buildPublishPlan(created, connected, 'America/New_York', at).planHash;
    const rechecked = {
      ...created,
      media: [{ ...created.media[0]!, driveVerifiedAt: '2030-01-01T00:00:00.000Z' }],
    };
    expect(buildPublishPlan(rechecked, connected, 'America/New_York', at).planHash).toBe(first);
  });
});

describe('the HTTP boundary', () => {
  it('resolves a pasted link to metadata, and hands the browser no way to read the file', async () => {
    const response = await request(app())
      .post('/api/signal/drive-media/resolve')
      .send({ link: link(OTHER_ID) });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      source: 'DRIVE',
      driveFileId: OTHER_ID,
      driveName: 'poster.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
    });
    // Metadata and a viewer link. No bytes, no content field, and nothing resembling a token.
    expect(Object.keys(response.body).sort()).toEqual([
      'driveChecksum',
      'driveFileId',
      'driveModifiedAt',
      'driveName',
      'driveVerifiedAt',
      'driveVersion',
      'mimeType',
      'sizeBytes',
      'source',
      'url',
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/token|access|bearer/i);
  });

  it('answers a refused link with 400 and the specific reason', async () => {
    for (const [pasted, reason] of [
      [FILE_ID, /not a link/i],
      [`https://drive.google.com/drive/folders/${FILE_ID}`, /a Drive folder/],
      [`https://docs.google.com/document/d/${FILE_ID}/edit`, /Google Docs, Sheets, or Slides/],
    ] as const) {
      const response = await request(app())
        .post('/api/signal/drive-media/resolve')
        .send({ link: pasted });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(reason);
    }
  });

  it('says Drive is not connected rather than failing obscurely', async () => {
    const response = await request(
      createApp(db, { driveMedia: () => new DisconnectedDriveMediaProvider() }),
    )
      .post('/api/signal/drive-media/resolve')
      .send({ link: link(FILE_ID) });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not connected/);
  });

  it('creates and rechecks a post through the routes, and refuses a recheck it cannot make', async () => {
    const created = await request(app())
      .post('/api/signal/posts')
      .send({ text: 'With a file', media: [{ source: 'DRIVE', url: link(FILE_ID) }] });
    expect(created.status).toBe(201);
    expect(created.body.media[0].driveFileId).toBe(FILE_ID);

    drive.seed(FILE_ID, { name: 'launch.mp4', mimeType: 'video/mp4', size: '4096', version: '11' });
    const rechecked = await request(app())
      .post(`/api/signal/posts/${created.body.id}/media/recheck`)
      .send({ driveFileId: FILE_ID });
    expect(rechecked.status).toBe(200);
    expect(rechecked.body.media[0].driveVersion).toBe('11');

    const missing = await request(app())
      .post(`/api/signal/posts/${created.body.id}/media/recheck`)
      .send({ driveFileId: OTHER_ID });
    expect(missing.status).toBe(400);
  });

  /**
   * The shape a caller could try to smuggle past the boundary. Drive metadata is never taken from a
   * request: the union accepts a source and an address, so the extra keys are simply not part of
   * the input, and the id still has to come out of a link the server parses itself.
   */
  it('takes no Drive metadata from a request body', async () => {
    const response = await request(app())
      .post('/api/signal/posts')
      .send({
        text: 'Trying it on',
        media: [
          {
            source: 'DRIVE',
            url: link(FILE_ID),
            driveName: 'something-else.png',
            mimeType: 'image/png',
            sizeBytes: 1,
            driveChecksum: 'made-up',
          },
        ],
      });
    expect(response.status).toBe(201);
    expect(response.body.media[0]).toMatchObject({
      driveName: 'launch.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      driveChecksum: 'd41d8cd98f00b204e9800998ecf8427e',
    });
  });
});

describe('the one cross-field rule', () => {
  it('is the same answer for the schema, the service, and the triggers', () => {
    expect(signalPostMediaIssue(urlPostMedia('https://cdn.example.com/a.jpg'))).toBeNull();
    expect(
      signalPostMediaIssue({ ...urlPostMedia('https://cdn.example.com/a.jpg'), driveFileId: 'x' }),
    ).toMatch(/cannot carry a Drive file id/);
    expect(
      signalPostMediaIssue({
        source: 'DRIVE',
        url: link(FILE_ID),
        driveFileId: FILE_ID,
        driveName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        driveVersion: null,
        driveModifiedAt: null,
        driveChecksum: null,
        driveVerifiedAt: null,
      }),
    ).toMatch(/at least one version signal/);
  });
});
