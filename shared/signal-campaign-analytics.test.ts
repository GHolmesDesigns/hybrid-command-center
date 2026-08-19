import { describe, expect, it } from 'vitest';
import {
  summariseSignalCampaignAnalytics,
  signalCampaignTrend,
  signalCampaignTrendPeak,
  SIGNAL_CAMPAIGN_NONE,
  SIGNAL_CAMPAIGN_NONE_LABEL,
  type SignalCampaignAnalyticsDelivery,
  type SignalCampaignAnalyticsFilters,
  type SignalCampaignAnalyticsInput,
  type SignalCampaignAnalyticsPost,
} from './signal-campaign-analytics.ts';
import type { PostMetricDay, PostMetricTotals } from './publish-analytics.ts';
import type { SignalCampaign } from './signal.ts';

/**
 * The rules behind campaign figures, against fixtures.
 *
 * Everything here is about what the addition is allowed to claim: that a group's total covers only
 * the deliveries it names, that an unmeasured group has no total at all rather than a row of zeros,
 * that a post in two campaigns is not counted twice at the top level, and that a range is a question
 * about posts rather than about days.
 */

const clarity: SignalCampaign = { id: 'c-clarity', name: 'Clarity Campaign', color: '#315f79' };
const explain: SignalCampaign = { id: 'c-explain', name: 'Explain It Clearly' };
const week: SignalCampaign = { id: 'c-week', name: 'Wk1' };

const post = (
  id: string,
  date: string | null,
  campaigns: SignalCampaign[] = [],
): SignalCampaignAnalyticsPost => ({ id, name: `Post ${id}`, date, campaigns });

const totals = (views: number): PostMetricTotals => ({
  views,
  likes: views / 10,
  comments: views / 100,
  shares: views / 50,
});

const delivery = (
  postId: string,
  overrides: Partial<SignalCampaignAnalyticsDelivery> = {},
): SignalCampaignAnalyticsDelivery => ({
  postId,
  publicationId: `pub-${postId}`,
  accountId: 904,
  channel: 'tt',
  handle: '@gholmes',
  days: [],
  ...overrides,
});

const noFilters: SignalCampaignAnalyticsFilters = {
  campaignIds: [],
  channels: [],
  accountIds: [],
  from: null,
  to: null,
};

const summarise = (
  input: Partial<SignalCampaignAnalyticsInput>,
  filters: Partial<SignalCampaignAnalyticsFilters> = {},
) =>
  summariseSignalCampaignAnalytics(
    { posts: [], deliveries: [], campaigns: [], ...input },
    { ...noFilters, ...filters },
  );

const day = (date: string, views: number): PostMetricDay => ({ date, ...totals(views) });

describe('per-day gains across a set of deliveries', () => {
  it('sums each provider day label, counting only the deliveries that snapshotted it', () => {
    const trend = signalCampaignTrend([
      delivery('a', { days: [day('2026-09-01', 100), day('2026-09-02', 300)] }),
      // Starts a day later, so it contributes nothing to the 2nd and 200 to the 3rd.
      delivery('b', { days: [day('2026-09-02', 50), day('2026-09-03', 250)] }),
    ]);
    expect(trend.map((entry) => [entry.date, entry.views])).toEqual([
      ['2026-09-02', 200],
      ['2026-09-03', 200],
    ]);
  });

  it('invents no day between two snapshots, and keeps a revision downwards as it comes', () => {
    const trend = signalCampaignTrend([
      // A gap between the 1st and the 4th subtracts across the gap rather than spreading it.
      delivery('a', { days: [day('2026-09-01', 100), day('2026-09-04', 400)] }),
      delivery('b', { days: [day('2026-09-04', 500), day('2026-09-05', 300)] }),
    ]);
    expect(trend.map((entry) => [entry.date, entry.views])).toEqual([
      ['2026-09-04', 300],
      ['2026-09-05', -200],
    ]);
  });

  it('has no trend at all for a delivery with a single snapshot', () => {
    expect(signalCampaignTrend([delivery('a', { days: [day('2026-09-01', 100)] })])).toEqual([]);
  });

  it('scales a bar row against the largest gain, and against nothing when every gain is zero', () => {
    const trend = signalCampaignTrend([
      delivery('a', { days: [day('2026-09-01', 100), day('2026-09-02', 900)] }),
    ]);
    expect(signalCampaignTrendPeak(trend, 'views')).toBe(800);
    expect(signalCampaignTrendPeak([], 'views')).toBe(0);
  });
});

describe('grouping figures by campaign', () => {
  it('groups a post under every campaign it carries, and counts each delivery once overall', () => {
    const summary = summarise({
      posts: [post('a', '2026-09-01', [clarity, week])],
      deliveries: [delivery('a', { totals: totals(1000) })],
      campaigns: [clarity, week],
    });

    expect(summary.groups.map((group) => group.name)).toEqual(['Clarity Campaign', 'Wk1']);
    // The same delivery in both groups, because the post is in both campaigns.
    expect(summary.groups.map((group) => group.totals?.views)).toEqual([1000, 1000]);
    // And once at the top, because there is one delivery. Summing the groups would say 2000.
    expect(summary.totals?.views).toBe(1000);
    expect(summary.scope).toEqual({ posts: 1, deliveries: 1, measuredDeliveries: 1 });
  });

  it('gives a group with nothing measured no totals rather than a set of zeros', () => {
    const summary = summarise({
      posts: [post('a', '2026-09-01', [clarity])],
      deliveries: [delivery('a')],
      campaigns: [clarity],
    });
    expect(summary.groups[0]).toMatchObject({ deliveries: 1, measuredDeliveries: 0 });
    expect(summary.groups[0]).not.toHaveProperty('totals');
    expect(summary).not.toHaveProperty('totals');
  });

  it('counts a delivery whose every figure is zero as measured, because zero is a reading', () => {
    const summary = summarise({
      posts: [post('a', '2026-09-01', [clarity])],
      deliveries: [delivery('a', { totals: totals(0) })],
      campaigns: [clarity],
    });
    expect(summary.groups[0]?.measuredDeliveries).toBe(1);
    expect(summary.totals).toEqual({ views: 0, likes: 0, comments: 0, shares: 0 });
  });

  it('puts unclassified posts under No campaign, last, and only when there are some', () => {
    const withNone = summarise({
      posts: [post('a', '2026-09-01', [explain]), post('b', '2026-09-02')],
      campaigns: [explain],
    });
    expect(withNone.groups.map((group) => group.name)).toEqual([
      'Explain It Clearly',
      SIGNAL_CAMPAIGN_NONE_LABEL,
    ]);
    expect(withNone.groups.at(-1)?.campaignId).toBeNull();

    const withoutNone = summarise({
      posts: [post('a', '2026-09-01', [explain])],
      campaigns: [explain],
    });
    expect(withoutNone.groups.map((group) => group.campaignId)).toEqual([explain.id]);
  });

  it('orders campaigns by name, case- and accent-insensitively, and carries a colour through', () => {
    const summary = summarise({
      posts: [post('a', null, [week]), post('b', null, [explain]), post('c', null, [clarity])],
      campaigns: [week, explain, clarity],
    });
    expect(summary.groups.map((group) => group.name)).toEqual([
      'Clarity Campaign',
      'Explain It Clearly',
      'Wk1',
    ]);
    expect(summary.groups[0]?.color).toBe('#315f79');
    expect(summary.groups[2]).not.toHaveProperty('color');
  });

  it('lists every campaign in the workspace, so the filter can name one with no posts', () => {
    const summary = summarise({ posts: [post('a', null)], campaigns: [clarity, explain] });
    expect(summary.campaigns.map((campaign) => campaign.name)).toEqual([
      'Clarity Campaign',
      'Explain It Clearly',
    ]);
    expect(summary.groups.map((group) => group.campaignId)).toEqual([null]);
  });
});

describe('the filters', () => {
  const workspace: SignalCampaignAnalyticsInput = {
    posts: [
      post('a', '2026-09-01', [clarity]),
      post('b', '2026-09-20', [explain]),
      post('c', null),
      post('d', '2026-09-10', [clarity, explain]),
    ],
    deliveries: [
      delivery('a', { totals: totals(1000) }),
      delivery('b', { channel: 'yt', accountId: 905, handle: '@channel', totals: totals(200) }),
      delivery('d', { totals: totals(30) }),
      delivery('d', { channel: 'x', accountId: 901, handle: '@gholmes' }),
    ],
    campaigns: [clarity, explain],
  };

  it('reads several campaigns as or, and reports a post only under the ones asked for', () => {
    const summary = summariseSignalCampaignAnalytics(workspace, {
      ...noFilters,
      campaignIds: [clarity.id],
    });
    // Post `d` is in both campaigns, and is reported only under the one the filter named.
    expect(summary.groups.map((group) => [group.name, group.posts])).toEqual([
      ['Clarity Campaign', 2],
    ]);

    const both = summariseSignalCampaignAnalytics(workspace, {
      ...noFilters,
      campaignIds: [clarity.id, explain.id],
    });
    expect(both.groups.map((group) => [group.name, group.posts])).toEqual([
      ['Clarity Campaign', 2],
      ['Explain It Clearly', 2],
    ]);
    // Three distinct posts across the two groups, counted once each at the top.
    expect(both.scope.posts).toBe(3);
  });

  it('asks for the unclassified posts by name', () => {
    const summary = summariseSignalCampaignAnalytics(workspace, {
      ...noFilters,
      campaignIds: [SIGNAL_CAMPAIGN_NONE],
    });
    expect(summary.groups.map((group) => [group.name, group.posts])).toEqual([
      [SIGNAL_CAMPAIGN_NONE_LABEL, 1],
    ]);
  });

  it('narrows to a channel and to an account without dropping the posts from the count', () => {
    const byChannel = summariseSignalCampaignAnalytics(workspace, {
      ...noFilters,
      channels: ['tt'],
    });
    expect(byChannel.scope).toEqual({ posts: 4, deliveries: 2, measuredDeliveries: 2 });
    expect(byChannel.totals?.views).toBe(1030);

    const byAccount = summariseSignalCampaignAnalytics(workspace, {
      ...noFilters,
      accountIds: [905],
    });
    expect(byAccount.totals?.views).toBe(200);
    // Post `a` is still a post in Clarity Campaign, with nothing measured on the asked-about
    // account — dropping it would answer a question about deliveries with a count of posts.
    expect(
      byAccount.groups.map((group) => [group.name, group.posts, group.measuredDeliveries]),
    ).toEqual([
      ['Clarity Campaign', 2, 0],
      ['Explain It Clearly', 2, 1],
      [SIGNAL_CAMPAIGN_NONE_LABEL, 1, 0],
    ]);
  });

  it('bounds by the post’s own date, one end at a time, leaving the queue out of every range', () => {
    expect(
      summariseSignalCampaignAnalytics(workspace, { ...noFilters, from: '2026-09-05' }).scope.posts,
    ).toBe(2);
    expect(
      summariseSignalCampaignAnalytics(workspace, { ...noFilters, to: '2026-09-10' }).scope.posts,
    ).toBe(2);
    expect(
      summariseSignalCampaignAnalytics(workspace, {
        ...noFilters,
        from: '2026-09-01',
        to: '2026-09-01',
      }).scope.posts,
    ).toBe(1);
    // With no range at all the undated post is in scope; with either end it is in none.
    expect(summariseSignalCampaignAnalytics(workspace, noFilters).scope.posts).toBe(4);
  });

  it('offers every channel and account the workspace has delivered to, whatever is filtered', () => {
    const summary = summariseSignalCampaignAnalytics(workspace, { ...noFilters, channels: ['tt'] });
    expect(summary.channels).toEqual(['tt', 'x', 'yt']);
    expect(summary.accounts).toEqual([
      { accountId: 901, channel: 'x', handle: '@gholmes' },
      { accountId: 904, channel: 'tt', handle: '@gholmes' },
      { accountId: 905, channel: 'yt', handle: '@channel' },
    ]);
  });

  it('echoes what it was asked, so a reader can tell an empty answer from an unfiltered one', () => {
    const filters = { ...noFilters, campaignIds: [clarity.id], from: '2026-09-01' };
    expect(summariseSignalCampaignAnalytics(workspace, filters).filters).toEqual(filters);
  });

  it('answers an empty workspace with no groups and no totals', () => {
    const summary = summarise({});
    expect(summary.groups).toEqual([]);
    expect(summary.trend).toEqual([]);
    expect(summary).not.toHaveProperty('totals');
    expect(summary.scope).toEqual({ posts: 0, deliveries: 0, measuredDeliveries: 0 });
  });
});
