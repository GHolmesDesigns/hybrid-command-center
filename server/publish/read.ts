import type { Db } from '../db.ts';
import type { SignalPublication } from '../../shared/publish.ts';
import { toPublication, type PublicationRow, type TargetRow } from './rows.ts';

/**
 * The read-only half of publishing, and the only half the queue-health summary sees.
 *
 * Every function here lists. There is no counterpart in this file that submits, updates, cancels, or
 * marks anything — the same split `server/signal/read.ts` keeps from `service.ts`, for the same
 * reason: a summary that reads delivery records must not be able to reach a change to one, and the
 * way to guarantee that is for the module it imports to have no way of making one.
 */

/** One publication's target rows, in the order the plan resolved them. */
export const targetRowsFor = (db: Db, publicationId: string): TargetRow[] =>
  db
    .prepare('SELECT * FROM signal_publication_targets WHERE publication_id=? ORDER BY rowid')
    .all(publicationId) as unknown as TargetRow[];

/**
 * The delivery records the health summary is allowed to conclude about.
 *
 * Two reasons a publication is included, and they are different questions rather than one bound:
 *
 * - it was created inside the lookback window, so it is recent enough that a reader still recognises
 *   it; or
 * - it is still open — waiting on the provider, or carrying an answer that needs somebody — however
 *   old it is, because an unresolved delivery does not stop mattering on a date.
 *
 * `driftFields` is deliberately absent from what this returns: deriving it needs a fresh publishing
 * plan per publication, which is a per-post read the summary has no business making, and drift is
 * already reported where it belongs — beside the post, with the comparison that acts on it.
 */
export function publicationsForHealth(db: Db, createdSince: string): SignalPublication[] {
  const rows = db
    .prepare(
      `SELECT * FROM signal_publications
       WHERE created_at >= ?
          OR state IN ('SUBMITTING','SUBMITTED','UNCONFIRMED','PARTIAL','FAILED')
       ORDER BY created_at DESC, id`,
    )
    .all(createdSince) as unknown as PublicationRow[];
  return rows.map((row) => toPublication(row, targetRowsFor(db, row.id)));
}
