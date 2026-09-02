import type { Db } from '../db.ts';
import {
  normalizeSignalCampaignName,
  SIGNAL_RANGE_LIMIT,
  type SignalLifecycleFilter,
} from '../../shared/signal.ts';
import type { SignalProvider, SignalPostRange } from './provider.ts';
import type { PublishVariantRecord } from '../../shared/publish-variants.ts';
import type { PublishTargetSelection } from '../../shared/publish.ts';
import {
  listPostPublishTargets,
  listPostVariants,
  signalLifecycleSql,
  toSignalPosts,
  signalPostSelect,
  type SignalPostRow,
} from './rows.ts';

/**
 * The read half of Signal, and the only half the calendar sees.
 *
 * Everything here lists. There is no counterpart in this file that writes, and the interface it
 * satisfies has none either, so nothing consuming a schedule can reach a change to one — the
 * same construction `server/drive/browse.ts` uses to keep Drive browsing read-only.
 */

/**
 * Dated posts in an inclusive `YYYY-MM-DD` range.
 *
 * The comparison is on the stored strings. `YYYY-MM-DD` sorts lexicographically and
 * chronologically at once, so a range is a plain `BETWEEN` with no date parsing anywhere in it —
 * which is what keeps a post on the day it was scheduled for regardless of the server's zone or
 * the time of year (see `shared/signal.ts` for the cell rule).
 *
 * `date IS NOT NULL` is implied by the range, and stated anyway: the unscheduled queue must
 * never leak into a calendar, and saying so here means a later edit to the bounds cannot let it.
 *
 * Lifecycle defaults to active plans only — retired plans stay out of the calendar and planner
 * grid unless the caller asks for `retired` or `all`. That filter is lifecycle, not planning
 * status and not delivery state.
 */
export function listPostsInRange(
  db: Db,
  from: string,
  to: string,
  lifecycle: SignalLifecycleFilter = 'active',
  filters: { projectId?: string; campaign?: string } = {},
): SignalPostRange {
  const lifecycleClause = signalLifecycleSql(lifecycle);
  const clauses = ['date IS NOT NULL', 'date >= ?', 'date <= ?'];
  if (lifecycleClause.sql) clauses.push(lifecycleClause.sql.replace(/^ AND /, ''));
  const params: (string | number)[] = [from, to];
  if (filters.projectId) {
    clauses.push('project_id = ?');
    params.push(filters.projectId);
  }
  if (filters.campaign) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM signal_post_campaigns pc
         JOIN signal_campaigns c ON c.id = pc.campaign_id
         WHERE pc.post_id = signal_posts.id AND c.name = ? COLLATE NOCASE
       )`,
    );
    params.push(normalizeSignalCampaignName(filters.campaign));
  }
  const rows = db
    .prepare(
      `${signalPostSelect}
       WHERE ${clauses.map((clause) => clause.replaceAll('signal_posts.', 'p.')).join(' AND ')}
       ORDER BY p.date, p.time, p.created_at, p.id
       LIMIT ?`,
    )
    // One more than the limit, so a full page is distinguishable from an overflowing one.
    .all(...params, SIGNAL_RANGE_LIMIT + 1) as unknown as SignalPostRow[];
  const truncated = rows.length > SIGNAL_RANGE_LIMIT;
  return { from, to, posts: toSignalPosts(db, rows.slice(0, SIGNAL_RANGE_LIMIT)), truncated };
}

/**
 * The `SignalProvider` backed by this database.
 *
 * The field is declared and assigned rather than written as a constructor parameter property:
 * the server runs under `node --experimental-strip-types`, which erases types without rewriting
 * anything, and a parameter property is the one TypeScript form that needs a rewrite to mean
 * what it says. Vite transpiles it happily, so this only fails where it matters — at boot.
 */
export class LocalSignalProvider implements SignalProvider {
  readonly available = true;
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  async listPosts(input: { from: string; to: string }): Promise<SignalPostRange> {
    // Calendar composition stays on active plans: a retired plan is not a cell the month owes.
    return listPostsInRange(this.db, input.from, input.to, 'active');
  }
  async listVariants(postId: string): Promise<PublishVariantRecord[]> {
    return listPostVariants(this.db, postId);
  }
  async listPublishTargets(postId: string): Promise<PublishTargetSelection[]> {
    return listPostPublishTargets(this.db, postId);
  }
}

export const signalProvider = (db: Db): SignalProvider => new LocalSignalProvider(db);
