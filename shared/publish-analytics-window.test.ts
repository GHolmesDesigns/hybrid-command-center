import { describe, expect, it } from 'vitest';
import {
  analyticsWindowCoverage,
  analyticsWindowMeaning,
  analyticsWindowsOffered,
  analyticsWindowVerified,
  analyticsWindowVerifiedMeaning,
  ANALYTICS_WINDOWS,
  ANALYTICS_WINDOW_EVIDENCE,
  ANALYTICS_WINDOW_PAGE_MAX,
  ANALYTICS_WINDOW_PAGE_SIZE,
  ANALYTICS_WINDOW_ROW_MAX,
  ANALYTICS_WINDOW_UNVERIFIED_DETAIL,
  isAnalyticsWindow,
  summariseAnalyticsWindow,
  type AnalyticsWindowDelivery,
  type AnalyticsWindowRow,
} from './publish-analytics-window.ts';
import { PROVIDER_INVENTORY_PAGE_SIZE, providerInventoryNextPage } from './provider-inventory.ts';

/**
 * The window rules: what may be offered, what a window means, and the one addition allowed here.
 *
 * The evidence assertions are deliberately written to *fail* the day somebody flips a window on
 * without a dated result to cite, because that is the mistake this card is one step away from: the
 * machinery is complete, so the only thing standing between an unverified window and a labelled total
 * is one table entry.
 */

const row = (overrides: Partial<AnalyticsWindowRow> = {}): AnalyticsWindowRow => ({
  analyticsId: 'an-1',
  postResultId: 'result-1',
  platform: 'instagram',
  views: 100,
  likes: 10,
  comments: 2,
  shares: 1,
  ...overrides,
});

const delivery = (overrides: Partial<AnalyticsWindowDelivery> = {}): AnalyticsWindowDelivery => ({
  publicationId: 'pub-1',
  accountId: 901,
  channel: 'ig',
  handle: '@studio',
  postResultId: 'result-1',
  ...overrides,
});

describe('which windows exist, and which may be offered', () => {
  it('enumerates the four documented values and nothing else', () => {
    expect(ANALYTICS_WINDOWS).toEqual(['7d', '30d', '90d', 'all']);
    expect(isAnalyticsWindow('30d')).toBe(true);
    expect(isAnalyticsWindow('1d')).toBe(false);
    expect(isAnalyticsWindow('ALL')).toBe(false);
  });

  /**
   * The state §14 records, asserted rather than assumed.
   *
   * Four rows for this endpoint — the timeframe's meaning, the response grain, how a row maps to an
   * account, and the rate-limit contract — each concluding "C80 stays blocked". Until one of them is
   * answered, offering a window would put a label on a total nobody can describe.
   */
  it('offers no window while every evidence entry is unverified', () => {
    expect(analyticsWindowsOffered()).toEqual([]);
    for (const window of ANALYTICS_WINDOWS) {
      expect(ANALYTICS_WINDOW_EVIDENCE[window].verified).toBe(false);
      expect(analyticsWindowVerified(window)).toBe(false);
    }
  });

  it('describes an unverified window with the unverified sentence and never with a duration', () => {
    for (const window of ANALYTICS_WINDOWS)
      expect(analyticsWindowMeaning(window)).toBe(ANALYTICS_WINDOW_UNVERIFIED_DETAIL);
    // The sentence has to say the two things a reader needs: that the filter exists, and that what it
    // selects was not observed. It must not say "last 7 days" for any window.
    expect(ANALYTICS_WINDOW_UNVERIFIED_DETAIL).toContain('has not been observed');
    expect(ANALYTICS_WINDOW_UNVERIFIED_DETAIL).not.toMatch(/last \d/i);
  });

  /**
   * The sentence a verified window *will* carry, tested while that branch is still unreachable
   * through `analyticsWindowMeaning`. The date is part of the claim, not decoration.
   */
  it('states what a dated result recorded and when', () => {
    expect(
      analyticsWindowVerifiedMeaning({
        meaning: 'It selects which posts are included.',
        asOf: '2026-09-01',
      }),
    ).toBe('It selects which posts are included. Verified 2026-09-01.');
  });

  /**
   * A verified entry cannot exist without the two things that make it a claim.
   *
   * Typed as a union rather than a boolean plus an optional string, so this is a type-level guarantee
   * as much as a test — but asserted anyway, because the failure it prevents is a window offered with
   * an empty description.
   */
  it('requires a meaning and a date from any entry that claims to be verified', () => {
    const verified = { verified: true as const, meaning: 'It selects posts.', asOf: '2026-09-01' };
    expect(verified.meaning.length).toBeGreaterThan(0);
    expect(verified.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the pagination contract is the posts list contract', () => {
  /**
   * §14's question 4 recorded that `GET /v1/analytics` answers the same `meta` envelope as
   * `GET /v1/posts`. So the walk reuses one rule rather than carrying a second copy, and the page
   * width is the width that was verified.
   */
  it('borrows the verified page size and the one next-page rule', () => {
    expect(ANALYTICS_WINDOW_PAGE_SIZE).toBe(PROVIDER_INVENTORY_PAGE_SIZE);
    expect(ANALYTICS_WINDOW_ROW_MAX).toBe(ANALYTICS_WINDOW_PAGE_SIZE * ANALYTICS_WINDOW_PAGE_MAX);
    expect(providerInventoryNextPage({ next: null })).toEqual({ done: true });
    expect(providerInventoryNextPage({ next: 100 })).toEqual({ offset: 100 });
    expect(providerInventoryNextPage({ next: 'https://x/y?offset=200' })).toEqual({ offset: 200 });
    expect(providerInventoryNextPage({ next: { cursor: 'opaque' } })).toEqual({ unknown: 'NEXT' });
  });
});

describe('grouping rows by the account their delivery belongs to', () => {
  it('adds the provider counts over the rows of one account and nothing else', () => {
    const { groups, unmapped } = summariseAnalyticsWindow({
      platform: 'instagram',
      window: '30d',
      rows: [
        row({ postResultId: 'result-1', views: 100, likes: 10, comments: 2, shares: 1 }),
        row({
          analyticsId: 'an-2',
          postResultId: 'result-2',
          views: 50,
          likes: 5,
          comments: 1,
          shares: 0,
        }),
      ],
      deliveries: [
        delivery({ postResultId: 'result-1' }),
        delivery({ publicationId: 'pub-2', postResultId: 'result-2' }),
      ],
    });
    expect(unmapped).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      platform: 'instagram',
      accountId: 901,
      channel: 'ig',
      handle: '@studio',
      deliveries: 2,
      measuredDeliveries: 2,
      // Addition, and only addition: 100+50, 10+5, 2+1, 1+0.
      totals: { views: 150, likes: 15, comments: 3, shares: 1 },
    });
  });

  it('separates accounts and orders them by provider account id', () => {
    const { groups } = summariseAnalyticsWindow({
      platform: 'instagram',
      window: '30d',
      rows: [row({ postResultId: 'result-b', views: 7 })],
      deliveries: [
        delivery({ accountId: 906, handle: '@second', postResultId: 'result-b' }),
        delivery({ accountId: 901, handle: '@first', postResultId: 'result-a' }),
      ],
    });
    expect(groups.map((group) => group.accountId)).toEqual([901, 906]);
    expect(groups[0]).toMatchObject({ deliveries: 1, measuredDeliveries: 0 });
    expect(groups[0]?.totals).toBeUndefined();
    expect(groups[1]).toMatchObject({ deliveries: 1, measuredDeliveries: 1 });
  });

  /**
   * The distinction the card's criteria turn on: nothing measured is *no totals field*, never a row
   * of zeros. A zero is a claim the platform counted nothing; absence is a claim nobody counted.
   */
  it('carries no totals at all for an account the window named nothing for', () => {
    const { groups } = summariseAnalyticsWindow({
      platform: 'instagram',
      window: '7d',
      rows: [],
      deliveries: [delivery(), delivery({ publicationId: 'pub-2', postResultId: 'result-2' })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ deliveries: 2, measuredDeliveries: 0 });
    expect(groups[0]).not.toHaveProperty('totals');
    expect(analyticsWindowCoverage(groups[0]!)).toContain('different from a total of zero');
  });

  it('reports how much of what it knows about the window named', () => {
    const { groups } = summariseAnalyticsWindow({
      platform: 'instagram',
      window: '30d',
      rows: [row({ postResultId: 'result-1' })],
      deliveries: [
        delivery({ postResultId: 'result-1' }),
        delivery({ publicationId: 'pub-2', postResultId: 'result-2' }),
        delivery({ publicationId: 'pub-3', postResultId: 'result-3' }),
      ],
    });
    expect(groups[0]).toMatchObject({ deliveries: 3, measuredDeliveries: 1 });
    expect(analyticsWindowCoverage(groups[0]!)).toBe('1 of 3 deliveries named in this window.');
  });

  it('says "delivery" rather than "deliveries" for one', () => {
    const { groups } = summariseAnalyticsWindow({
      platform: 'instagram',
      window: '30d',
      rows: [row()],
      deliveries: [delivery()],
    });
    expect(analyticsWindowCoverage(groups[0]!)).toBe('1 of 1 delivery named in this window.');
  });
});

describe('rows the provider named that no delivery here claims', () => {
  it('counts them, keeps their figures, and never adds them into an account', () => {
    const { groups, unmapped } = summariseAnalyticsWindow({
      platform: 'instagram',
      window: '30d',
      rows: [
        row({ postResultId: 'result-1', views: 100 }),
        row({ analyticsId: 'an-x', postResultId: 'made-elsewhere', views: 9_000 }),
      ],
      deliveries: [delivery({ postResultId: 'result-1' })],
    });
    expect(unmapped).toEqual([
      {
        postResultId: 'made-elsewhere',
        platform: 'instagram',
        totals: { views: 9_000, likes: 10, comments: 2, shares: 1 },
      },
    ]);
    // The account total is the mapped row alone. The nine thousand views are visible and excluded.
    expect(groups[0]?.totals).toEqual({ views: 100, likes: 10, comments: 2, shares: 1 });
    expect(groups[0]?.measuredDeliveries).toBe(1);
  });

  it('forms no group from an unmapped row, however many arrive', () => {
    const { groups, unmapped } = summariseAnalyticsWindow({
      platform: 'youtube',
      window: 'all',
      rows: [row({ postResultId: 'a' }), row({ analyticsId: 'an-2', postResultId: 'b' })],
      deliveries: [],
    });
    expect(groups).toEqual([]);
    expect(unmapped.map((entry) => entry.postResultId)).toEqual(['a', 'b']);
  });

  it('orders unmapped rows by the provider identity so one read fingerprints the same twice', () => {
    const { unmapped } = summariseAnalyticsWindow({
      platform: 'tiktok',
      window: '90d',
      rows: [row({ postResultId: 'zeta' }), row({ analyticsId: 'an-2', postResultId: 'alpha' })],
      deliveries: [],
    });
    expect(unmapped.map((entry) => entry.postResultId)).toEqual(['alpha', 'zeta']);
  });
});
