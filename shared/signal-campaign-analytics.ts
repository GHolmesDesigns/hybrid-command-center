import {
  postMetricDayDeltas,
  ANALYTICS_METRICS,
  type PostMetricDay,
  type PostMetricTotals,
} from './publish-analytics.ts';
import { compareSignalCampaigns, type SignalCampaign, type SignalChannel } from './signal.ts';

/**
 * Figures, segmented by the campaign the post belongs to.
 *
 * ## What this is allowed to do with a number, and what it is not
 *
 * `AGENTS.md` states that figures are read, never computed, and that a per-day gain — a subtraction
 * between two of the provider's own stored snapshots — is the one derivation already decided;
 * anything beyond that "belongs to a card that decides what it means". This module is that decision,
 * and it is deliberately the smallest one that answers the question a campaign view is opened for:
 *
 * - A **total** is an addition of the provider's own per-delivery figures over a named set of
 *   deliveries. Nothing is scaled, averaged, weighted, or divided; there is no rate, no ratio, and
 *   no per-post or per-follower figure anywhere in this file. Adding four numbers to four numbers
 *   produces numbers of the same kind, which is the whole of why addition is admissible here.
 * - A **trend point** is the sum of `postMetricDayDeltas` across the deliveries in scope for one of
 *   the provider's own day labels. Every term in it is already a subtraction the shared analytics
 *   module performs; this only adds them up.
 *
 * ## A sum is never mistaken for coverage
 *
 * Every group reports `deliveries` beside `measuredDeliveries`, and a group with nothing measured
 * has **no** `totals` field at all rather than a set of zeros — the same distinction
 * `postMetricAvailability` draws for one delivery, carried up to an aggregate. A total of 4,000
 * views over three deliveries where one is measured is a true statement about one delivery and a
 * misleading one about three, so the two counts travel with the number that needs them.
 *
 * ## Dates
 *
 * The range is a question about **which posts**, not about which days: a post whose `date` falls
 * inside it brings its whole measured history with it. Two ranges — one selecting posts and one
 * clipping snapshots — would be two answers to *what period is this*, and a reader would have no way
 * to tell which one a total belonged to. A post with no date is in no range, exactly as
 * `isSignalPostInRange` already has it; with no range given at all the unscheduled queue is in
 * scope, because then nothing has been asked about days.
 *
 * Nothing here has a database, a network call, or an instant in it.
 */

/**
 * The reserved campaign filter value meaning *posts carrying no campaign at all*.
 *
 * A literal rather than a separate boolean because it belongs in the same OR list as the campaign
 * ids: **No campaign** is one more thing a person can select, and splitting it into a second
 * parameter would make "these campaigns, or none" two questions in the address. Campaign ids are
 * UUIDs, so this cannot collide with one.
 */
export const SIGNAL_CAMPAIGN_NONE = 'none';

/** The name **No campaign** is shown under, said once so every view says it identically. */
export const SIGNAL_CAMPAIGN_NONE_LABEL = 'No campaign';

/**
 * What was asked for. Every list is OR within itself and AND against the others, and an empty list
 * is *no restriction* rather than *nothing* — which is what makes the unfiltered view the default.
 */
export interface SignalCampaignAnalyticsFilters {
  /** Campaign ids, plus `SIGNAL_CAMPAIGN_NONE` for the posts that carry none. */
  campaignIds: string[];
  channels: SignalChannel[];
  /** Provider account ids, as the delivery rows carry them. */
  accountIds: number[];
  /** `YYYY-MM-DD`, inclusive. Either end may stand alone. */
  from: string | null;
  to: string | null;
}

/** A post as this summary needs it: what it is called, when it is, and what it belongs to. */
export interface SignalCampaignAnalyticsPost {
  id: string;
  /** The post's first line, from `signalPostName`, so a group can name what is inside it. */
  name: string;
  date: string | null;
  campaigns: SignalCampaign[];
}

/** One delivery, with whatever the provider has said about it. */
export interface SignalCampaignAnalyticsDelivery {
  postId: string;
  publicationId: string;
  accountId: number;
  channel: SignalChannel;
  /** The handle the publication snapshotted, so an account stays readable after a rename. */
  handle: string;
  /** Present only where a reading is stored. Absent is never rendered as a zero. */
  totals?: PostMetricTotals;
  /** The provider's cumulative daily snapshots, oldest first. Empty where it supplied none. */
  days: PostMetricDay[];
}

/** The rows a summary is concluded from. The server gathers these and decides nothing. */
export interface SignalCampaignAnalyticsInput {
  posts: SignalCampaignAnalyticsPost[];
  deliveries: SignalCampaignAnalyticsDelivery[];
  /** Every campaign in the workspace, so the filter can offer one with nothing in scope. */
  campaigns: SignalCampaign[];
}

/** How much of what is in scope carries a figure. Always beside a total, never behind it. */
export interface SignalCampaignAnalyticsScope {
  posts: number;
  deliveries: number;
  measuredDeliveries: number;
}

/** One campaign's answer, or **No campaign**'s. */
export interface SignalCampaignAnalyticsGroup extends SignalCampaignAnalyticsScope {
  /** Null is the **No campaign** group. */
  campaignId: string | null;
  name: string;
  color?: string;
  /** Absent when nothing in this group is measured. */
  totals?: PostMetricTotals;
  /** Summed per-day gains, oldest first. Empty where no delivery here has two snapshots. */
  trend: PostMetricDay[];
}

/** An account the filter may offer, named the way a delivery row names it. */
export interface SignalCampaignAnalyticsAccount {
  accountId: number;
  channel: SignalChannel;
  handle: string;
}

export interface SignalCampaignAnalytics {
  filters: SignalCampaignAnalyticsFilters;
  /** Campaigns with posts in scope, name-ordered, **No campaign** last where it has any. */
  groups: SignalCampaignAnalyticsGroup[];
  /** Posts and deliveries counted once each, however many campaigns they belong to. */
  scope: SignalCampaignAnalyticsScope;
  /** Absent when nothing in scope is measured. */
  totals?: PostMetricTotals;
  trend: PostMetricDay[];
  /**
   * What the filter controls may offer. Deliberately derived from every delivery this workspace has
   * ever recorded rather than from the filtered scope, so choosing one channel does not remove the
   * others from the control that chose it.
   */
  channels: SignalChannel[];
  accounts: SignalCampaignAnalyticsAccount[];
  campaigns: SignalCampaign[];
}

const ZERO: PostMetricTotals = { views: 0, likes: 0, comments: 0, shares: 0 };

/** Adds one reading into an accumulator. The only arithmetic in this file, besides the trend. */
const addTotals = (into: PostMetricTotals, from: PostMetricTotals): PostMetricTotals => {
  const sum = { ...into };
  for (const metric of ANALYTICS_METRICS) sum[metric] = into[metric] + from[metric];
  return sum;
};

/**
 * Per-day gains for a set of deliveries, summed by the provider's own day label.
 *
 * A day only carries the deliveries that have a snapshot on it. Nothing is interpolated and no
 * missing day is invented: a delivery whose history starts later simply contributes nothing to the
 * earlier days, which is true, where spreading its first gain backwards would not be.
 */
export function signalCampaignTrend(
  deliveries: readonly SignalCampaignAnalyticsDelivery[],
): PostMetricDay[] {
  const byDate = new Map<string, PostMetricTotals>();
  for (const delivery of deliveries)
    for (const gain of postMetricDayDeltas(delivery.days))
      byDate.set(gain.date, addTotals(byDate.get(gain.date) ?? ZERO, gain));
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, totals]) => ({ date, ...totals }));
}

/**
 * Whether a post's own date satisfies the range.
 *
 * The comparison is on the stored `YYYY-MM-DD` strings, which order lexicographically and
 * chronologically at once — the cell rule in `shared/signal.ts`, and the reason nothing here parses
 * a date. An undated post is in no range at all, and in scope only when no range was asked for.
 */
const inRange = (date: string | null, from: string | null, to: string | null): boolean => {
  if (!from && !to) return true;
  if (date === null) return false;
  return (!from || date >= from) && (!to || date <= to);
};

const scopeOf = (
  posts: readonly SignalCampaignAnalyticsPost[],
  deliveries: readonly SignalCampaignAnalyticsDelivery[],
): SignalCampaignAnalyticsScope => ({
  posts: posts.length,
  deliveries: deliveries.length,
  measuredDeliveries: deliveries.filter((delivery) => delivery.totals).length,
});

/** The four figures for a set of deliveries, or nothing at all when none of them is measured. */
const totalsOf = (
  deliveries: readonly SignalCampaignAnalyticsDelivery[],
): PostMetricTotals | undefined => {
  const measured = deliveries.filter((delivery) => delivery.totals);
  if (!measured.length) return undefined;
  return measured.reduce(
    (sum, delivery) => addTotals(sum, delivery.totals as PostMetricTotals),
    ZERO,
  );
};

/**
 * The whole answer, from rows alone.
 *
 * Posts are selected first, by campaign and by date; their deliveries are then selected by channel
 * and account. A post whose every delivery is filtered out stays in scope as a post — it is still a
 * post in the campaign, with nothing measured about the channel that was asked about, and dropping
 * it would make the post count answer a different question from the one the filter asked.
 *
 * The top-level totals and trend are computed from the **deduplicated** delivery set rather than by
 * adding the groups up. A post in two campaigns belongs to both groups, and summing the groups would
 * count its figures twice.
 */
export function summariseSignalCampaignAnalytics(
  input: SignalCampaignAnalyticsInput,
  filters: SignalCampaignAnalyticsFilters,
): SignalCampaignAnalytics {
  const wanted = new Set(filters.campaignIds);
  const channels = new Set(filters.channels);
  const accounts = new Set(filters.accountIds);
  const posts = input.posts.filter((post) => {
    if (!inRange(post.date, filters.from, filters.to)) return false;
    if (!wanted.size) return true;
    if (!post.campaigns.length) return wanted.has(SIGNAL_CAMPAIGN_NONE);
    return post.campaigns.some((campaign) => wanted.has(campaign.id));
  });
  const inScope = new Set(posts.map((post) => post.id));
  const deliveries = input.deliveries.filter(
    (delivery) =>
      inScope.has(delivery.postId) &&
      (!channels.size || channels.has(delivery.channel)) &&
      (!accounts.size || accounts.has(delivery.accountId)),
  );
  const deliveriesByPost = new Map<string, SignalCampaignAnalyticsDelivery[]>();
  for (const delivery of deliveries)
    deliveriesByPost.set(delivery.postId, [
      ...(deliveriesByPost.get(delivery.postId) ?? []),
      delivery,
    ]);

  /** Posts per campaign, and the `null` key for the posts carrying none. */
  const grouped = new Map<string | null, SignalCampaignAnalyticsPost[]>();
  const named = new Map<string, SignalCampaign>();
  for (const post of posts) {
    const keys: (string | null)[] = post.campaigns.length
      ? post.campaigns
          // A campaign filter narrows which campaigns a post is *reported under*, not only which
          // posts are in scope: asking about one campaign and being shown the others a post also
          // carries would answer a question nobody asked.
          .filter((campaign) => !wanted.size || wanted.has(campaign.id))
          .map((campaign) => {
            named.set(campaign.id, campaign);
            return campaign.id;
          })
      : [null];
    for (const key of keys) grouped.set(key, [...(grouped.get(key) ?? []), post]);
  }

  const groupFor = (
    key: string | null,
    members: SignalCampaignAnalyticsPost[],
  ): SignalCampaignAnalyticsGroup => {
    const own = members.flatMap((post) => deliveriesByPost.get(post.id) ?? []);
    const campaign = key === null ? undefined : named.get(key);
    const totals = totalsOf(own);
    return {
      campaignId: key,
      name: campaign?.name ?? SIGNAL_CAMPAIGN_NONE_LABEL,
      ...(campaign?.color ? { color: campaign.color } : {}),
      ...scopeOf(members, own),
      ...(totals ? { totals } : {}),
      trend: signalCampaignTrend(own),
    };
  };

  const groups = [...grouped.entries()]
    .filter(([key]) => key !== null)
    .map(([key, members]) => groupFor(key, members))
    .sort((left, right) =>
      compareSignalCampaigns(
        { id: left.campaignId as string, name: left.name },
        { id: right.campaignId as string, name: right.name },
      ),
    );
  const uncategorized = grouped.get(null);
  // Last, and only when it has posts: it is a residue rather than a campaign, and an empty row
  // saying so would be one more thing to read on every workspace that has no unclassified posts.
  if (uncategorized) groups.push(groupFor(null, uncategorized));

  const totals = totalsOf(deliveries);
  const offeredAccounts = new Map<number, SignalCampaignAnalyticsAccount>();
  for (const delivery of input.deliveries)
    if (!offeredAccounts.has(delivery.accountId))
      offeredAccounts.set(delivery.accountId, {
        accountId: delivery.accountId,
        channel: delivery.channel,
        handle: delivery.handle,
      });
  return {
    filters,
    groups,
    scope: scopeOf(posts, deliveries),
    ...(totals ? { totals } : {}),
    trend: signalCampaignTrend(deliveries),
    channels: [...new Set(input.deliveries.map((delivery) => delivery.channel))].sort(),
    accounts: [...offeredAccounts.values()].sort((left, right) => left.accountId - right.accountId),
    campaigns: [...input.campaigns].sort(compareSignalCampaigns),
  };
}

/** The largest gain on any day of a trend, which is what a compact bar row is scaled against. */
export const signalCampaignTrendPeak = (
  trend: readonly PostMetricDay[],
  metric: (typeof ANALYTICS_METRICS)[number],
): number => trend.reduce((peak, day) => Math.max(peak, day[metric]), 0);
