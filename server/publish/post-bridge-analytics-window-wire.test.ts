import { describe, expect, it } from 'vitest';
import {
  parsePostBridgeAnalyticsWindowPage,
  parsePostBridgeAnalyticsWindowRow,
  postBridgeAnalyticsWindowPath,
} from './post-bridge-analytics-window-wire.ts';
import { PublishProviderError } from './provider.ts';
import { ANALYTICS_WINDOW_PAGE_SIZE } from '../../shared/publish-analytics-window.ts';

/**
 * The window request, and how a page of it is read.
 *
 * Covered against fixtures because the live adapter is `fetch` and a bearer token. What matters most
 * here is the refusal on a row with no `post_result_id`: §14 records the response grain as unverified,
 * so a row that cannot be attributed might be an account aggregate — and quietly dropping it would
 * turn an aggregate into a plausible-looking partial window.
 */

const body = (rows: unknown[], meta: unknown = { next: null }) => ({ data: rows, meta });

const wireRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'an-1',
  post_result_id: 'result-1',
  platform: 'instagram',
  view_count: 100,
  like_count: 10,
  comment_count: 2,
  share_count: 1,
  ...overrides,
});

describe('the path one window page is asked for at', () => {
  it('sends the platform, the window, and an explicit page', () => {
    expect(
      postBridgeAnalyticsWindowPath({
        platform: 'instagram',
        timeframe: '30d',
        limit: ANALYTICS_WINDOW_PAGE_SIZE,
        offset: 0,
      }),
    ).toBe('/analytics?platform=instagram&timeframe=30d&limit=100&offset=0');
  });

  it('carries the offset the walk asked for', () => {
    expect(
      postBridgeAnalyticsWindowPath({
        platform: 'tiktok',
        timeframe: 'all',
        limit: 100,
        offset: 200,
      }),
    ).toBe('/analytics?platform=tiktok&timeframe=all&limit=100&offset=200');
  });

  /**
   * No `post_result_id` on this path, which is the whole difference from the per-delivery request.
   * Sending both would ask two questions at once and the answer would belong to neither store.
   */
  it('never asks about a named delivery', () => {
    const path = postBridgeAnalyticsWindowPath({
      platform: 'youtube',
      timeframe: '7d',
      limit: 100,
      offset: 0,
    });
    expect(path).not.toContain('post_result_id');
  });
});

describe('reading one row', () => {
  it('translates the vendor’s field names into this app’s vocabulary', () => {
    expect(parsePostBridgeAnalyticsWindowRow(wireRow(), [])).toEqual({
      analyticsId: 'an-1',
      postResultId: 'result-1',
      platform: 'instagram',
      views: 100,
      likes: 10,
      comments: 2,
      shares: 1,
    });
  });

  it('keeps the provider’s own synchronisation instant where it sent one', () => {
    const parsed = parsePostBridgeAnalyticsWindowRow(
      wireRow({ last_synced_at: '2026-08-22T21:59:34.000Z' }),
      [],
    );
    expect(parsed.providerSyncedAt).toBe('2026-08-22T21:59:34.000Z');
  });

  it('reads a missing count as zero from the provider rather than as no reading', () => {
    const parsed = parsePostBridgeAnalyticsWindowRow(
      { id: 'an-1', post_result_id: 'result-1', platform: 'instagram' },
      [],
    );
    expect(parsed).toMatchObject({ views: 0, likes: 0, comments: 0, shares: 0 });
  });

  /**
   * The fail-closed reading of the unverified grain claim.
   */
  it('refuses a row carrying no post_result_id, naming why', () => {
    expect(() =>
      parsePostBridgeAnalyticsWindowRow(wireRow({ post_result_id: undefined }), []),
    ).toThrowError(/response grain is not the one this app reads/);
    expect(() =>
      parsePostBridgeAnalyticsWindowRow(wireRow({ post_result_id: '' }), []),
    ).toThrowError(PublishProviderError);
    expect(() =>
      parsePostBridgeAnalyticsWindowRow(wireRow({ post_result_id: { id: 1 } }), []),
    ).toThrowError(PublishProviderError);
  });

  it('refuses a row carrying no id, and a row that is not an object', () => {
    expect(() => parsePostBridgeAnalyticsWindowRow(wireRow({ id: undefined }), [])).toThrowError(
      /carries no id/,
    );
    expect(() => parsePostBridgeAnalyticsWindowRow(null, [])).toThrowError(/a row is null/);
  });

  it('refuses a row whose platform is not text', () => {
    expect(() => parsePostBridgeAnalyticsWindowRow(wireRow({ platform: 7 }), [])).toThrowError(
      /the platform of an-1 is 7/,
    );
  });

  /**
   * The provider's own platform name is kept as it came. A filter answered with a platform this build
   * has no word for has still said something, and storing the token beats refusing the window.
   */
  it('keeps a platform name this build does not enumerate', () => {
    expect(parsePostBridgeAnalyticsWindowRow(wireRow({ platform: 'threads' }), []).platform).toBe(
      'threads',
    );
  });
});

describe('provenance, under the same rule as the per-delivery read', () => {
  it('keeps a short lower-case match token and the platform’s own identifier', () => {
    const parsed = parsePostBridgeAnalyticsWindowRow(
      wireRow({ match_confidence: 'exact', platform_post_id: '18363567718210871' }),
      [],
    );
    expect(parsed.matchConfidence).toBe('exact');
    expect(parsed.platformPostId).toBe('18363567718210871');
  });

  it('drops a match value of the wrong shape and says so on the warning list', () => {
    const warnings: string[] = [];
    const parsed = parsePostBridgeAnalyticsWindowRow(
      wireRow({ match_confidence: 'Very Confident Indeed' }),
      warnings,
    );
    expect(parsed.matchConfidence).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('result-1');
    expect(warnings[0]).toContain('not a value this app stores');
  });

  it('stores nothing at all where the provider sent nothing', () => {
    const parsed = parsePostBridgeAnalyticsWindowRow(wireRow(), []);
    expect(parsed).not.toHaveProperty('matchConfidence');
    expect(parsed).not.toHaveProperty('platformPostId');
  });
});

describe('reading one page', () => {
  it('reads the rows and the provider’s own answer about the next page', () => {
    const page = parsePostBridgeAnalyticsWindowPage(body([wireRow()], { next: null }));
    expect(page.rows).toHaveLength(1);
    expect(page.next).toEqual({ done: true });
    expect(page.warnings).toEqual([]);
  });

  it('continues at the offset the envelope names', () => {
    expect(parsePostBridgeAnalyticsWindowPage(body([wireRow()], { next: 100 })).next).toEqual({
      offset: 100,
    });
  });

  it('reports an unverified next-page token rather than guessing at it', () => {
    expect(
      parsePostBridgeAnalyticsWindowPage(body([wireRow()], { next: { cursor: 'opaque' } })).next,
    ).toEqual({ unknown: 'NEXT' });
  });

  it('reports a missing envelope rather than reading it as the last page', () => {
    expect(parsePostBridgeAnalyticsWindowPage({ data: [wireRow()] }).next).toEqual({
      unknown: 'META',
    });
  });

  /**
   * Stricter than the per-delivery parser on purpose: an absent `data` there is the ordinary state of
   * a post that went out an hour ago, whereas here it would replace a whole stored generation.
   */
  it('refuses a page with no list of rows rather than replacing a window with nothing', () => {
    expect(() => parsePostBridgeAnalyticsWindowPage({ meta: { next: null } })).toThrowError(
      /carried no list of rows/,
    );
    expect(() => parsePostBridgeAnalyticsWindowPage(null)).toThrowError(/a page is null/);
  });

  it('collects the warnings of every row on the page', () => {
    const page = parsePostBridgeAnalyticsWindowPage(
      body([
        wireRow({ match_confidence: 'NOT A TOKEN' }),
        wireRow({ id: 'an-2', post_result_id: 'result-2', platform_post_id: { nested: true } }),
      ]),
    );
    expect(page.rows).toHaveLength(2);
    expect(page.warnings).toHaveLength(2);
  });

  it('fails the whole page when one row cannot be attributed', () => {
    expect(() =>
      parsePostBridgeAnalyticsWindowPage(body([wireRow(), wireRow({ post_result_id: null })])),
    ).toThrowError(PublishProviderError);
  });
});
