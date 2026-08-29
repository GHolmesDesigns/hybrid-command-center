import { z } from 'zod';
import type { Db } from '../db.ts';

export const revisionPrecondition = z.number().int().positive('revision is required.');

export type MutableEntityType = 'client' | 'project' | 'task' | 'signal_post';

const TABLES: Record<MutableEntityType, string> = {
  client: 'clients',
  project: 'projects',
  task: 'tasks',
  signal_post: 'signal_posts',
};

export class RevisionConflictError extends Error {
  readonly status = 409;
  readonly code = 'conflict';
  readonly currentRevision: number;
  readonly changedFields: string[];
  constructor(currentRevision: number, changedFields: string[]) {
    super('This record changed after it was read. Read it again and re-plan the write.');
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
    this.changedFields = changedFields;
  }
}

function currentRevision(db: Db, type: MutableEntityType, entityId: string): number | undefined {
  const row = db.prepare(`SELECT revision FROM ${TABLES[type]} WHERE id=?`).get(entityId) as
    { revision: number } | undefined;
  return row?.revision;
}

function changedFieldsSince(
  db: Db,
  type: MutableEntityType,
  entityId: string,
  expectedRevision: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT changed_fields FROM entity_revision_changes
       WHERE entity_type=? AND entity_id=? AND revision>?
       ORDER BY revision`,
    )
    .all(type, entityId, expectedRevision) as { changed_fields: string }[];
  return [
    ...new Set(
      rows.flatMap((row) => {
        try {
          const parsed = JSON.parse(row.changed_fields);
          return Array.isArray(parsed)
            ? parsed.filter((field): field is string => typeof field === 'string')
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ].sort();
}

/**
 * The one optimistic-concurrency check used by HTTP/UI writes and future MCP write tools.
 * Call it inside the same SQLite transaction as the mutation and `advanceRevision`.
 */
export function requireRevision(
  db: Db,
  type: MutableEntityType,
  entityId: string,
  expectedRevision: number,
): number {
  const current = currentRevision(db, type, entityId);
  if (current === undefined) return 0;
  if (current !== expectedRevision) {
    throw new RevisionConflictError(
      current,
      changedFieldsSince(db, type, entityId, expectedRevision),
    );
  }
  return current;
}

/** Advance exactly once for one persisted logical mutation and record what changed. */
export function advanceRevision(
  db: Db,
  type: MutableEntityType,
  entityId: string,
  expectedRevision: number,
  changedFields: readonly string[],
  changedAt: string,
): number {
  const next = expectedRevision + 1;
  const result = db
    .prepare(`UPDATE ${TABLES[type]} SET revision=? WHERE id=? AND revision=?`)
    .run(next, entityId, expectedRevision);
  if (result.changes !== 1) {
    const current = currentRevision(db, type, entityId);
    if (current === undefined) return 0;
    throw new RevisionConflictError(
      current,
      changedFieldsSince(db, type, entityId, expectedRevision),
    );
  }
  db.prepare(
    `INSERT INTO entity_revision_changes(entity_type,entity_id,revision,changed_fields,changed_at)
     VALUES(?,?,?,?,?)`,
  ).run(type, entityId, next, JSON.stringify([...new Set(changedFields)].sort()), changedAt);
  return next;
}
