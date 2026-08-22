import type {
  ProviderInventoryNext,
  ProviderInventoryPost,
} from '../../shared/provider-inventory.ts';

/**
 * How this app reads what else is in the provider, and why it is not a method on anything else.
 *
 * Four interfaces now touch the same vendor. `SignalProvider` reads this app's own schedule and has
 * no write method by construction; `PublishProvider` sends and reconciles; `AnalyticsProvider` reads
 * numbers back; and this one lists what the provider is holding. Keeping it here rather than adding
 * `list` to `PublishProvider` is the same construction `browse.ts` uses for Drive and `analytics.ts`
 * for figures: the way to guarantee that an inventory panel cannot reschedule, withdraw, or adopt a
 * post is for the interface it is handed to have no way of doing any of it.
 *
 * One method, and it reads one page. The walk — every page before any write, the repeated-offset
 * refusal, the safety bounds — belongs to the service, because that is the part with the rules in it
 * and the part a fixture can drive. An adapter that walked internally would put those rules inside
 * the one file automated tests may not exercise.
 */
export interface ProviderInventoryProvider {
  /** False leaves the caller a state to render rather than an exception to swallow. */
  readonly available: boolean;
  /**
   * One page of the provider's posts, starting at `offset`, with the provider's own answer about
   * where the next page is.
   *
   * An offset rather than an opaque cursor, because an offset is what C73 verified
   * (`docs/post-bridge-api-surface.md` §14, question 4) and `providerInventoryNextPage` is the rule
   * that says so. A provider that answered with a cursor shape nobody has read arrives here as
   * `next: { unknown: … }`, which fails the refresh rather than being guessed at.
   *
   * A page that cannot be parsed — no envelope, a row with no id, a field of the wrong type —
   * throws. Nothing is dropped quietly: a refresh that replaced a whole inventory from a
   * half-readable answer is the failure this card exists to prevent.
   */
  page(offset: number): Promise<ProviderInventoryPage>;
}

/** One page as the app reads it: normalized rows, and where the provider says the next one is. */
export interface ProviderInventoryPage {
  posts: ProviderInventoryPost[];
  next: ProviderInventoryNext;
}

/**
 * The provider when publishing is not configured.
 *
 * It fails rather than answering with an empty page, because "the provider holds nothing" and "this
 * app cannot ask" are different claims and only one of them would be true. The service checks
 * `available` first and never reaches this, so the error is a guard rather than a path.
 */
export class UnavailableProviderInventoryProvider implements ProviderInventoryProvider {
  readonly available = false;
  private readonly reason: string;
  // Declared and assigned rather than a constructor parameter property: the server runs under
  // `node --experimental-strip-types`, which erases types without rewriting code (`AGENTS.md`).
  constructor(reason = 'The provider inventory needs POST_BRIDGE_API_KEY.') {
    this.reason = reason;
  }
  async page(_offset: number): Promise<ProviderInventoryPage> {
    void _offset;
    throw new Error(this.reason);
  }
}
