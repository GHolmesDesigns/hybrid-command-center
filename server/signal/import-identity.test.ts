import { afterEach, describe, expect, it } from 'vitest';
import { createDb, transaction, type Db } from '../db.ts';
import { planSignalPostIdentities } from '../domain/signal-post-identity.ts';
import { readSignalPostIdentityWorkspace, recordSignalPostImportAlias } from './import-identity.ts';

const SOURCE = '7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7';
const NAMESPACE = `signal-import:${SOURCE}`;
const STAMP = '2026-08-24T00:00:00.000Z';

const open: Db[] = [];
const database = () => {
  const db = createDb(':memory:');
  open.push(db);
  return db;
};

afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function insertPost(db: Db, id: string, text = 'Original copy', date: string | null = null) {
  db.prepare(
    `INSERT INTO signal_posts(id,text,date,time,format,status,cta,position,created_at,updated_at)
     VALUES(?,?,?,'09:00','TEXT','DRAFT','NONE',0,?,?)`,
  ).run(id, text, date, STAMP, STAMP);
}

describe('Signal post import identity storage', () => {
  it('reads posts and exact aliases into the planner snapshot', () => {
    const db = database();
    insertPost(db, 'signal-1', 'Original copy', '2026-09-14');
    recordSignalPostImportAlias(
      db,
      { namespace: NAMESPACE, externalId: 'Post-A' },
      'signal-1',
      STAMP,
    );

    const plan = planSignalPostIdentities(
      [
        {
          row: 2,
          postKey: 'POST-A',
          text: 'Edited at the source',
          date: '2026-09-21',
          postImportSource: SOURCE,
          postImportId: 'Post-A',
        },
      ],
      readSignalPostIdentityWorkspace(db),
    );

    expect(plan.issues).toEqual([]);
    expect(plan.matches.get('POST-A')).toEqual({ kind: 'identity', postId: 'signal-1' });
  });

  it('rolls a new alias back with the transaction that tried to import it', () => {
    const db = database();
    insertPost(db, 'signal-1');

    expect(() =>
      transaction(db, () => {
        recordSignalPostImportAlias(
          db,
          { namespace: NAMESPACE, externalId: 'post-A' },
          'signal-1',
          STAMP,
        );
        throw new Error('later import write failed');
      }),
    ).toThrow('later import write failed');
    expect(db.prepare('SELECT COUNT(*) total FROM signal_post_import_aliases').get()).toEqual({
      total: 0,
    });
  });

  it('never retargets an established identity and preserves opaque id case', () => {
    const db = database();
    insertPost(db, 'signal-1');
    insertPost(db, 'signal-2');
    recordSignalPostImportAlias(
      db,
      { namespace: NAMESPACE, externalId: 'Post-A' },
      'signal-1',
      STAMP,
    );
    recordSignalPostImportAlias(
      db,
      { namespace: NAMESPACE, externalId: 'post-a' },
      'signal-2',
      STAMP,
    );

    expect(() =>
      recordSignalPostImportAlias(
        db,
        { namespace: NAMESPACE, externalId: 'Post-A' },
        'signal-2',
        STAMP,
      ),
    ).toThrow(/UNIQUE/i);
    expect(readSignalPostIdentityWorkspace(db).aliases).toEqual([
      { namespace: NAMESPACE, externalId: 'Post-A', postId: 'signal-1' },
      { namespace: NAMESPACE, externalId: 'post-a', postId: 'signal-2' },
    ]);
  });

  it('deletes aliases with their post and leaves no orphan', () => {
    const db = database();
    insertPost(db, 'signal-1');
    recordSignalPostImportAlias(
      db,
      { namespace: NAMESPACE, externalId: 'post-A' },
      'signal-1',
      STAMP,
    );

    db.prepare('DELETE FROM signal_posts WHERE id=?').run('signal-1');

    expect(readSignalPostIdentityWorkspace(db)).toEqual({ posts: [], aliases: [] });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
