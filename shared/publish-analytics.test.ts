import { describe, expect, it } from 'vitest';
import {
  analyticsBackoffSeconds,
  analyticsPlatformSupported,
  analyticsRefreshGate,
  postMetricAvailability,
  postMetricDayDeltas,
  postMetricsMeasurable,
  ANALYTICS_BACKOFF_CAP_SECONDS,
  ANALYTICS_BACKOFF_MAX_ATTEMPTS,
  ANALYTICS_METRIC_LABEL,
  ANALYTICS_METRICS,
  ANALYTICS_PLATFORMS,
  POST_METRIC_AVAILABILITIES,
  POST_METRIC_AVAILABILITY_DETAIL,
  POST_METRIC_AVAILABILITY_LABEL,
  type PostMetricsSummary,
  type PostTargetMetrics,
} from './publish-analytics.ts';
import { PUBLISH_CHANNEL_STATUS_LABEL } from './publish.ts';
import { PUBLISH_PLATFORMS, SIGNAL_CHANNEL_PLATFORM } from './publish-capabilities.ts';

const target = (overrides: Partial<PostTargetMetrics> = {}): PostTargetMetrics => ({
  publicationId: 'publication-1',
  accountId: 1,
  channel: 'tt',
  platform: 'tiktok',
  handle: '@gholmes',
  availability: 'AVAILABLE',
  days: [],
  ...overrides,
});

describe('which platforms carry figures', () => {
  /**
   * The list is the provider's, and the test says where it came from: the `platform` enum on
   * `POST /v1/analytics/sync`. Pinning it here means a future edit to the constant has to be a
   * deliberate claim about the vendor rather than a convenience.
   */
  it('is exactly the three platforms the sync endpoint enumerates', () => {
    expect([...ANALYTICS_PLATFORMS]).toEqual(['tiktok', 'youtube', 'instagram']);
    for (const platform of ANALYTICS_PLATFORMS) expect(PUBLISH_PLATFORMS).toContain(platform);
  });

  it('answers for every platform the publishing contract knows, and for a channel with none', () => {
    for (const platform of PUBLISH_PLATFORMS)
      expect(analyticsPlatformSupported(platform)).toBe(
        (ANALYTICS_PLATFORMS as readonly string[]).includes(platform),
      );
    // `blog` maps to no platform at all, and a null is unmeasured for the same reason it is
    // unpublishable rather than for a separate one.
    expect(SIGNAL_CHANNEL_PLATFORM.blog).toBeNull();
    expect(analyticsPlatformSupported(null)).toBe(false);
    expect(analyticsPlatformSupported('twitter')).toBe(false);
  });

  it('reaches every Signal channel that has a measured platform', () => {
    const measured = Object.entries(SIGNAL_CHANNEL_PLATFORM)
      .filter(([, platform]) => analyticsPlatformSupported(platform))
      .map(([channel]) => channel);
    // Three provider platforms, three Signal channels planned for them. A channel added later for
    // one of them is covered by the same map rather than by a second list.
    expect(measured.sort()).toEqual(['ig', 'tt', 'yt']);
  });
});

describe('the four figures', () => {
  it('names all four and labels each of them', () => {
    expect([...ANALYTICS_METRICS]).toEqual(['views', 'likes', 'comments', 'shares']);
    for (const metric of ANALYTICS_METRICS) expect(ANALYTICS_METRIC_LABEL[metric]).toBeTruthy();
  });
});

describe('what can be said about one delivery', () => {
  it('reports an unmeasured platform as unavailable whatever else is true of it', () => {
    // A stored reading and a result identity do not make a blog measurable. The order of the
    // questions is the point: getting it wrong would show "no figures yet" for ever.
    expect(postMetricAvailability({ platform: null, resultId: 'result-1', stored: true })).toBe(
      'NOT_AVAILABLE',
    );
    expect(
      postMetricAvailability({ platform: 'twitter', resultId: 'result-1', stored: true }),
    ).toBe('NOT_AVAILABLE');
  });

  it('separates a missing result identity from a provider that has nothing yet', () => {
    expect(postMetricAvailability({ platform: 'tiktok', stored: false })).toBe('AWAITING_RESULT');
    expect(
      postMetricAvailability({ platform: 'tiktok', resultId: 'result-1', stored: false }),
    ).toBe('AWAITING_SYNC');
    expect(postMetricAvailability({ platform: 'tiktok', resultId: 'result-1', stored: true })).toBe(
      'AVAILABLE',
    );
  });

  it('uses the publishing contract’s own sentence for a channel this provider does not reach', () => {
    // One sentence for one claim. Two copies would eventually be two different sentences.
    expect(POST_METRIC_AVAILABILITY_LABEL.NOT_AVAILABLE).toBe('Not available from this provider');
    expect(POST_METRIC_AVAILABILITY_LABEL.NOT_AVAILABLE).toBe(
      PUBLISH_CHANNEL_STATUS_LABEL.NOT_AVAILABLE,
    );
    // And every state says something: a state with an empty explanation would render as a blank.
    for (const availability of POST_METRIC_AVAILABILITIES) {
      expect(POST_METRIC_AVAILABILITY_LABEL[availability]).toBeTruthy();
      expect(POST_METRIC_AVAILABILITY_DETAIL[availability]).toBeTruthy();
    }
    // The unavailable sentence says a count of zero is not what this is.
    expect(POST_METRIC_AVAILABILITY_DETAIL.NOT_AVAILABLE).toMatch(/different from a count of zero/);
  });

  it('knows whether a post has anything worth refreshing', () => {
    const summary = (targets: PostTargetMetrics[]): PostMetricsSummary => ({
      postId: 'post-1',
      targets,
      refresh: { allowed: true, attempts: 0, exhausted: false },
    });
    expect(postMetricsMeasurable(summary([]))).toBe(false);
    expect(
      postMetricsMeasurable(
        summary([target({ channel: 'x', platform: 'twitter', availability: 'NOT_AVAILABLE' })]),
      ),
    ).toBe(false);
    expect(postMetricsMeasurable(summary([target({ availability: 'AWAITING_SYNC' })]))).toBe(true);
  });
});

describe('per-day gains from stored snapshots', () => {
  const days = [
    { date: '2026-08-10', views: 100, likes: 10, comments: 2, shares: 1 },
    { date: '2026-08-11', views: 180, likes: 14, comments: 3, shares: 1 },
    { date: '2026-08-12', views: 200, likes: 20, comments: 3, shares: 4 },
  ];

  it('subtracts consecutive days and leaves the earliest one out', () => {
    expect(postMetricDayDeltas(days)).toEqual([
      { date: '2026-08-11', views: 80, likes: 4, comments: 1, shares: 0 },
      { date: '2026-08-12', views: 20, likes: 6, comments: 0, shares: 3 },
    ]);
  });

  it('orders before subtracting, so a snapshot stored out of order is still right', () => {
    expect(postMetricDayDeltas([days[2], days[0], days[1]] as typeof days)).toEqual(
      postMetricDayDeltas(days),
    );
  });

  it('has nothing to say about one day, or none', () => {
    expect(postMetricDayDeltas([])).toEqual([]);
    expect(postMetricDayDeltas([days[0]] as typeof days)).toEqual([]);
  });

  it('keeps a count the platform revised downwards', () => {
    // A deleted comment is a real fact. Clamping it to zero would report growth that did not happen.
    const revised = [
      { date: '2026-08-10', views: 100, likes: 10, comments: 5, shares: 1 },
      { date: '2026-08-11', views: 100, likes: 10, comments: 3, shares: 1 },
    ];
    expect(postMetricDayDeltas(revised)[0]?.comments).toBe(-2);
  });
});

describe('bounded backoff', () => {
  it('doubles the window per attempt and caps it', () => {
    // Full jitter at its maximum is the window itself, which is what makes the window testable.
    expect([1, 2, 3, 4, 5].map((attempt) => analyticsBackoffSeconds(attempt, 1))).toEqual([
      1, 2, 4, 8, 16,
    ]);
    // Beyond the bound the window stops growing, and it never exceeds the cap §9 sets.
    expect(analyticsBackoffSeconds(ANALYTICS_BACKOFF_MAX_ATTEMPTS + 40, 1)).toBeLessThanOrEqual(
      ANALYTICS_BACKOFF_CAP_SECONDS,
    );
  });

  it('waits a random point inside the window, and never nothing', () => {
    // Full jitter: the wait is somewhere in (0, window], and a computed zero is not a wait at all —
    // the provider's complaint was that this app asked too soon.
    expect(analyticsBackoffSeconds(4, 0)).toBe(1);
    expect(analyticsBackoffSeconds(4, 0.5)).toBe(4);
    expect(analyticsBackoffSeconds(4, -3)).toBe(1);
    expect(analyticsBackoffSeconds(4, 9)).toBe(8);
  });
});

describe('the refresh gate', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('allows a workspace that has never synchronised', () => {
    expect(analyticsRefreshGate(undefined, now)).toEqual({
      allowed: true,
      attempts: 0,
      exhausted: false,
    });
  });

  it('refuses while a wait is in force and says how long is left', () => {
    const gate = analyticsRefreshGate(
      { waitingUntil: '2026-08-19T12:00:30.000Z', attempts: 2 },
      now,
    );
    expect(gate.allowed).toBe(false);
    expect(gate.retryAfterSeconds).toBe(30);
    expect(gate.reason).toContain('2026-08-19T12:00:30.000Z');
  });

  it('allows again once the wait has passed, even after the bound', () => {
    // The bound is reported to the person rather than enforced against them: a manual refresh is the
    // escape hatch from every schedule in this app (§9).
    const gate = analyticsRefreshGate(
      {
        waitingUntil: '2026-08-19T11:59:00.000Z',
        attempts: ANALYTICS_BACKOFF_MAX_ATTEMPTS,
      },
      now,
    );
    expect(gate.allowed).toBe(true);
    expect(gate.exhausted).toBe(true);
    expect(gate.reason).toContain('refused the last');
  });
});
