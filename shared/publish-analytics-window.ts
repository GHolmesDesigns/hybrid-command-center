import { ANALYTICS_METRICS, type PostMetricTotals } from './publish-analytics.ts';
import type { AnalyticsPlatform } from './publish-analytics.ts';
import type { SignalChannel } from './signal.ts';

/**
 * The provider-filtered analytics window: which windows may be asked for, and what a row means.
 *
 * Outside `server/publish/` for the reason `publish-analytics.ts` is: the panel that renders a window
 * total and the service that stores one have to agree about which windows exist, what a window
 * *means*, and how a row is attributed to an account. A second copy of any of those in React would
 * eventually be a second answer. Nothing here has a database, a clock, or a network call in it.
 *
 * ## This is a second, cheaper question — not a replacement
 *
 * `AnalyticsProvider.list(postResultIds)` and `signal_post_metrics` answer *what did this delivery
 * get*, per delivery, and they are untouched by everything in this file. A window read answers *what
 * does the provider report for this platform over this window*, which is one request rather than a
 * walk over every delivery. Two questions, two stores, and no path here that writes the other one's
 * rows.
 *
 * ## The window meaning is gated on a dated result, and today there is none
 *
 * `GET /v1/analytics` takes `?platform` and `?timeframe` (`7d`, `30d`, `90d`, `all`), read out of the
 * vendor's OpenAPI document — `docs/post-bridge-api-surface.md` §7. What `timeframe` *selects* is the
 * open question: whether it filters which posts are included, which measurement days are counted, or
 * something else again. §14 records that claim, the response grain, and how a row maps to an account
 * as **still unverified**, each with the note *"C80 stays blocked."*
 *
 * So this module carries the whole machinery and offers **no window** until a dated §14 row says what
 * one means. `ANALYTICS_WINDOW_EVIDENCE` is the one place that changes — the same construction
 * `ANALYTICS_MATCH_CONFIDENCE_LABEL` uses for match values and `publishRoleDelivers` uses for media
 * roles: a capability goes true in one table, not at a call site. A window nobody has verified is not
 * offered, is refused by the service if asked for anyway, and is never labelled with a meaning this
 * app guessed at.
 *
 * **Why the request builder and the walk exist anyway.** They are the part a fixture can drive, and
 * building them now is what makes the eventual §14 row a one-line change rather than a card. The
 * probe that would settle the semantics is a single read-only query against an already-sent post; the
 * preconditions for it exist as of 2026-08-23 — a delivered Instagram post the provider has counted —
 * and it stays owner-run, because an automated test may never contact the real provider (`AGENTS.md`).
 */

/**
 * The four window values the vendor's OpenAPI document enumerates, in its own spelling.
 *
 * Documented, which is not the same as verified: this is the set the endpoint validates against, and
 * `ANALYTICS_WINDOW_EVIDENCE` below is the separate question of whether this app knows what any of
 * them *means*. Sending a value outside this list would be inventing a parameter, so the list is the
 * outer bound on what may ever be asked for and the evidence table is the inner one.
 */
export const ANALYTICS_WINDOWS = ['7d', '30d', '90d', 'all'] as const;
export type AnalyticsWindow = (typeof ANALYTICS_WINDOWS)[number];

export const isAnalyticsWindow = (value: string): value is AnalyticsWindow =>
  (ANALYTICS_WINDOWS as readonly string[]).includes(value);

/**
 * The words a window is offered under.
 *
 * Deliberately the vendor's own duration and nothing more — *Last 7 days* would be this app saying
 * the window selects measurement days, which is precisely the claim §14 records as unverified. The
 * meaning is a separate string, supplied only by a dated result.
 */
export const ANALYTICS_WINDOW_LABEL: Record<AnalyticsWindow, string> = {
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All',
};

/**
 * What is known about one window, and when it became known.
 *
 * Two shapes rather than a nullable string, because *unverified* and *verified* are different claims
 * and the verified one cannot exist without the two things that make it a claim at all: a sentence
 * saying what the window selects, in the language the result recorded, and the date the result is
 * from. A verified entry with no meaning would be a window this app offers and cannot describe.
 */
export type AnalyticsWindowEvidence =
  | { verified: false }
  | {
      verified: true;
      /** What this window selects, in the words the dated §14 result used. */
      meaning: string;
      /** `YYYY-MM-DD`, the date of the result that settled it. */
      asOf: string;
    };

/**
 * The gate: what a dated `docs/post-bridge-api-surface.md` §14 row says about each window.
 *
 * **Every entry is unverified as of 2026-08-23, and that is the honest state rather than an
 * oversight.** §14 carries four rows for this endpoint — the timeframe's meaning, the response grain,
 * how a row maps to an account, and the rate-limit contract — and each concludes *"C80 stays
 * blocked."* The probe found no analytics rows to observe when it ran, so nothing was seen.
 *
 * Turning one on is one entry here plus the §14 row it cites, and nothing else in this codebase:
 * `analyticsWindowsOffered` starts offering it, the panel starts labelling it with the meaning
 * recorded here, and `AnalyticsWindowService.refresh` stops refusing it. What must never happen is a
 * window being offered with a meaning invented at a call site, which is why the meaning lives beside
 * the flag rather than in the panel.
 */
export const ANALYTICS_WINDOW_EVIDENCE: Record<AnalyticsWindow, AnalyticsWindowEvidence> = {
  '7d': { verified: false },
  '30d': { verified: false },
  '90d': { verified: false },
  all: { verified: false },
};

/** The windows this app may offer: the verified ones, in the vendor's own order. */
export const analyticsWindowsOffered = (): AnalyticsWindow[] =>
  ANALYTICS_WINDOWS.filter((window) => ANALYTICS_WINDOW_EVIDENCE[window].verified);

/** Whether this window carries a dated result saying what it selects. */
export const analyticsWindowVerified = (window: AnalyticsWindow): boolean =>
  ANALYTICS_WINDOW_EVIDENCE[window].verified;

/**
 * What this window selects, in the words the result recorded — or why there are no words for it.
 *
 * One function for both cases, so no caller can reach a verified meaning without going past the
 * unverified sentence. There is no path through here that hands an unverified window a description.
 */
export function analyticsWindowMeaning(window: AnalyticsWindow): string {
  const evidence = ANALYTICS_WINDOW_EVIDENCE[window];
  return evidence.verified
    ? analyticsWindowVerifiedMeaning(evidence)
    : ANALYTICS_WINDOW_UNVERIFIED_DETAIL;
}

/**
 * The words a dated result is shown as: what it recorded, and when it was recorded.
 *
 * A function of its own rather than a template inside the ternary above, so the sentence a verified
 * window will carry is testable today — while the evidence table verifies nothing and that branch is
 * unreachable through `analyticsWindowMeaning`. The date travels with the claim because a provider
 * contract is a dated observation and not a permanent fact, which is the same reason §14's rows carry
 * their own dates.
 */
export const analyticsWindowVerifiedMeaning = (evidence: {
  meaning: string;
  asOf: string;
}): string => `${evidence.meaning} Verified ${evidence.asOf}.`;

/** Why no window is offered, said once so every surface says it identically. */
export const ANALYTICS_WINDOW_UNVERIFIED_LABEL = 'Window meaning not verified';
export const ANALYTICS_WINDOW_UNVERIFIED_DETAIL =
  'The provider takes a window filter, but what it selects — which posts are included, or which measurement days are counted — has not been observed. Until a dated result says which, no window is offered here rather than one being labelled with a guess. The per-delivery figures on each post are unaffected.';

/**
 * What a window offered by a fixture rather than by evidence says about itself.
 *
 * `AnalyticsWindowService` takes the set of windows it may offer as a constructor argument so that
 * fixtures and the end-to-end run can drive the walk, the replacement, the unmapped count, and the
 * failure path — none of which is reachable while `ANALYTICS_WINDOW_EVIDENCE` verifies nothing. When
 * an instance offers a window the evidence table does not, this is the sentence it carries, and it
 * says exactly that.
 *
 * **Unreachable in production**, where the offered set is the evidence table's own and therefore
 * empty. It exists so a test-seam window can never borrow a verified window's description — the same
 * rule `analyticsMatchPhrase` follows when it refuses to hand an unrecognised token `Exact`'s label.
 */
export const ANALYTICS_WINDOW_FIXTURE_DETAIL =
  'This window is offered by a test fixture rather than by a recorded provider result, so what it selects is still unverified. No build a person uses offers it.';

/**
 * The heading the panel carries, and the sentence that says what a window total is not.
 *
 * Said here for the reason `ANALYTICS_MATCH_DETAIL` is: the distinction has to be on the screen
 * beside the number, not in a comment in the module that computed it.
 */
export const ANALYTICS_WINDOW_HEADING = 'Provider window';
export const ANALYTICS_WINDOW_DETAIL =
  'These are the provider’s own counts for the deliveries it named in this window, added up. Nothing here is a rate, an average, or a share of anything, and a window is not an account total — it is the set of deliveries the provider returned.';

/**
 * How wide one page is asked for, and how far a walk may go before it gives up.
 *
 * A hundred rows a page and twenty pages, which are `shared/provider-inventory.ts`'s numbers on
 * purpose: §14's question 4 verified that `GET /v1/analytics` answers the same `meta` envelope as
 * `GET /v1/posts`, walked at `limit=100`, so the contract this walks is the contract that was
 * verified there. Hitting either bound fails the refresh rather than truncating — a short window
 * silently presented as a complete one is exactly the misreading this card exists to prevent.
 */
export const ANALYTICS_WINDOW_PAGE_SIZE = 100;
export const ANALYTICS_WINDOW_PAGE_MAX = 20;
export const ANALYTICS_WINDOW_ROW_MAX = ANALYTICS_WINDOW_PAGE_SIZE * ANALYTICS_WINDOW_PAGE_MAX;

/**
 * One row of a window read, in this app's vocabulary rather than the vendor's.
 *
 * `postResultId` is not optional, and that is the fail-closed reading of the grain question. §14
 * records *"that every row still carries `post_result_id`"* as unverified; a row arriving without one
 * is therefore this app not understanding the answer, and the wire parser refuses the whole page
 * rather than storing a row that can never be attributed. A row that carries one and matches nothing
 * locally is a different thing entirely — that is `unmapped` below, and it is stored and counted.
 */
export interface AnalyticsWindowRow extends PostMetricTotals {
  /** The provider's id for the analytics record. */
  analyticsId: string;
  /** The delivery this row measures, as the provider identifies it. */
  postResultId: string;
  /** The provider's own platform name for the row. */
  platform: string;
  /** The provider's `last_synced_at`: how old the platform's reading is. */
  providerSyncedAt?: string;
  /** Provenance, under exactly the rules `publish-analytics.ts` states for the per-delivery path. */
  matchConfidence?: string;
  platformPostId?: string;
}

/** One local delivery a window row could belong to, as the target row keys it. */
export interface AnalyticsWindowDelivery {
  publicationId: string;
  accountId: number;
  channel: SignalChannel;
  /** The handle the publication snapshotted, so a row stays readable after a rename. */
  handle: string;
  /** The provider's own result identity for this delivery. Only deliveries carrying one are counted. */
  postResultId: string;
}

/**
 * One account's answer for this window: what was asked about, what came back, and the sum.
 *
 * `deliveries` and `measuredDeliveries` are two different denominators on purpose. The first is how
 * many deliveries *this workspace knows about* on this account that carry a provider result identity
 * — the ones a window read could conceivably have named. The second is how many of them the window
 * actually returned. A total over three of eight deliveries is a true statement about three and a
 * misleading one about eight, so both counts travel with the number that needs them.
 */
export interface AnalyticsWindowGroup {
  platform: AnalyticsPlatform;
  accountId: number;
  channel: SignalChannel;
  handle: string;
  deliveries: number;
  measuredDeliveries: number;
  /** Absent when the window named nothing for this account. Never a row of zeros. */
  totals?: PostMetricTotals;
}

/**
 * A row the provider named that no local delivery claims.
 *
 * Kept, counted, and never attributed to an account. The provider measuring something this workspace
 * has no record of is ordinary — a post made in the provider's own interface, or a delivery whose
 * result identity this app never captured — and it is information rather than a failure, which is why
 * a snapshot carrying these is a `SUCCESS`. What it must never do is join the account totals: an
 * account total that quietly included rows belonging to nothing would be the aggregate this card's
 * out-of-scope list refuses.
 */
export interface AnalyticsWindowUnmapped {
  postResultId: string;
  platform: string;
  /** Present so the panel can say the row was counted, never summed into an account. */
  totals: PostMetricTotals;
}

/**
 * What the window panel renders.
 *
 * One shape for the stored read and for the answer a refresh returns, so the panel cannot show one
 * thing after a page load and another after a button press — the same rule `PostMetricsSummary`
 * follows.
 */
export interface AnalyticsWindowSnapshot {
  /** False when no provider is configured, so the panel explains rather than offering a button. */
  available: boolean;
  /** The windows this build may offer. Empty while §14 verifies none, which the panel states. */
  windows: AnalyticsWindow[];
  platform: AnalyticsPlatform;
  window: AnalyticsWindow;
  /** Whether the selected window carries a dated result. False means refresh is refused. */
  verified: boolean;
  /** What this window selects, or why there are no words for it. */
  meaning: string;
  groups: AnalyticsWindowGroup[];
  unmapped: AnalyticsWindowUnmapped[];
  counts: {
    /** Provider rows in the stored snapshot, mapped and unmapped together. */
    rows: number;
    mapped: number;
    unmapped: number;
  };
  /** When a complete read last replaced this platform/window snapshot. */
  lastRefreshAt?: string;
  /** Why the last attempt replaced nothing. Beside the rows it did not replace, never instead. */
  reason?: string;
}

const ZERO: PostMetricTotals = { views: 0, likes: 0, comments: 0, shares: 0 };

/** Adds one reading into an accumulator. The only arithmetic in this file. */
const addTotals = (into: PostMetricTotals, from: PostMetricTotals): PostMetricTotals => {
  const sum = { ...into };
  for (const metric of ANALYTICS_METRICS) sum[metric] = into[metric] + from[metric];
  return sum;
};

/**
 * The whole answer, from rows alone: rows grouped by the account their delivery belongs to, and the
 * rows that belong to no delivery counted separately.
 *
 * **The one permitted derivation is the addition on the last line of `groupFor`.** Four provider
 * counts added to four provider counts, over a delivery set the panel names. No rate, no average, no
 * per-post normalisation, no follower comparison, and no invented zero — those belong to a card that
 * decides what they mean, exactly as `shared/signal-campaign-analytics.ts` says for its own sum.
 *
 * A group appears for every account this workspace has a result-carrying delivery for on the
 * requested platform, whether or not the window named any of them, because *asked about eight and got
 * three* and *asked about three and got three* are different facts and only the first one warns. An
 * account the window named but that has no local delivery cannot form a group at all — that row is
 * unmapped by definition.
 */
export function summariseAnalyticsWindow(input: {
  platform: AnalyticsPlatform;
  window: AnalyticsWindow;
  rows: readonly AnalyticsWindowRow[];
  /**
   * Every local delivery on this platform carrying a provider result identity, **oldest first**.
   *
   * The order is part of the input rather than an accident of the query, because the last delivery
   * decides the name an account is shown under — see `groupFor`. `readAnalyticsWindowDeliveries`
   * produces exactly that order; a caller handing them over in another one gets a correct total
   * under a handle the account may have stopped using.
   */
  deliveries: readonly AnalyticsWindowDelivery[];
}): {
  groups: AnalyticsWindowGroup[];
  unmapped: AnalyticsWindowUnmapped[];
} {
  const byResultId = new Map<string, AnalyticsWindowDelivery>();
  for (const delivery of input.deliveries) byResultId.set(delivery.postResultId, delivery);

  const rowsByAccount = new Map<number, AnalyticsWindowRow[]>();
  const unmapped: AnalyticsWindowUnmapped[] = [];
  for (const row of input.rows) {
    const delivery = byResultId.get(row.postResultId);
    if (!delivery) {
      unmapped.push({
        postResultId: row.postResultId,
        platform: row.platform,
        totals: { views: row.views, likes: row.likes, comments: row.comments, shares: row.shares },
      });
      continue;
    }
    rowsByAccount.set(delivery.accountId, [...(rowsByAccount.get(delivery.accountId) ?? []), row]);
  }

  const accounts = new Map<number, AnalyticsWindowDelivery[]>();
  for (const delivery of input.deliveries)
    accounts.set(delivery.accountId, [...(accounts.get(delivery.accountId) ?? []), delivery]);

  const groupFor = (
    accountId: number,
    deliveries: AnalyticsWindowDelivery[],
  ): AnalyticsWindowGroup => {
    const own = rowsByAccount.get(accountId) ?? [];
    // The *newest* delivery names the account, which is what the oldest-first input contract above is
    // for. A handle is a snapshot the publication took, so an account renamed since its first
    // delivery carries one stale row and one current one, and showing the name it used to have is
    // worse than showing the one it has now. The channel comes off the same delivery for the same
    // reason: whatever named this group should be one delivery's account, not two halves of two.
    const latest = deliveries[deliveries.length - 1] as AnalyticsWindowDelivery;
    return {
      platform: input.platform,
      accountId,
      channel: latest.channel,
      handle: latest.handle,
      deliveries: deliveries.length,
      measuredDeliveries: own.length,
      ...(own.length
        ? {
            totals: own.reduce(
              (sum, row) =>
                addTotals(sum, {
                  views: row.views,
                  likes: row.likes,
                  comments: row.comments,
                  shares: row.shares,
                }),
              ZERO,
            ),
          }
        : {}),
    };
  };

  return {
    groups: [...accounts.entries()]
      .map(([accountId, deliveries]) => groupFor(accountId, deliveries))
      .sort((left, right) => left.accountId - right.accountId),
    unmapped: unmapped.sort((left, right) => left.postResultId.localeCompare(right.postResultId)),
  };
}

/**
 * The sentence a group's coverage reads as.
 *
 * One function so the panel and any future surface say it identically, and so the *nothing measured*
 * case cannot be rendered as `0` beside three zeros: a group with no rows says how many deliveries
 * went unnamed instead of showing a total that does not exist.
 */
export function analyticsWindowCoverage(group: AnalyticsWindowGroup): string {
  const of = `${group.measuredDeliveries} of ${group.deliveries} ${
    group.deliveries === 1 ? 'delivery' : 'deliveries'
  }`;
  return group.measuredDeliveries
    ? `${of} named in this window.`
    : `${of} named in this window, so there is no total here — which is different from a total of zero.`;
}
