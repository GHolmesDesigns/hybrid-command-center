import { PublishProviderError } from './provider.ts';
import type { ProviderAnalyticsWindowPage } from './analytics-window-provider.ts';
import { readAnalyticsProvenance } from './post-bridge-analytics-wire.ts';
import { providerInventoryNextPage } from '../../shared/provider-inventory.ts';
import type { AnalyticsPlatform } from '../../shared/publish-analytics.ts';
import type { AnalyticsWindow, AnalyticsWindowRow } from '../../shared/publish-analytics-window.ts';

/**
 * `GET /v1/analytics?platform=&timeframe=` on the wire: the request, and how a page is read.
 *
 * Pure and covered, like `post-bridge-analytics-wire.ts` and `post-bridge-inventory-wire.ts` beside
 * it, and for the same reason: the live adapter in `post-bridge.ts` is `fetch` and a bearer token and
 * is exercised only by the owner's manual QA, so anything that decides what a response *means* has to
 * live where a fixture can reach it.
 *
 * **This file is built and, today, never called with a verified window.** `ANALYTICS_WINDOW_EVIDENCE`
 * in `shared/publish-analytics-window.ts` offers no window until a dated §14 result says what one
 * selects, and `AnalyticsWindowService` refuses an unverified one before it reaches a provider. What
 * that buys is that the request shape and the row rules exist in one tested place — the same reason
 * `postBridgeInventoryPath` holds a filter shape with a unit test on it that nothing calls with a
 * filter. Sending one takes a dated result, exactly as flipping a capability does.
 *
 * Every field name here is the vendor's, spelled the way `docs/post-bridge-api-surface.md` §7 read it
 * out of the OpenAPI document.
 */

export interface PostBridgeAnalyticsWindowQuery {
  platform: AnalyticsPlatform;
  timeframe: AnalyticsWindow;
  limit: number;
  /** The provider's own continuation value: an offset, which is what §14's question 4 verified. */
  offset: number;
}

/**
 * The path one window page is asked for at.
 *
 * `limit` and `offset` are always sent: the endpoint defaults to ten rows, so a walk that omitted them
 * would read a tenth of a page at a time and call the result a window. Both filters are sent as the
 * vendor spells them, singular and unrepeated — `platform` is enumerated `tiktok | youtube |
 * instagram` and `timeframe` is enumerated `7d | 30d | 90d | all`, so neither is the repeatable
 * parameter whose encoding §14 records as unresolved for the posts list. There is nothing to guess
 * about the encoding of a single enumerated value.
 *
 * **No `post_result_id` here, and that is the whole difference from the per-delivery path.**
 * `postBridgeAnalyticsPath` asks about deliveries this app names; this asks the provider which
 * deliveries *it* would name. Sending both would be two questions in one request, and the answer
 * would belong to neither store.
 */
export function postBridgeAnalyticsWindowPath(query: PostBridgeAnalyticsWindowQuery): string {
  return `/analytics?platform=${encodeURIComponent(query.platform)}&timeframe=${encodeURIComponent(
    query.timeframe,
  )}&limit=${query.limit}&offset=${query.offset}`;
}

const refuse = (detail: string): never => {
  throw new PublishProviderError(
    `Post Bridge answered the window request with something this app cannot read: ${detail}`,
    false,
  );
};

/**
 * One row of a window read, normalized — or a refusal.
 *
 * **A row with no readable `post_result_id` fails the whole page, and that is the fail-closed reading
 * of the one claim this card is blocked on.** §14 records *"that a filtered response is one row per
 * measured delivery … and that every row still carries `post_result_id`"* as still unverified. If a
 * row arrives without one, the response is not the grain this app was built to read: it might be an
 * account aggregate, which is exactly the thing the card's out-of-scope list forbids presenting. The
 * honest answer is that this app did not understand the answer, so nothing is replaced — not that the
 * row is dropped and the rest stored, which would silently turn an aggregate into a partial window.
 *
 * `id` is strict for the same reason it is in the inventory parser: it is what a row *is*.
 *
 * The four counts keep the coercion the per-delivery parser has always had — the vendor types every
 * count as a number, and a missing count is zero *from the provider*, because the record existing is
 * itself the evidence that something was measured. `platform` is read as the provider's own text and
 * is not narrowed to `AnalyticsPlatform`: it is stored as provenance for the row, and a provider that
 * answers a platform filter with a name this build has no word for has said something worth keeping
 * rather than something worth crashing over.
 */
export function parsePostBridgeAnalyticsWindowRow(
  value: unknown,
  warnings: string[],
): AnalyticsWindowRow {
  if (!value || typeof value !== 'object')
    return refuse(`a row is ${JSON.stringify(value ?? null)}`);
  const row = value as Record<string, unknown>;
  const analyticsId =
    typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id).trim() : '';
  if (!analyticsId) return refuse('a row carries no id');
  const postResultId =
    typeof row.post_result_id === 'string' || typeof row.post_result_id === 'number'
      ? String(row.post_result_id).trim()
      : '';
  if (!postResultId)
    return refuse(
      `the row ${analyticsId} carries no post_result_id, so it cannot be attributed to a delivery and the response grain is not the one this app reads`,
    );
  if (typeof row.platform !== 'string' || !row.platform.trim())
    return refuse(`the platform of ${analyticsId} is ${JSON.stringify(row.platform ?? null)}`);
  return {
    analyticsId,
    postResultId,
    platform: row.platform.trim(),
    views: Number(row.view_count ?? 0),
    likes: Number(row.like_count ?? 0),
    comments: Number(row.comment_count ?? 0),
    shares: Number(row.share_count ?? 0),
    ...(typeof row.last_synced_at === 'string' && row.last_synced_at
      ? { providerSyncedAt: row.last_synced_at }
      : {}),
    ...readAnalyticsProvenance(row, postResultId, warnings),
  };
}

/**
 * One page: `data` as rows, `meta` as the answer about the next page.
 *
 * A body with no `data` array is refused rather than read as an empty page, which is the difference
 * between *the provider reports nothing for this window* and *this app did not understand the answer*.
 * The first is a window; the second is a failed refresh that must replace nothing. That is stricter
 * than `parsePostBridgeAnalyticsList`, which reads an absent `data` as an empty answer — and
 * deliberately so: an empty per-delivery answer is the ordinary state of a post that went out an hour
 * ago, whereas an unreadable window page would replace a whole stored generation.
 *
 * `meta` is not validated here beyond the pagination rule: `providerInventoryNextPage` returns
 * `unknown` for an envelope it cannot read and the caller fails the refresh on it. Deciding it here
 * would put half the walk in the parser.
 */
export function parsePostBridgeAnalyticsWindowPage(body: unknown): ProviderAnalyticsWindowPage {
  if (!body || typeof body !== 'object') return refuse(`a page is ${JSON.stringify(body ?? null)}`);
  const rows = (body as Record<string, unknown>).data;
  if (!Array.isArray(rows)) return refuse('a page carried no list of rows');
  const warnings: string[] = [];
  return {
    rows: rows.map((row) => parsePostBridgeAnalyticsWindowRow(row, warnings)),
    next: providerInventoryNextPage((body as Record<string, unknown>).meta),
    warnings,
  };
}
