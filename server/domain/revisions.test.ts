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

beforeEach(() => {
  db = createDb(':memory:');
  db.prepare(
    `INSERT INTO clients(id,name,slug,drive_status,created_at,updated_at)
     VALUES(?, 'First', 'first-11111111', 'DISCONNECTED', ?, ?)`,
  ).run(id, '2026-08-28T12:00:00.000Z', '2026-08-28T12:00:00.000Z');
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
});
