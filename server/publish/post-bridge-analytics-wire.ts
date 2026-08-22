import { PublishProviderError } from './provider.ts';
import type { ProviderAnalyticsList, ProviderAnalyticsRecord } from './analytics-provider.ts';
import { analyticsMatchStorable } from '../../shared/publish-analytics.ts';

/**
 * `GET /v1/analytics` on the wire: the request this app sends, and how a row is read.
 *
 * Pure and covered, like `post-bridge-wire.ts` and `post-bridge-inventory-wire.ts` beside it, and
 * for the same reason: the live adapter in `post-bridge.ts` is `fetch` and a bearer token, so
 * anything that decides what a response *means* has to live where a fixture can reach it. This file
 * exists because C79 gave the analytics response two fields worth arguing about — the app now has to
 * decide what it will and will not store, and a decision made inside an unreachable adapter is one
 * nobody can test.
 *
 * Every field name here is the vendor's, spelled the way `docs/publishing-integration.md` §16.1 read
 * it out of the OpenAPI document.
 */

/**
 * The path one figures request is asked for at.
 *
 * `post_result_id` is repeatable with OR semantics, so one request covers every delivery on a post.
 * `limit` is sent explicitly because the endpoint defaults to ten, and a post that reached more
 * accounts than that would silently come back short.
 *
 * No `platform` and no `timeframe`. Both exist and both are C80's, and §14 records the timeframe
 * semantics — whether it selects posts or measurement days — as still unverified.
 */
export function postBridgeAnalyticsPath(postResultIds: readonly string[]): string {
  return `/analytics?${postResultIds
    .map((id) => `post_result_id=${encodeURIComponent(id)}`)
    .concat(`limit=${Math.max(postResultIds.length, 10)}`)
    .join('&')}`;
}

/**
 * A bounded description of a value this parser refused, safe for the integration log.
 *
 * A string is quoted up to forty characters, which is the same bound `analyticsMatchStorable`
 * enforces, so a legitimate value is never truncated and an illegitimate one cannot carry a response
 * body through. Anything else is named by its type and never serialised: an object arriving in a
 * field that should hold a token could contain anything at all, and the log takes structured facts
 * rather than dumps of a provider response (`AGENTS.md` §Conventions).
 */
function describeRefused(value: unknown): string {
  if (typeof value !== 'string') {
    const kind = value === null ? 'null' : typeof value;
    return `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`;
  }
  const excerpt = value.slice(0, 40).replace(/\s+/g, ' ');
  return `the text “${excerpt}${value.length > 40 ? '…' : ''}”`;
}

/**
 * `match_confidence`, read without inventing one.
 *
 * Three outcomes and no fourth. Absent or null is **absent** — the provider said nothing, and §14
 * records whether a record can even arrive without one as unverified, so a default here would be
 * this app answering a question the probe could not. A short lower-case token is kept exactly as it
 * came, whether or not this build has words for it. Anything else is dropped with a warning rather
 * than trimmed, lower-cased, or coerced: normalising an unrecognised value is precisely how it would
 * end up wearing `exact`'s label.
 */
function readMatchConfidence(
  value: unknown,
  resultId: string,
  warnings: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && analyticsMatchStorable(value)) return value;
  warnings.push(
    `Ignored the match value on the figures record for ${resultId}: it arrived as ${describeRefused(value)}, which is not a value this app stores.`,
  );
  return undefined;
}

/**
 * The platform's own identifier, read as text or not at all.
 *
 * No token rule here, because this is the platform's identifier and not the provider's vocabulary —
 * YouTube's ids carry upper case, dashes, and underscores, and inventing a shape for something eight
 * platforms each spell their own way would refuse valid identifiers. What is enforced is that it is
 * text, that it is not blank, and that it is short enough to be an identifier rather than a payload.
 */
const PLATFORM_POST_ID_MAX = 200;

function readPlatformPostId(
  value: unknown,
  resultId: string,
  warnings: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && trimmed.length <= PLATFORM_POST_ID_MAX) return trimmed;
  }
  warnings.push(
    `Ignored the platform post identifier on the figures record for ${resultId}: it arrived as ${describeRefused(value)}, which is not an identifier this app stores.`,
  );
  return undefined;
}

/**
 * The `data` array, as records this app's vocabulary, plus what it would not store.
 *
 * A body carrying no `data` at all is an empty answer rather than a failure: the endpoint has
 * nothing for these deliveries yet, which is the ordinary state of a post that went out an hour ago.
 * A `data` that is present and is not an array is a failed read — that is this app not understanding
 * the answer, and `PublishAnalyticsService` turns it into a refusal that writes nothing and leaves
 * every stored figure where it was.
 *
 * The four counts keep the coercion they have always had. The vendor types every count as a number
 * and every optional string as an untyped object, so counts are coerced and strings are checked; a
 * missing count is zero *from the provider*, which is different from this app inventing one, because
 * the record existing is itself the evidence that something was measured.
 */
export function parsePostBridgeAnalyticsList(body: unknown): ProviderAnalyticsList {
  const data = (body as { data?: unknown } | null | undefined)?.data;
  if (data === undefined || data === null) return { records: [], warnings: [] };
  if (!Array.isArray(data))
    throw new PublishProviderError(
      'Post Bridge answered the figures request with something this app cannot read.',
      false,
    );
  const warnings: string[] = [];
  const records = data.map((entry): ProviderAnalyticsRecord => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const postResultId = String(row.post_result_id);
    const matchConfidence = readMatchConfidence(row.match_confidence, postResultId, warnings);
    const platformPostId = readPlatformPostId(row.platform_post_id, postResultId, warnings);
    return {
      analyticsId: String(row.id),
      postResultId,
      platform: String(row.platform),
      views: Number(row.view_count ?? 0),
      likes: Number(row.like_count ?? 0),
      comments: Number(row.comment_count ?? 0),
      shares: Number(row.share_count ?? 0),
      ...(typeof row.last_synced_at === 'string' && row.last_synced_at
        ? { lastSyncedAt: row.last_synced_at }
        : {}),
      ...(typeof row.share_url === 'string' && row.share_url ? { shareUrl: row.share_url } : {}),
      ...(matchConfidence ? { matchConfidence } : {}),
      ...(platformPostId ? { platformPostId } : {}),
    };
  });
  return { records, warnings };
}
