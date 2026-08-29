import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, transaction, type Db } from '../db.ts';
import {
  advanceRevision,
  requireRevision,
  revisionPrecondition,
  RevisionConflictError,
} from './revisions.ts';

let db: Db;
const id = '11111111-1111-4111-8111-111111111111';
const stamp = '2026-08-28T12:00:00.000Z';

beforeEach(() => {
  db = createDb(':memory:');
  db.prepare(
    `INSERT INTO clients(id,name,slug,drive_status,created_at,updated_at)
     VALUES(?, 'First', 'first-11111111', 'DISCONNECTED', ?, ?)`,
  ).run(id, stamp, stamp);
});

describe('workspace mutation revisions', () => {
  it('refuses a missing revision at the shared boundary', () => {
    expect(() => revisionPrecondition.parse(undefined)).toThrow();
  });

  it('allows one writer, advances once, and reports the fields to a stale second writer', () => {
    transaction(db, () => {
      requireRevision(db, 'client', id, 1);
      db.prepare('UPDATE clients SET name=? WHERE id=?').run('Second', id);
      advanceRevision(db, 'client', id, 1, ['name'], '2026-08-28T12:01:00.000Z');
    });

    expect(db.prepare('SELECT revision FROM clients WHERE id=?').get(id)).toEqual({ revision: 2 });
    expect(() => requireRevision(db, 'client', id, 1)).toThrowError(
      expect.objectContaining<Partial<RevisionConflictError>>({
        code: 'conflict',
        currentRevision: 2,
        changedFields: ['name'],
      }),
    );
  });

  it('does not change revision on reads', () => {
    expect(requireRevision(db, 'client', id, 1)).toBe(1);
    db.prepare('SELECT * FROM clients WHERE id=?').get(id);
    expect(requireRevision(db, 'client', id, 1)).toBe(1);
  });

  it('ignores malformed revision change payloads and races on advance', () => {
    db.prepare(
      `INSERT INTO entity_revision_changes(entity_type,entity_id,revision,changed_fields,changed_at)
       VALUES('client',?,2,'not-json','2026-08-28T12:01:00.000Z')`,
    ).run(id);
    db.prepare(
      `INSERT INTO entity_revision_changes(entity_type,entity_id,revision,changed_fields,changed_at)
       VALUES('client',?,3,'{"no":"array"}','2026-08-28T12:02:00.000Z')`,
    ).run(id);
    db.prepare(
      `INSERT INTO entity_revision_changes(entity_type,entity_id,revision,changed_fields,changed_at)
       VALUES('client',?,4,'[1,"name",true]','2026-08-28T12:03:00.000Z')`,
    ).run(id);
    db.prepare('UPDATE clients SET revision=5 WHERE id=?').run(id);

    expect(() => requireRevision(db, 'client', id, 1)).toThrowError(
      expect.objectContaining<Partial<RevisionConflictError>>({
        currentRevision: 5,
        changedFields: ['name'],
      }),
    );

    expect(requireRevision(db, 'client', '22222222-2222-4222-8222-222222222222', 1)).toBe(0);
    expect(
      advanceRevision(db, 'client', '22222222-2222-4222-8222-222222222222', 1, ['name'], stamp),
    ).toBe(0);

    db.prepare('UPDATE clients SET revision=6 WHERE id=?').run(id);
    expect(() =>
      advanceRevision(db, 'client', id, 5, ['notes'], '2026-08-28T12:04:00.000Z'),
    ).toThrowError(
      expect.objectContaining<Partial<RevisionConflictError>>({
        currentRevision: 6,
      }),
    );
  });
});
