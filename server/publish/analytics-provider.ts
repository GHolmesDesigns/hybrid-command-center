import type { AnalyticsPlatform } from '../../shared/publish-analytics.ts';

/**
 * How this app reads figures, and the reason it is not a method on anything that already exists.
 *
 * Three interfaces now touch the same vendor: `SignalProvider` reads the schedule and has no write
 * method by construction, `PublishProvider` sends and reconciles, and this one only ever reads
 * numbers back. Keeping analytics here rather than adding methods to either of the others is the
 * card's own acceptance criterion, and it is the same construction `browse.ts` uses for Drive: the
 * way to guarantee that a figures panel cannot reschedule a post is for the interface it is handed
 * to have no way of doing it.
 *
 * `sync` is the one method that is not a read, and it is a read in every sense that matters here: it
 * asks the provider to refresh *its own* copy of what the platforms say, and it cannot change a
 * post, a schedule, or a delivery. Nothing on this interface writes to Signal, to a publication, or
 * to a target.
 *
 * Failures come back as `PublishProviderError` from `provider.ts` rather than as a second error
 * class. A `429` is a fact about the connection whichever endpoint returned it
 * (`docs/publishing-integration.md` §9), so the type that carries `rateLimited` and
 * `retryAfterSeconds` is the type this path needs too, and a parallel class would be a second answer
 * to one question.
 */
export interface AnalyticsProvider {
  /** False leaves the caller a state to render rather than an exception to swallow. */
  readonly available: boolean;
  /**
   * Asks the provider to refresh its own figures, for every platform it exposes.
   *
   * No platform argument, deliberately. The vendor's `platform` parameter is documented as *"Sync a
   * specific platform only. Omit to sync all"*, and syncing all is what this app wants every time —
   * a post can reach three measured platforms at once, and three narrowed calls against an endpoint
   * whose documented `429` says *"please wait between syncs"* would spend the whole budget on the
   * shape of the request. `platforms` is here so an implementation can say which platforms one call
   * covered, and so a test can prove it covered all of them.
   */
  sync(): Promise<{ platforms: readonly AnalyticsPlatform[] }>;
  /**
   * The provider's current record for each named delivery result, in no particular order.
   *
   * Asked by result id rather than by post id, because a result *is* the unit the provider measures:
   * one row per account per post, which is exactly the grain `signal_publication_targets` keeps. A
   * result the provider has no figures for is simply absent from the answer; it is not an error and
   * it is not a zero.
   *
   * The answer carries `warnings` beside the records because a row can be readable and still contain
   * a field this app refuses to store. Dropping such a field silently would make the app's own
   * blind spot invisible; failing the whole refresh over it would throw away four counts the
   * platform did report. So the record comes back without the field and the reason comes back beside
   * it, and the service writes the reason to the integration log.
   */
  list(postResultIds: readonly string[]): Promise<ProviderAnalyticsList>;
  /**
   * The daily snapshots behind one record, oldest first, or an empty array where the provider keeps
   * none. Cumulative totals per day — the provider's `snapshots`, not its `deltas`.
   */
  days(analyticsId: string): Promise<ProviderAnalyticsDay[]>;
}

/**
 * One measured delivery, in this app's vocabulary rather than the vendor's.
 *
 * `view_count` and friends become `views`; `post_result_id` becomes `postResultId`. The translation
 * happens in `post-bridge.ts` and nowhere else, which is the rule that file already carries for the
 * publishing endpoints.
 */
export interface ProviderAnalyticsRecord {
  /** The provider's id for the analytics record, which is what `days` is asked about. */
  analyticsId: string;
  /** The delivery this record measures, as the provider identifies it. */
  postResultId: string;
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  /** The provider's own `last_synced_at`: how old the platform's reading is. */
  lastSyncedAt?: string;
  /** The platform's address for the measured content, where the provider supplies one. */
  shareUrl?: string;
  /**
   * How the provider says it matched this record to the platform's content, as its own token.
   *
   * Absent where the provider sent nothing and absent where it sent a shape this app will not store.
   * Never defaulted: `docs/post-bridge-api-surface.md` §14 records the live values as unverified, so
   * the only honest answer for a record without one is nothing at all.
   */
  matchConfidence?: string;
  /** The platform's own identifier for the measured content, where the provider supplied one. */
  platformPostId?: string;
}

/**
 * What one `list` call answered: the records, and what it would not store.
 *
 * `warnings` is a list of already-bounded sentences, not a response body. A parser produces one when
 * a provenance field arrives in a shape this app refuses — a match value that is not a short
 * lower-case token, a platform identifier that is not text — and the sentence names the row and the
 * shape without echoing anything unbounded back into the integration log.
 */
export interface ProviderAnalyticsList {
  records: ProviderAnalyticsRecord[];
  warnings: string[];
}

export interface ProviderAnalyticsDay {
  /** `YYYY-MM-DD`. A date, never an instant. */
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/**
 * The provider when analytics is not configured. Every method fails the same way, so a caller that
 * forgets to check `available` gets a named error rather than a panel full of zeros.
 */
export class UnavailableAnalyticsProvider implements AnalyticsProvider {
  readonly available = false;
  private readonly reason: string;
  // Declared and assigned rather than a constructor parameter property: the server runs under
  // `node --experimental-strip-types`, which erases types without rewriting code.
  constructor(reason = 'Analytics needs POST_BRIDGE_API_KEY.') {
    this.reason = reason;
  }
  private fail(): never {
    throw new Error(this.reason);
  }
  async sync(): Promise<{ platforms: readonly AnalyticsPlatform[] }> {
    return this.fail();
  }
  async list(_postResultIds: readonly string[]): Promise<ProviderAnalyticsList> {
    void _postResultIds;
    return this.fail();
  }
  async days(_analyticsId: string): Promise<ProviderAnalyticsDay[]> {
    void _analyticsId;
    return this.fail();
  }
}
