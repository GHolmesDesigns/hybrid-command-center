import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { createDb, type Db } from '../db.ts';
import { MockDriveMediaProvider } from '../drive/mock-provider.ts';
import { createPost, getPost, signalPostInput } from './service.ts';
import { commitSignalImport, listSignalImportReceipts, previewSignalImport } from './import.ts';
import { emptySignalImportCounts } from '../../shared/signal-import.ts';

let db: Db;
let drive: MockDriveMediaProvider;

beforeEach(() => {
  db = createDb(':memory:');
  drive = new MockDriveMediaProvider();
});

const FILE_A = 'driveFileAAAA';
const FILE_B = 'driveFileBBBB';
const link = (id: string) => `https://drive.google.com/file/d/${id}/view`;

const workbook = (opts?: {
  text?: string;
  identity?: string;
  media?: string;
  secondPost?: boolean;
}) => {
  const text = opts?.text ?? 'Imported copy';
  const identity = opts?.identity ?? '';
  const media =
    opts?.media ??
    `POST-1	1	URL	https://example.com/image.jpg
`;
  const second = opts?.secondPost
    ? `POST-2	Second post	ig		09:00	TEXT	DRAFT	NONE	NONE		
`
    : '';
  const secondMedia = opts?.secondPost
    ? `POST-2	1	URL	https://example.com/two.jpg
`
    : '';
  return `[SignalPosts]
post_key	text	channels	date	time	format	status	campaigns	cta	post_import_source	post_import_id
POST-1	${text}	ig		09:00	TEXT	DRAFT	NONE	NONE	${identity ? '7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7' : ''}	${identity}
${second}
[SignalMedia]
post_key	media_order	source	url
${media}${secondMedia}`;
};

describe('Signal import core', () => {
  it('previews without writing and commits public media without a provider call', async () => {
    const preview = await previewSignalImport(db, { text: workbook() }, drive);
    expect(preview.ok).toBe(true);
    expect(preview.creates.SignalPosts).toBe(1);
    expect(drive.calls).toEqual([]);
    const result = await commitSignalImport(
      db,
      { text: workbook(), fingerprint: preview.fingerprint },
      drive,
    );
    expect(result.receipt.outcome).toBe('COMMITTED');
    expect(drive.calls).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS count FROM signal_posts').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT position FROM signal_posts').get()).toEqual({ position: 0 });
  });

  it('updates an identity match and appends a new queue position', async () => {
    const existing = await createPost(
      db,
      signalPostInput.parse({
        text: 'Old copy',
        date: null,
        status: 'DRAFT',
      }),
    );
    db.prepare('INSERT INTO signal_post_import_aliases VALUES(?,?,?,?)').run(
      'signal-import:7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7',
      'POST-1',
      existing.id,
      new Date().toISOString(),
    );
    const preview = await previewSignalImport(
      db,
      { text: workbook({ text: 'New copy', identity: 'POST-1' }) },
      drive,
    );
    expect(preview.updates.SignalPosts).toBe(1);
    await commitSignalImport(
      db,
      {
        text: workbook({ text: 'New copy', identity: 'POST-1' }),
        fingerprint: preview.fingerprint,
      },
      drive,
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM signal_posts').get() as { count: number }).count,
    ).toBe(1);
    expect(getPost(db, existing.id)?.text).toBe('New copy');
  });
});

describe('Signal import Drive media (C91)', () => {
  it('resolves Drive links in preview with name, type, size, and resolution time', async () => {
    drive.seed(FILE_A, {
      name: 'launch.mp4',
      mimeType: 'video/mp4',
      size: '4096',
      version: '3',
    });
    const text = workbook({
      media: `POST-1	1	DRIVE	${link(FILE_A)}
`,
    });
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(true);
    expect(preview.driveNamed).toBe(1);
    expect(preview.driveResolved).toBe(1);
    expect(preview.resolvedMedia).toHaveLength(1);
    const row = preview.resolvedMedia[0]!;
    expect(row).toMatchObject({
      source: 'DRIVE',
      resolved: true,
      driveName: 'launch.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      postKey: 'POST-1',
      order: 1,
    });
    expect(row.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(drive.calls).toEqual([FILE_A]);
  });

  it('preserves workbook media_order and replaces media on confirm', async () => {
    drive.seed(FILE_A, { name: 'a.png', mimeType: 'image/png', size: '100' });
    drive.seed(FILE_B, { name: 'b.png', mimeType: 'image/png', size: '200' });
    const text = workbook({
      media: `POST-1	2	DRIVE	${link(FILE_B)}
POST-1	1	DRIVE	${link(FILE_A)}
`,
    });
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.resolvedMedia.map((m) => m.order)).toEqual([1, 2]);
    expect(preview.resolvedMedia.map((m) => m.driveName)).toEqual(['a.png', 'b.png']);
    const result = await commitSignalImport(db, { text, fingerprint: preview.fingerprint }, drive);
    expect(result.receipt.outcome).toBe('COMMITTED');
    const postId = (db.prepare('SELECT id FROM signal_posts').get() as { id: string }).id;
    const rows = db
      .prepare(
        'SELECT position, drive_name, drive_version FROM signal_post_media WHERE post_id=? ORDER BY position',
      )
      .all(postId) as { position: number; drive_name: string; drive_version: string }[];
    expect(rows).toEqual([
      { position: 0, drive_name: 'a.png', drive_version: '7' },
      { position: 1, drive_name: 'b.png', drive_version: '7' },
    ]);
  });

  it('refuses a URL row on a Drive host without contacting Drive', async () => {
    const text = workbook({
      media: `POST-1	1	URL	${link(FILE_A)}
`,
    });
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(false);
    expect(drive.calls).toEqual([]);
    expect(preview.issues[0]?.message).toMatch(/not public media/i);
  });

  it('refuses a mistyped Drive link without contacting Drive', async () => {
    const text = workbook({
      media: `POST-1	1	DRIVE	https://example.com/not-drive
`,
    });
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(false);
    expect(drive.calls).toEqual([]);
    expect(preview.issues[0]?.message).toMatch(/Drive/i);
  });

  it('errors one unresolvable Drive row and still plans the rest of the workbook', async () => {
    drive.seed(FILE_B, { name: 'ok.png', mimeType: 'image/png', size: '512' });
    const text = workbook({
      secondPost: true,
      media: `POST-1	1	DRIVE	${link(FILE_A)}
`,
    });
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(false);
    expect(preview.driveNamed).toBe(1);
    expect(preview.driveResolved).toBe(0);
    expect(preview.creates.SignalPosts).toBe(2);
    expect(
      preview.issues.some(
        (i) => i.message.includes('File not found') || i.message.includes('Drive'),
      ),
    ).toBe(true);
    expect(preview.resolvedMedia.find((m) => m.postKey === 'POST-2')?.resolved).toBe(true);
    expect(drive.calls).toEqual([FILE_A]);
  });

  it('writes the preview fingerprint and refuses when Drive replaced the file in between', async () => {
    drive.seed(FILE_A, {
      name: 'launch.mp4',
      mimeType: 'video/mp4',
      size: '4096',
      version: '3',
      modifiedTime: '2026-03-01T12:00:00.000Z',
    });
    const text = workbook({
      media: `POST-1	1	DRIVE	${link(FILE_A)}
`,
    });
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(true);
    const callsAfterPreview = drive.calls.length;

    drive.seed(FILE_A, {
      name: 'launch.mp4',
      mimeType: 'video/mp4',
      size: '8192',
      version: '4',
      modifiedTime: '2026-03-02T12:00:00.000Z',
    });
    const refused = await commitSignalImport(db, { text, fingerprint: preview.fingerprint }, drive);
    expect(refused.receipt.outcome).toBe('REJECTED');
    expect(refused.preview.issues[0]?.message).toMatch(/changed after the import preview/i);
    expect(drive.calls.length).toBeGreaterThan(callsAfterPreview);
    expect(db.prepare('SELECT COUNT(*) AS count FROM signal_posts').get()).toEqual({ count: 0 });

    drive.seed(FILE_A, {
      name: 'launch.mp4',
      mimeType: 'video/mp4',
      size: '4096',
      version: '3',
      modifiedTime: '2026-03-01T12:00:00.000Z',
    });
    const again = await previewSignalImport(db, { text }, drive);
    const committed = await commitSignalImport(db, { text, fingerprint: again.fingerprint }, drive);
    expect(committed.receipt.outcome).toBe('COMMITTED');
    const stored = db
      .prepare('SELECT drive_version, size_bytes, drive_name FROM signal_post_media')
      .get() as { drive_version: string; size_bytes: number; drive_name: string };
    expect(stored).toEqual({
      drive_version: '3',
      size_bytes: 4096,
      drive_name: 'launch.mp4',
    });
  });

  it('refuses an unsupported MIME after contacting Drive, and names Drive disconnection', async () => {
    drive.seed(FILE_A, {
      name: 'notes.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: '1024',
    });
    const badMime = await previewSignalImport(
      db,
      {
        text: workbook({
          media: `POST-1	1	DRIVE	${link(FILE_A)}
`,
        }),
      },
      drive,
    );
    expect(badMime.ok).toBe(false);
    expect(drive.calls).toEqual([FILE_A]);
    expect(badMime.issues[0]?.message).toMatch(/publisher accepts/i);

    drive.calls = [];
    drive.connected = false;
    drive.seed(FILE_B, { name: 'ok.png', mimeType: 'image/png', size: '100' });
    const disconnected = await previewSignalImport(
      db,
      {
        text: workbook({
          media: `POST-1	1	DRIVE	${link(FILE_B)}
`,
        }),
      },
      drive,
    );
    expect(disconnected.ok).toBe(false);
    expect(disconnected.issues[0]?.message).toMatch(/not connected/i);
    expect(drive.calls).toEqual([]);
  });

  it('refuses a confirm whose preview expired or whose workbook bytes moved', async () => {
    drive.seed(FILE_A, { name: 'a.png', mimeType: 'image/png', size: '100' });
    const text = workbook({
      text: `Orphan preview copy ${Date.now()}`,
      media: `POST-1	1	DRIVE	${link(FILE_A)}
`,
    });
    const orphanFingerprint = crypto
      .createHash('sha256')
      .update(text.replace(/\r\n?/g, '\n'))
      .digest('hex');
    await expect(
      commitSignalImport(db, { text, fingerprint: orphanFingerprint }, drive),
    ).rejects.toThrow(/preview expired/i);

    const preview = await previewSignalImport(db, { text }, drive);
    await expect(
      commitSignalImport(
        db,
        { text: workbook({ text: 'Different copy' }), fingerprint: preview.fingerprint },
        drive,
      ),
    ).rejects.toThrow(/changed since it was previewed/i);
  });

  it('imports a variant layer and lists the receipt afterwards', async () => {
    const text = `${workbook()}
[SignalVariants]
post_key	platform	caption	cover_image
POST-1	instagram	IG caption	https://example.com/cover.jpg
`;
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(true);
    expect(preview.creates.SignalVariants).toBe(1);
    const result = await commitSignalImport(db, { text, fingerprint: preview.fingerprint }, drive);
    expect(result.receipt.outcome).toBe('COMMITTED');
    const receipts = listSignalImportReceipts(db);
    expect(receipts[0]?.id).toBe(result.receipt.id);
    expect(receipts[0]?.outcome).toBe('COMMITTED');
    const postId = (db.prepare('SELECT id FROM signal_posts').get() as { id: string }).id;
    expect(
      (
        db
          .prepare(
            'SELECT caption FROM signal_post_variants WHERE post_id=? AND platform=? AND account_id IS NULL',
          )
          .get(postId, 'instagram') as { caption: string }
      ).caption,
    ).toBe('IG caption');
  });

  it('reports unknown tabs, duplicate media orders, and missing post keys as row issues', async () => {
    const text = `[ExtraTab]
a	b
1	2

[SignalPosts]
post_key	text
POST-1	One post

[SignalMedia]
post_key	media_order	source	url
POST-1	1	URL	https://example.com/a.jpg
POST-1	1	URL	https://example.com/b.jpg
MISSING	1	URL	https://example.com/c.jpg
`;
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(false);
    expect(preview.issues.some((i) => i.sheet === 'ExtraTab')).toBe(true);
    expect(preview.issues.some((i) => /media_order 1 is already used/i.test(i.message))).toBe(true);
    expect(preview.issues.some((i) => /post_key MISSING is not defined/i.test(i.message))).toBe(
      true,
    );
  });

  it('refuses an oversized Drive file, a bad schema version, and an invalid media source', async () => {
    drive.seed(FILE_A, {
      name: 'huge.mp4',
      mimeType: 'video/mp4',
      size: String(600 * 1024 * 1024),
    });
    const oversized = await previewSignalImport(
      db,
      {
        text: workbook({
          media: `POST-1	1	DRIVE	${link(FILE_A)}
`,
        }),
      },
      drive,
    );
    expect(oversized.ok).toBe(false);
    expect(oversized.issues[0]?.message).toMatch(/up to/i);

    const schema = `[README]
schema_version	99

[SignalPosts]
post_key	text
POST-1	Copy

[SignalMedia]
post_key	media_order	source	url
POST-1	1	URL	https://example.com/a.jpg
`;
    const badSchema = await previewSignalImport(db, { text: schema }, drive);
    expect(badSchema.ok).toBe(false);
    expect(badSchema.issues.some((i) => /schema version 99/i.test(i.message))).toBe(true);

    const badSource = workbook({
      media: `POST-1	1	FTP	https://example.com/a.jpg
`,
    });
    const refused = await previewSignalImport(db, { text: badSource }, drive);
    expect(refused.ok).toBe(false);
    expect(refused.issues.some((i) => /URL or DRIVE/i.test(i.message))).toBe(true);
  });

  it('resolves a variant Drive cover in the dry run and refuses confirm when a SignalMedia recheck fails', async () => {
    drive.seed(FILE_A, { name: 'cover.png', mimeType: 'image/png', size: '512' });
    drive.seed(FILE_B, { name: 'main.png', mimeType: 'image/png', size: '256' });
    const text = `[SignalPosts]
post_key	text	channels	date	time	format	status	campaigns	cta
POST-1	Imported copy	ig		09:00	TEXT	DRAFT	NONE	NONE

[SignalMedia]
post_key	media_order	source	url
POST-1	1	DRIVE	${link(FILE_B)}

[SignalVariants]
post_key	platform	cover_image
POST-1	instagram	${link(FILE_A)}
`;
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(true);
    expect(preview.driveResolved).toBe(1);
    expect(drive.calls).toEqual(expect.arrayContaining([FILE_A, FILE_B]));
    drive.error = 'Drive went away';
    const refused = await commitSignalImport(db, { text, fingerprint: preview.fingerprint }, drive);
    expect(refused.receipt.outcome).toBe('REJECTED');
    expect(
      refused.preview.issues.some((i) => /Drive went away|Drive could not return/i.test(i.message)),
    ).toBe(true);
  });

  it('reads a receipt whose detail JSON is unreadable', async () => {
    const text = workbook();
    const preview = await previewSignalImport(db, { text }, drive);
    const result = await commitSignalImport(db, { text, fingerprint: preview.fingerprint }, drive);
    db.prepare('UPDATE import_receipts SET detail=? WHERE id=?').run(
      '{not-json',
      result.receipt.id,
    );
    const listed = listSignalImportReceipts(db);
    expect(listed[0]?.id).toBe(result.receipt.id);
    expect(listed[0]?.creates).toEqual(emptySignalImportCounts());
  });

  it('refuses more than 20 media items and an invalid variant platform', async () => {
    const media = Array.from(
      { length: 21 },
      (_, i) => `POST-1	${i + 1}	URL	https://example.com/${i}.jpg`,
    ).join('\n');
    const tooMany = await previewSignalImport(
      db,
      { text: workbook({ media: `${media}\n` }) },
      drive,
    );
    expect(tooMany.ok).toBe(false);
    expect(tooMany.issues.some((i) => /at most 20 media/i.test(i.message))).toBe(true);

    const badVariant = `${workbook()}
[SignalVariants]
post_key	platform
POST-1	myspace
`;
    const refused = await previewSignalImport(db, { text: badVariant }, drive);
    expect(refused.ok).toBe(false);
    expect(refused.issues.some((i) => /platform or account_id/i.test(i.message))).toBe(true);
  });

  it('commits without a fingerprint by rebuilding the plan', async () => {
    const text = workbook({ text: `Rebuild plan ${Date.now()}` });
    const result = await commitSignalImport(db, { text }, drive);
    expect(result.receipt.outcome).toBe('COMMITTED');
    expect(result.receipt.createdCount).toBeGreaterThan(0);
  });

  it('records a filename, refuses a duplicate variant layer, and accepts campaign lists', async () => {
    const text = workbook({ text: `Named file ${Date.now()}` }).replace(
      'NONE	NONE',
      'Clarity|Week 1	SOFT',
    );
    const preview = await previewSignalImport(db, { text, filename: 'queue.txt' }, drive);
    expect(preview.ok).toBe(true);
    const result = await commitSignalImport(
      db,
      { text, filename: 'queue.txt', fingerprint: preview.fingerprint },
      drive,
    );
    expect(result.receipt.filename).toBe('queue.txt');
    const postId = (
      db.prepare('SELECT id FROM signal_posts ORDER BY created_at DESC').get() as {
        id: string;
      }
    ).id;
    expect(
      (
        db
          .prepare('SELECT COUNT(*) AS count FROM signal_post_campaigns WHERE post_id=?')
          .get(postId) as { count: number }
      ).count,
    ).toBe(2);

    const dup = `${workbook()}
[SignalVariants]
post_key	platform
POST-1	instagram
POST-1	instagram
`;
    const refused = await previewSignalImport(db, { text: dup }, drive);
    expect(refused.ok).toBe(false);
    expect(refused.issues.some((i) => /duplicated/i.test(i.message))).toBe(true);
  });

  it('reports capability warnings without refusing, and still imports an over-limit caption', async () => {
    const caption = 'b'.repeat(301);
    const text = `[SignalPosts]
post_key	text	channels	date	time	format	status	campaigns	cta
POST-BSKY	${caption}	bsky		09:00	TEXT	DRAFT	NONE	NONE
`;
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(true);
    expect(preview.capabilitySummary.postsWithWarnings).toBe(1);
    expect(preview.capabilitySummary.postsClean).toBe(0);
    expect(
      preview.capabilityVerdicts.some(
        (v) =>
          v.durability === 'DURABLE' &&
          v.publishWouldRefuse &&
          /limits captions to 300/.test(v.message),
      ),
    ).toBe(true);
    expect(
      preview.capabilityVerdicts.some(
        (v) => v.durability === 'MOMENTARY' && /no connected account/.test(v.message),
      ),
    ).toBe(true);
    const result = await commitSignalImport(db, { text, fingerprint: preview.fingerprint }, drive);
    expect(result.receipt.outcome).toBe('COMMITTED');
    expect(result.receipt.capabilityVerdicts).toHaveLength(preview.capabilityVerdicts.length);
    expect(
      (db.prepare('SELECT text FROM signal_posts').get() as { text: string }).text.length,
    ).toBe(301);
  });

  it('still refuses the whole import on a validation error', async () => {
    const text = `[SignalPosts]
post_key	text	channels
NOT A KEY	copy	bsky
`;
    const preview = await previewSignalImport(db, { text }, drive);
    expect(preview.ok).toBe(false);
    expect(preview.issues.length).toBeGreaterThan(0);
  });
});
