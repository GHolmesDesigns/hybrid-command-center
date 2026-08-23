import type { AnalyticsPlatform } from '../../shared/publish-analytics.ts';
import type { AnalyticsWindow, AnalyticsWindowRow } from '../../shared/publish-analytics-window.ts';
import type { ProviderInventoryNext } from '../../shared/provider-inventory.ts';

/**
 * How this app reads a provider-filtered window, and why it is a fifth interface rather than a method.
 *
 * Four interfaces already touch this vendor: `SignalProvider` reads this app's own schedule and has
 * no write method by construction, `PublishProvider` sends and reconciles, `AnalyticsProvider` reads
 * figures back per delivery, and `ProviderInventoryProvider` lists what the provider is holding. This
 * is the fifth, and the separation is the card's own acceptance criterion — *"Preserve
 * `AnalyticsProvider.list(postResultIds)` exactly for per-post refresh."*
 *
 * Adding `listWindow` to `AnalyticsProvider` would have satisfied the letter of that and broken its
 * point. The two reads answer different questions, are stored in different tables, and fail
 * differently: a per-post refresh writes the deliveries it was asked about, and a window refresh
 * replaces a whole snapshot or replaces nothing. Keeping them apart is what guarantees a window panel
 * cannot spend an `analytics/sync` — there is no `sync` on this interface, so the route that opens a
 * window cannot reach one. It is the same construction `browse.ts` uses for Drive and `inventory.ts`
 * for the provider's own posts.
 *
 * **One method, and it reads one page.** The walk — every page before any write, the repeated-token
 * refusal, the safety bounds — belongs to the service, because that is the part with the rules in it
 * and the part a fixture can drive. An adapter that walked internally would put those rules inside the
 * one file automated tests may not exercise.
 */
export interface AnalyticsWindowProvider {
  /** False leaves the caller a state to render rather than an exception to swallow. */
  readonly available: boolean;
  /**
   * One page of the provider's rows for this platform and window, and where the next page is.
   *
   * **The name and the return type both say `rows`, deliberately.** This returns what the provider
   * said about individual deliveries; it does not return an account aggregate, and there is no shape
   * on this interface that could carry one. The addition happens later, in
   * `summariseAnalyticsWindow`, over a delivery set the panel names — which is the only place in this
   * card that is allowed to add anything.
   *
   * `pageToken` is the provider's own continuation value, opaque to the caller: it comes back inside
   * `next` and is handed straight back on the following call. For Post Bridge that value is an
   * offset, because an offset is what §14's question 4 verified and `providerInventoryNextPage` is
   * the one rule that reads it. A provider answering with a token shape nobody has read arrives as
   * `next: { unknown: … }` and fails the refresh rather than being guessed at.
   *
   * A page that cannot be parsed — no envelope, a row with no result identity, a field of the wrong
   * type — throws. Nothing is dropped quietly: a refresh that replaced a whole snapshot from a
   * half-readable answer is the failure this card exists to prevent.
   */
  listWindow(request: {
    platform: AnalyticsPlatform;
    timeframe: AnalyticsWindow;
    pageToken?: number;
  }): Promise<ProviderAnalyticsWindowPage>;
}

/**
 * One page as the app reads it: provider rows, and where the provider says the next page is.
 *
 * `rows` rather than `records` or `totals`, and it is not a nullable aggregate with a rows field
 * beside it — there is nothing on this type that a caller could mistake for an account figure.
 *
 * `next` is `ProviderInventoryNext`, the posts list's own type, and reusing it is the point rather
 * than an economy. §14's question 4 records that `GET /v1/analytics` answers the same
 * `meta: { total, offset, limit, next }` envelope as `GET /v1/posts` — so the contract this walks *is*
 * the contract that was verified there, and `providerInventoryNextPage` is the one function that
 * reads it. A parallel type and a parallel parser would be a second answer to *is this the last
 * page*, which is the thing `AGENTS.md` names as the reason that rule lives in `shared/` at all.
 */
export interface ProviderAnalyticsWindowPage {
  rows: AnalyticsWindowRow[];
  next: ProviderInventoryNext;
  /**
   * What the parser would not store, as already-bounded sentences.
   *
   * Beside the rows for the reason `ProviderAnalyticsList.warnings` is: a row can be readable and
   * still carry a provenance field this app refuses. Dropping it silently would make the app's own
   * blind spot invisible, and failing the whole window over it would throw away four counts the
   * platform did report. The service writes these to the integration log.
   */
  warnings: string[];
}

/**
 * The provider when publishing is not configured.
 *
 * It fails rather than answering with an empty page, because *the provider reports nothing for this
 * window* and *this app cannot ask* are different claims and only one of them would be true. The
 * service checks `available` first and never reaches this, so the error is a guard rather than a path.
 */
export class UnavailableAnalyticsWindowProvider implements AnalyticsWindowProvider {
  readonly available = false;
  private readonly reason: string;
  // Declared and assigned rather than a constructor parameter property: the server runs under
  // `node --experimental-strip-types`, which erases types without rewriting code (`AGENTS.md`).
  constructor(reason = 'The provider analytics window needs POST_BRIDGE_API_KEY.') {
    this.reason = reason;
  }
  async listWindow(_request: {
    platform: AnalyticsPlatform;
    timeframe: AnalyticsWindow;
    pageToken?: number;
  }): Promise<ProviderAnalyticsWindowPage> {
    void _request;
    throw new Error(this.reason);
  }
}
