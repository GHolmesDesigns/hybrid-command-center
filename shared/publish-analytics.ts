import { PUBLISH_CHANNEL_STATUS_LABEL } from './publish.ts';
import type { PublishPlatform } from './publish-capabilities.ts';
import type { SignalChannel } from './signal.ts';

/**
 * The analytics contract: which platforms carry figures, what a figure is, and how long to wait
 * when the provider says to wait.
 *
 * Outside `server/publish/` for the reason `publish-capabilities.ts` is: the panel that renders a
 * figure and the service that stores one have to agree about which channels *have* figures, and a
 * second copy of that answer in React would show a zero where the honest answer is that nobody
 * measures it. Nothing here has a database or a network call in it.
 *
 * ## Where the values come from
 *
 * Post Bridge's own OpenAPI document (`GET https://api.post-bridge.com/reference`, served inline in
 * the Scalar page's configuration), read 2026-08-19:
 *
 * | Route | What it gives |
 * | --- | --- |
 * | `POST /v1/analytics/sync` | refreshes the provider's own copy. `platform` is optional and enumerated `tiktok \| youtube \| instagram`; the parameter's own description is *"Sync a specific platform only. Omit to sync all."* Documented `429`: *"Rate limited - please wait between syncs."* |
 * | `GET /v1/analytics` | `AnalyticsDto` rows, filterable by `post_result_id` (repeatable, OR) — `view_count`, `like_count`, `comment_count`, `share_count`, `last_synced_at`, `share_url`, `match_confidence` |
 * | `GET /v1/analytics/{id}/daily` | `snapshots` (cumulative totals per `YYYY-MM-DD`) and `deltas` (per-day gains) |
 *
 * **The document disagrees with itself about coverage, and the disagreement is recorded rather than
 * resolved by preference.** The `Analytics` tag description reads "Currently supports TikTok" while
 * the sync route — the machine-readable half, and the newer of the two — enumerates three platforms
 * and names them in its summary. The enum is taken as the answer because it is the part the API
 * validates against, and because the failure modes are not symmetrical: treating a platform as
 * covered costs an empty answer that the availability rule below already has a state for, while
 * treating a covered platform as uncovered would hide figures that exist. A platform that turns out
 * to answer nothing reads as `AWAITING_SYNC`, which is true.
 */
export const ANALYTICS_PLATFORMS = ['tiktok', 'youtube', 'instagram'] as const;
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

/**
 * Whether this platform is one the provider reports figures for.
 *
 * `null` — a channel with no provider at all, which today is `blog` — is not available for the same
 * reason it is not publishable: there is no provider on the other side of it. One function answers
 * for both cases so a caller cannot handle the missing platform and forget the unmeasured one.
 */
export const analyticsPlatformSupported = (
  platform: PublishPlatform | null,
): platform is AnalyticsPlatform =>
  platform !== null && (ANALYTICS_PLATFORMS as readonly string[]).includes(platform);

/**
 * The four figures, and all four of them.
 *
 * Every one is a number the provider reports, never a number this app computes: an engagement rate
 * or a per-follower ratio would be this app's arithmetic presented in the provider's voice, and the
 * first time the two disagreed nobody would know which had been read.
 */
export const ANALYTICS_METRICS = ['views', 'likes', 'comments', 'shares'] as const;
export type AnalyticsMetric = (typeof ANALYTICS_METRICS)[number];

export const ANALYTICS_METRIC_LABEL: Record<AnalyticsMetric, string> = {
  views: 'Views',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
};

/** One reading of all four figures. */
export type PostMetricTotals = Record<AnalyticsMetric, number>;

/**
 * One day's reading, as the provider snapshots it.
 *
 * The provider offers the same day twice — a cumulative `snapshots` array and a `deltas` array of
 * per-day gains — and only the snapshots are stored. A delta is a subtraction between two
 * snapshots, so keeping both would be keeping an answer and its derivation, and the two would
 * disagree the first time a snapshot arrived late. `postMetricDayDeltas` does the subtraction on
 * the way out, from rows that cannot contradict themselves.
 */
export interface PostMetricDay extends PostMetricTotals {
  /** `YYYY-MM-DD`, the provider's own snapshot date, kept as a date string and never an instant. */
  date: string;
}

/**
 * Per-day gains, derived from consecutive stored snapshots.
 *
 * The first snapshot has no previous day to subtract, so it produces no delta — the provider's own
 * rule for its `deltas` array, applied to whatever days this app actually holds. A gap in the days
 * subtracts across the gap rather than inventing the missing ones: the difference is real, and
 * spreading it over days nobody measured would be this app making figures up.
 *
 * Negative differences are kept as they come. A platform that revises a count downwards — a deleted
 * comment, a purged view — has said something true, and clamping it to zero would report growth
 * that did not happen.
 */
export function postMetricDayDeltas(days: readonly PostMetricDay[]): PostMetricDay[] {
  const ordered = [...days].sort((left, right) => left.date.localeCompare(right.date));
  return ordered.slice(1).map((day, index) => {
    const previous = ordered[index] as PostMetricDay;
    return {
      date: day.date,
      views: day.views - previous.views,
      likes: day.likes - previous.likes,
      comments: day.comments - previous.comments,
      shares: day.shares - previous.shares,
    };
  });
}

/**
 * What can be said about one delivery's figures, and why.
 *
 * Four states rather than a number and a null, because the three ways of having no figures are
 * different claims and a reader acts on them differently:
 *
 * - `AVAILABLE` — figures are stored, and they are the provider's.
 * - `AWAITING_SYNC` — the provider measures this platform and has returned nothing for this post
 *   yet. Ordinary for a post that has just gone out.
 * - `AWAITING_RESULT` — the delivery has no provider result identity yet, so there is nothing to
 *   ask about. Refreshing the delivery is what fixes it.
 * - `NOT_AVAILABLE` — nobody measures this channel through this provider, or the delivery did not
 *   go out. Never a zero, and never *not yet* for a post that never published.
 */
export const POST_METRIC_AVAILABILITIES = [
  'AVAILABLE',
  'AWAITING_SYNC',
  'AWAITING_RESULT',
  'NOT_AVAILABLE',
] as const;
export type PostMetricAvailability = (typeof POST_METRIC_AVAILABILITIES)[number];

/**
 * The words each state is shown as.
 *
 * `NOT_AVAILABLE` borrows the publishing contract's sentence rather than restating it. It is the
 * same claim about the same provider — *this channel is not something it reaches* — and two copies
 * of the sentence would eventually be two different sentences for one fact.
 */
export const POST_METRIC_AVAILABILITY_LABEL: Record<PostMetricAvailability, string> = {
  AVAILABLE: 'Figures from the platform',
  AWAITING_SYNC: 'No figures yet',
  AWAITING_RESULT: 'No delivery result to ask about',
  NOT_AVAILABLE: PUBLISH_CHANNEL_STATUS_LABEL.NOT_AVAILABLE,
};

export const POST_METRIC_AVAILABILITY_DETAIL: Record<PostMetricAvailability, string> = {
  AVAILABLE: 'These are the numbers the platform reported, as of the synchronisation below.',
  AWAITING_SYNC:
    'The provider reports figures for this platform but has none for this post yet. A post usually needs a day before anything is counted.',
  AWAITING_RESULT:
    'The provider has not told this app which of its results this delivery is, so there is nothing to ask for figures about. Refresh the delivery first.',
  NOT_AVAILABLE:
    'This provider reports figures for TikTok, YouTube, and Instagram only. Nothing is counted here, which is different from a count of zero.',
};

/** Shown when `NOT_AVAILABLE` is because the delivery did not go out, not because the channel is unmeasured. */
export const POST_METRIC_FAILED_DELIVERY_LABEL = 'Nothing to measure';
export const POST_METRIC_FAILED_DELIVERY_DETAIL =
  'This delivery did not go out, so the platform has nothing to count for it. That is different from a post that went out and is still waiting.';

/** The words one delivery's figures state is shown as, including a failed delivery on a measured platform. */
export const postMetricAvailabilityLabel = (
  availability: PostMetricAvailability,
  outcome?: 'SUCCESS' | 'FAILURE',
): string =>
  availability === 'NOT_AVAILABLE' && outcome === 'FAILURE'
    ? POST_METRIC_FAILED_DELIVERY_LABEL
    : POST_METRIC_AVAILABILITY_LABEL[availability];

/** The explanation one delivery's figures state carries, including a failed delivery on a measured platform. */
export const postMetricAvailabilityDetail = (
  availability: PostMetricAvailability,
  outcome?: 'SUCCESS' | 'FAILURE',
): string =>
  availability === 'NOT_AVAILABLE' && outcome === 'FAILURE'
    ? POST_METRIC_FAILED_DELIVERY_DETAIL
    : POST_METRIC_AVAILABILITY_DETAIL[availability];

/**
 * Which state one delivery is in.
 *
 * The order is the order of the questions: an unmeasured platform is unmeasured whatever else is
 * true of it, a delivery that did not go out has nothing to measure even on a measured platform,
 * and a delivery with no result identity cannot be asked about even where the platform is measured.
 * Getting that order wrong would show *no figures yet* against a channel nobody will ever have
 * figures for, or against a post that never published.
 */
export function postMetricAvailability(input: {
  platform: PublishPlatform | null;
  /** The provider's own result identity for this delivery, where reconciliation has captured one. */
  resultId?: string;
  /** Whether a reading is stored for this delivery. */
  stored: boolean;
  /** Whether the delivery went out. A failure has nothing to measure even with a result identity. */
  outcome?: 'SUCCESS' | 'FAILURE';
}): PostMetricAvailability {
  if (!analyticsPlatformSupported(input.platform)) return 'NOT_AVAILABLE';
  if (input.outcome === 'FAILURE') return 'NOT_AVAILABLE';
  if (!input.resultId) return 'AWAITING_RESULT';
  return input.stored ? 'AVAILABLE' : 'AWAITING_SYNC';
}

/** One delivery's figures, addressed the way the delivery row it belongs to is. */
export interface PostTargetMetrics {
  publicationId: string;
  accountId: number;
  channel: SignalChannel;
  platform: PublishPlatform | null;
  /** The handle as the publication snapshotted it, so a row stays readable after a rename. */
  handle: string;
  availability: PostMetricAvailability;
  /** The provider's `post-results` row id, where reconciliation has captured one. */
  resultId?: string;
  /** Present only when `availability` is `AVAILABLE`. Absent is never rendered as a zero. */
  totals?: PostMetricTotals;
  /** Cumulative daily snapshots, oldest first. Empty where the provider supplied none. */
  days: PostMetricDay[];
  /** The provider's own `last_synced_at` for this record. */
  providerSyncedAt?: string;
  /** When this app last wrote these figures. */
  syncedAt?: string;
  /** The platform's own address for the measured content, where the provider gave one. */
  shareUrl?: string;
  /**
   * How the provider says it matched this record to the platform's content, as its own token.
   *
   * Absent where the provider sent nothing, or sent something this build will not store — never
   * defaulted, and never normalised into a value it recognises. `analyticsMatchPhrase` is what turns
   * it into words.
   */
  matchConfidence?: string;
  /**
   * The platform's own identifier for the measured content, where the provider supplied one.
   *
   * Shown as text and never turned into a link: an identifier is not an address, and assembling one
   * per platform would be this app inventing a URL the provider never gave. `shareUrl` above is the
   * provider's own link and stays the only thing that is one.
   */
  platformPostId?: string;
  /** Whether the delivery went out. Present where the publication target recorded an outcome. */
  outcome?: 'SUCCESS' | 'FAILURE';
}

/** Whether a refresh should ask the provider about this delivery's figures. */
export const postMetricsSyncable = (target: PostTargetMetrics): boolean =>
  target.availability === 'AWAITING_SYNC' || target.availability === 'AVAILABLE';

/**
 * Whether a refresh may run now, and what to say when it may not.
 *
 * A refresh is a person pressing a button, so this is a wait rather than a budget: `allowed` says
 * whether the wait the provider asked for has passed, and `exhausted` reports that it has refused
 * repeatedly without ever refusing a person their next attempt. That is the same line
 * `docs/publishing-integration.md` §9 draws for delivery checks — an automatic schedule is bounded
 * and a person's own refresh is not — and it matters more here, because there is no automatic
 * analytics schedule at all for a bound to protect.
 */
export interface AnalyticsRefreshState {
  allowed: boolean;
  /** Consecutive provider refusals. Reset by the first sync that gets through. */
  attempts: number;
  /** Whether those refusals have reached the bound §9 sets on backoff. */
  exhausted: boolean;
  /** The instant the current wait runs until, where one is in force. */
  waitingUntil?: string;
  /** The same wait in seconds, rounded up, for a sentence a person reads. */
  retryAfterSeconds?: number;
  /** Why a refresh is not running, or how the last one ended. One sentence, already redacted. */
  reason?: string;
}

/**
 * The backoff §9 specifies, as numbers rather than as prose: base 1 s, cap 60 s, at most 5 attempts,
 * exponential with full jitter.
 */
export const ANALYTICS_BACKOFF_BASE_SECONDS = 1;
export const ANALYTICS_BACKOFF_CAP_SECONDS = 60;
export const ANALYTICS_BACKOFF_MAX_ATTEMPTS = 5;

/**
 * How long to wait after the nth consecutive refusal.
 *
 * Full jitter, which is the whole point of the number: the window doubles per attempt up to the cap,
 * and the wait is a random point inside it rather than the window itself. `jitter` is passed in
 * rather than drawn here so this stays a pure function a test can pin — the caller supplies
 * `Math.random()`, and a test supplies `0` or `1` to prove the ends of the window.
 *
 * Never less than a second: a computed wait of zero is not a wait, and the provider's complaint was
 * that this app asked too soon.
 */
export function analyticsBackoffSeconds(attempt: number, jitter: number): number {
  const bounded = Math.max(1, Math.min(attempt, ANALYTICS_BACKOFF_MAX_ATTEMPTS));
  const window = Math.min(
    ANALYTICS_BACKOFF_CAP_SECONDS,
    ANALYTICS_BACKOFF_BASE_SECONDS * 2 ** (bounded - 1),
  );
  return Math.max(1, Math.floor(Math.min(Math.max(jitter, 0), 1) * window));
}

/** The stored record of how the provider's analytics connection is behaving. */
export interface AnalyticsSyncRecord {
  /** When a sync last got through. */
  lastSyncedAt?: string;
  /** When the current wait runs out. */
  waitingUntil?: string;
  /** Consecutive refusals. */
  attempts?: number;
  /** How the last attempt ended, where it did not end well. */
  reason?: string;
}

/**
 * The gate, from the stored record and one moment.
 *
 * A workspace that has never synced is allowed, which is the honest starting point: no refusal has
 * happened, so there is nothing to wait out. A wait that has passed is allowed again even after the
 * bound, because the person in front of the screen is the escape hatch from every schedule in this
 * app — the bound is reported to them instead of enforced against them.
 */
export function analyticsRefreshGate(
  record: AnalyticsSyncRecord | undefined,
  now: Date,
): AnalyticsRefreshState {
  const attempts = record?.attempts ?? 0;
  const exhausted = attempts >= ANALYTICS_BACKOFF_MAX_ATTEMPTS;
  const waitingUntil = record?.waitingUntil;
  const remaining = waitingUntil ? Date.parse(waitingUntil) - now.getTime() : 0;
  if (waitingUntil && remaining > 0)
    return {
      allowed: false,
      attempts,
      exhausted,
      waitingUntil,
      retryAfterSeconds: Math.ceil(remaining / 1000),
      reason: `The provider asked this app to wait. Nothing is retried before ${waitingUntil}, and the figures below are the last ones it gave.`,
    };
  return {
    allowed: true,
    attempts,
    exhausted,
    ...(exhausted
      ? {
          reason: `The provider has refused the last ${attempts} synchronisations. You can try again, but the figures may stay as they are.`,
        }
      : {}),
  };
}

/**
 * Everything the figures panel renders, for one post.
 *
 * One shape for the stored read and for the answer a refresh returns, so the panel cannot show one
 * thing after a page load and another after a button press. `lastSyncedAt` is this app's own record
 * of the last synchronisation that got through — the time the panel shows — and it is deliberately
 * not per target: a person asks *when did we last check*, once, and a refresh either got through or
 * did not.
 */
export interface PostMetricsSummary {
  postId: string;
  targets: PostTargetMetrics[];
  lastSyncedAt?: string;
  refresh: AnalyticsRefreshState;
}

/** Whether any delivery on this post could ever carry figures. */
export const postMetricsMeasurable = (summary: PostMetricsSummary): boolean =>
  summary.targets.some((target) => target.availability !== 'NOT_AVAILABLE');

/**
 * How the provider says it matched a record to the content on the platform.
 *
 * **Provenance, not accuracy.** The vendor's field is `match_confidence`, and the name is the trap:
 * it describes the provider's confidence that this analytics row is *about* this piece of platform
 * content, and says nothing about how accurate the four counts are. Showing it as "confidence in the
 * figure" would put a hedge on numbers the platform itself reported, which is a claim nobody made.
 * Every label and sentence below is written for the first reading, and
 * `ANALYTICS_MATCH_DETAIL` is rendered beside the value wherever it appears so the distinction is on
 * the screen rather than in this comment.
 *
 * **The values are documented and not verified.** `docs/post-bridge-api-surface.md` §7 reads `exact`
 * and `high` out of the vendor's OpenAPI document, and §14's analytics table records the live values
 * as *still unverified* — the probe found no analytics rows to observe. So this build has words of
 * its own for those two and no default for anything: a record that arrives without a match value
 * carries none, and a value this build has never seen is kept as the provider's own token and
 * labelled as one. What must never happen is an unknown value borrowing `Exact`'s label, which is
 * why the two are one function rather than a lookup with a fallback at each call site.
 */
export const ANALYTICS_MATCH_CONFIDENCES = ['exact', 'high'] as const;
export type AnalyticsMatchConfidence = (typeof ANALYTICS_MATCH_CONFIDENCES)[number];

/** The words this build has for the two documented values, and for nothing else. */
export const ANALYTICS_MATCH_CONFIDENCE_LABEL: Record<AnalyticsMatchConfidence, string> = {
  exact: 'Exact',
  high: 'High',
};

/**
 * The shape a match value has to have to be kept at all: `[a-z0-9_-]{1,40}`.
 *
 * A bound rather than an enum, because the enum is unverified and a provider adding a value is
 * ordinary. What the bound buys is that anything stored is a short, lower-case token — safe to put on
 * a screen as itself, impossible to mistake for a sentence, and small enough that no response body
 * can arrive through this field. Anything else is dropped with a warning rather than trimmed or
 * lower-cased into shape: normalising an unrecognised value is how it would end up matching a known
 * one.
 */
const ANALYTICS_MATCH_TOKEN = /^[a-z0-9_-]{1,40}$/;
export const analyticsMatchStorable = (value: string): boolean => ANALYTICS_MATCH_TOKEN.test(value);

/** The heading the match value is shown under, and the sentence that says what it is not. */
export const ANALYTICS_MATCH_HEADING = 'Provider match';
export const ANALYTICS_MATCH_DETAIL =
  'Match quality is how the provider says it matched this record to the content on the platform. It does not qualify or discount the counts above — those are the platform’s own.';

/** The label for the platform's own identifier, which is shown as text and never as a link. */
export const ANALYTICS_PLATFORM_POST_HEADING = 'Platform post';

/**
 * The whole phrase one match value is shown as, and whether this build had words for it.
 *
 * One function returning both, because the two answers have to move together. `known` is what the
 * panel picks an icon from, and `text` already carries the right words for the case: a documented
 * value reads *Provider match: Exact*, and anything else reads *Provider match — Provider value:
 * `token`*, which says exactly as much as this build knows. There is no path through here that
 * hands an unrecognised token a documented label.
 */
export interface AnalyticsMatchPhrase {
  /** True only for a value `ANALYTICS_MATCH_CONFIDENCE_LABEL` has its own words for. */
  known: boolean;
  text: string;
}

export function analyticsMatchPhrase(value: string): AnalyticsMatchPhrase {
  const label = (ANALYTICS_MATCH_CONFIDENCE_LABEL as Record<string, string | undefined>)[value];
  return label
    ? { known: true, text: `${ANALYTICS_MATCH_HEADING}: ${label}` }
    : { known: false, text: `${ANALYTICS_MATCH_HEADING} — Provider value: ${value}` };
}
