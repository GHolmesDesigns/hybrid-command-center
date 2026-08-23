import type { Db } from '../db.ts';
import type { AnalyticsPlatform } from '../../shared/publish-analytics.ts';
import type {
  AnalyticsWindow,
  AnalyticsWindowDelivery,
  AnalyticsWindowRow,
} from '../../shared/publish-analytics-window.ts';
import { publishPlatformFor } from '../../shared/publish-capabilities.ts';
import { isSignalChannel } from '../../shared/signal.ts';

/**
 * The read-only half of the analytics window.
 *
 * Every function here lists, and there is no counterpart in this file that writes one — the same split
 * `read.ts` keeps from `service.ts` and `inventory-rows.ts` keeps from `inventory.ts`, for the same
 * reason. Nothing here reaches the network: the rows were stored by somebody's own press of
 * **Refresh window**, and reading them is local, which is what lets the panel open without spending a
 * provider request.
 */

interface WindowMetricRow {
  post_result_id: string;
  analytics_id: string;
  row_platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  provider_synced_at: string | null;
  match_confidence: string | null;
  platform_post_id: string | null;
  refreshed_at: string;
}

/** The stored generation for one platform and window, in the provider's own result-id order. */
export function readAnalyticsWindowRows(
  db: Db,
  platform: AnalyticsPlatform,
  timeframe: AnalyticsWindow,
): AnalyticsWindowRow[] {
  const rows = db
    .prepare(
      `SELECT post_result_id, analytics_id, row_platform, views, likes, comments, shares,
              provider_synced_at, match_confidence, platform_post_id, refreshed_at
         FROM signal_analytics_window_metrics
        WHERE platform=? AND timeframe=?
        ORDER BY post_result_id`,
    )
    .all(platform, timeframe) as unknown as WindowMetricRow[];
  return rows.map((row) => ({
    analyticsId: row.analytics_id,
    postResultId: row.post_result_id,
    platform: row.row_platform,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    ...(row.provider_synced_at ? { providerSyncedAt: row.provider_synced_at } : {}),
    ...(row.match_confidence ? { matchConfidence: row.match_confidence } : {}),
    ...(row.platform_post_id ? { platformPostId: row.platform_post_id } : {}),
  }));
}

/**
 * When this platform's window was last replaced, or nothing where it never has been.
 *
 * Read off the rows rather than kept in a settings row, because every row of a generation carries the
 * same `refreshed_at` by construction — the replacement writes one instant across the lot. A settings
 * row would be a second copy of a fact the rows already hold, and the two would disagree the first
 * time a transaction rolled back.
 *
 * A generation that replaced the previous one with *no rows* is a real answer — the provider reported
 * nothing for this window — and it is indistinguishable from never having refreshed if the timestamp
 * lives only on rows. That is what `AnalyticsWindowService`'s own record is for; this answers only
 * about rows that exist.
 */
export function readAnalyticsWindowRowsRefreshedAt(
  db: Db,
  platform: AnalyticsPlatform,
  timeframe: AnalyticsWindow,
): string | undefined {
  const row = db
    .prepare(
      `SELECT refreshed_at FROM signal_analytics_window_metrics
        WHERE platform=? AND timeframe=? LIMIT 1`,
    )
    .get(platform, timeframe) as { refreshed_at: string } | undefined;
  return row?.refreshed_at;
}

/**
 * Every local delivery on this platform that carries a provider result identity.
 *
 * **This is the denominator, and it is deliberately every one of them rather than a window's worth.**
 * The window's own date meaning is the claim §14 records as unverified, so this app cannot say which
 * of its deliveries the provider *should* have named — asking that question would be answering the
 * unverified one. What it can say honestly is how many deliveries it knows about that the provider
 * could have named at all, which is what makes `measuredDeliveries` beside `deliveries` a fact rather
 * than a guess.
 *
 * Only deliveries with a `post_result_id` are counted: a delivery the provider never gave an identity
 * for is one no window read could ever name, so including it would inflate the denominator with rows
 * that were never askable. That is the same line `postMetricAvailability` draws with
 * `AWAITING_RESULT`.
 *
 * The channel is mapped to a platform through `publishPlatformFor`, the one shared rule, so a channel
 * and its platform cannot disagree here and in the capability table. The newest delivery's handle
 * wins for an account, because a row showing the name an account used to have is worse than showing
 * the current one.
 */
export function readAnalyticsWindowDeliveries(
  db: Db,
  platform: AnalyticsPlatform,
): AnalyticsWindowDelivery[] {
  const rows = db
    .prepare(
      `SELECT t.publication_id, t.provider_account_id AS account_id, t.channel, t.handle,
              t.post_result_id
         FROM signal_publication_targets t
         JOIN signal_publications p ON p.id = t.publication_id
        WHERE t.post_result_id IS NOT NULL AND t.post_result_id <> ''
        ORDER BY p.created_at ASC, p.id, t.provider_account_id`,
    )
    .all() as unknown as {
    publication_id: string;
    account_id: number;
    channel: string;
    handle: string;
    post_result_id: string;
  }[];
  const deliveries: AnalyticsWindowDelivery[] = [];
  for (const row of rows) {
    if (!isSignalChannel(row.channel)) continue;
    if (publishPlatformFor(row.channel) !== platform) continue;
    deliveries.push({
      publicationId: row.publication_id,
      accountId: row.account_id,
      channel: row.channel,
      handle: row.handle,
      postResultId: row.post_result_id,
    });
  }
  return deliveries;
}
