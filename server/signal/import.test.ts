import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { createPost, getPost, signalPostInput } from './service.ts';
import { commitSignalImport, previewSignalImport } from './import.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const workbook = (text = 'Imported copy', identity = '') => `[SignalPosts]
post_key	text	channels	date	time	format	status	campaigns	cta	post_import_source	post_import_id
POST-1	${text}	ig		09:00	TEXT	DRAFT	NONE	NONE	${identity ? '7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7' : ''}	${identity}

[SignalMedia]
post_key	media_order	source	url
POST-1	1	URL	https://example.com/image.jpg
`;

describe('Signal import core', () => {
  it('previews without writing and commits public media without a provider call', async () => {
    const preview = await previewSignalImport(db, { text: workbook() });
    expect(preview.ok).toBe(true);
    expect(preview.creates.SignalPosts).toBe(1);
    const result = await commitSignalImport(
      db,
      { text: workbook(), fingerprint: preview.fingerprint },
      {
        connected: false,
        readFile: async () => {
          throw new Error('provider must not be called');
        },
      } as never,
    );
    expect(result.receipt.outcome).toBe('COMMITTED');
    expect(
      getPost(db, result.receipt.created[0] ? result.receipt.created[0].key : ''),
    ).toBeUndefined();
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
    const preview = await previewSignalImport(db, { text: workbook('New copy', 'POST-1') });
    expect(preview.updates.SignalPosts).toBe(1);
    await commitSignalImport(db, {
      text: workbook('New copy', 'POST-1'),
      fingerprint: preview.fingerprint,
    });
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM signal_posts').get() as { count: number }).count,
    ).toBe(1);
    expect(getPost(db, existing.id)?.text).toBe('New copy');
  });
});
