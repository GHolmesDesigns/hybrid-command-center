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
    .prepare(
      `SELECT t.*, a.provider AS account_provider, a.provider_account_ref
         FROM signal_publication_targets t
         LEFT JOIN signal_provider_accounts a ON a.id=t.provider_account_id
        WHERE t.publication_id=? ORDER BY t.rowid`,
    )
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

/**
 * The delivery records for one planner batch of posts.
 *
 * Bounded by the post ids the planner already decided to show — the dated range page plus the
 * unscheduled queue — so opening Signal is one local read rather than one request per card. Empty
 * input is an empty answer: there is nothing to look up and no reason to build an `IN ()`.
 *
 * Read-only: the same `toPublication` / `targetRowsFor` path the health summary uses, with no
 * drift recomputation and no provider contact.
 */
export function publicationsForPosts(db: Db, postIds: readonly string[]): SignalPublication[] {
  if (postIds.length === 0) return [];
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM signal_publications
        WHERE post_id IN (${placeholders})
        ORDER BY created_at DESC, id DESC`,
    )
    .all(...postIds) as unknown as PublicationRow[];
  return rows.map((row) => toPublication(row, targetRowsFor(db, row.id)));
}
