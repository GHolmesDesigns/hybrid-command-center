import { describe, expect, it } from 'vitest';
import {
  parsePostBridgeAnalyticsList,
  postBridgeAnalyticsPath,
} from './post-bridge-analytics-wire.ts';
import { PublishProviderError } from './provider.ts';
import { ANALYTICS_MATCH_CONFIDENCES } from '../../shared/publish-analytics.ts';

/**
 * The figures request and the reading of a figures row, against fixtures.
 *
 * The live adapter is `fetch` and a bearer token and no automated test may run it, so this is where
 * the decisions live: what a match value has to look like to be stored, what happens to one that
 * does not, and that a record arriving without either provenance field carries neither rather than a
 * default. §14 records the live match values as unverified, which is exactly why the rule under test
 * is a shape rule and not an enum.
 */

/** One row as the vendor spells it, with only what a test is about overridden. */
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'analytics-1',
  post_result_id: 'result-tt',
  platform: 'tiktok',
  view_count: 4210,
  like_count: 318,
  comment_count: 24,
  share_count: 61,
  last_synced_at: '2026-08-19T11:00:00.000Z',
  share_url: 'https://tiktok.example/video/1',
  ...overrides,
});

const first = (body: unknown) => parsePostBridgeAnalyticsList(body).records[0];

describe('the figures request', () => {
  it('repeats the result id per delivery and names a limit that covers all of them', () => {
    expect(postBridgeAnalyticsPath(['result-tt', 'result-yt'])).toBe(
      '/analytics?post_result_id=result-tt&post_result_id=result-yt&limit=10',
    );
    const many = postBridgeAnalyticsPath(Array.from({ length: 14 }, (_, index) => `r-${index}`));
    expect(many).toContain('limit=14');
    expect(many.match(/post_result_id=/g)).toHaveLength(14);
  });

  it('escapes a result id rather than letting it write its own parameters', () => {
    expect(postBridgeAnalyticsPath(['a&limit=1'])).toBe(
      '/analytics?post_result_id=a%26limit%3D1&limit=10',
    );
  });

  it('sends no platform and no timeframe, both of which are C80’s and unverified', () => {
    const path = postBridgeAnalyticsPath(['result-tt']);
    expect(path).not.toContain('platform');
    expect(path).not.toContain('timeframe');
  });
});

describe('reading one figures row', () => {
  it('translates the vendor’s names once and keeps the four counts as they came', () => {
    expect(first({ data: [row()] })).toEqual({
      analyticsId: 'analytics-1',
      postResultId: 'result-tt',
      platform: 'tiktok',
      views: 4210,
      likes: 318,
      comments: 24,
      shares: 61,
      lastSyncedAt: '2026-08-19T11:00:00.000Z',
      shareUrl: 'https://tiktok.example/video/1',
    });
  });

  it('reads a body with no data at all as an empty answer rather than a failure', () => {
    for (const body of [{}, { data: null }, null, undefined])
      expect(parsePostBridgeAnalyticsList(body)).toEqual({ records: [], warnings: [] });
  });

  it('refuses a data field that is not a list, so nothing is written over', () => {
    expect(() => parsePostBridgeAnalyticsList({ data: 'nope' })).toThrow(PublishProviderError);
  });
});

describe('the provenance a figures row carries', () => {
  it('keeps the documented match values, and any other short lower-case token', () => {
    for (const value of [...ANALYTICS_MATCH_CONFIDENCES, 'probable_match-2', 'x'.repeat(40)])
      expect(first({ data: [row({ match_confidence: value })] })?.matchConfidence).toBe(value);
  });

  it('carries no match value at all where the provider sent none', () => {
    for (const value of [undefined, null]) {
      const record = first({ data: [row({ match_confidence: value })] });
      expect(record).not.toHaveProperty('matchConfidence');
      expect(
        parsePostBridgeAnalyticsList({ data: [row({ match_confidence: value })] }).warnings,
      ).toEqual([]);
    }
  });

  it('drops a match value of any other shape and says so, rather than reshaping it', () => {
    for (const value of ['Exact', 'EXACT', 'exact match', '', 'x'.repeat(41), 7, true, { a: 1 }]) {
      const parsed = parsePostBridgeAnalyticsList({ data: [row({ match_confidence: value })] });
      expect(parsed.records[0]).not.toHaveProperty('matchConfidence');
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]).toContain('result-tt');
      expect(parsed.warnings[0]).toContain('not a value this app stores');
    }
  });

  it('never lets an unknown value in through a shape a known one would match', () => {
    // The one failure this card exists to prevent: a value nobody has verified arriving as `exact`
    // because the parser trimmed it, lower-cased it, or took the first word.
    for (const value of [' exact', 'exact ', 'EXACT', 'exact!', 'exact high'])
      expect(first({ data: [row({ match_confidence: value })] })?.matchConfidence).toBeUndefined();
  });

  it('bounds what a refused value can put in a warning', () => {
    const parsed = parsePostBridgeAnalyticsList({
      data: [row({ match_confidence: `${'A'.repeat(400)} secret` })],
    });
    expect(parsed.warnings[0]).toContain('A'.repeat(40));
    expect(parsed.warnings[0]).not.toContain('A'.repeat(41));
    expect(parsed.warnings[0]).not.toContain('secret');
  });

  it('names the type of a refused non-string instead of serialising it', () => {
    const parsed = parsePostBridgeAnalyticsList({
      data: [row({ match_confidence: { nested: 'a whole response body' } })],
    });
    expect(parsed.warnings[0]).toContain('an object');
    expect(parsed.warnings[0]).not.toContain('response body');
  });

  it('keeps the platform’s own identifier as text, trimmed', () => {
    expect(first({ data: [row({ platform_post_id: '  dQw4w9WgXcQ  ' })] })?.platformPostId).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('carries no identifier where the provider sent none, and warns about any other shape', () => {
    for (const value of [undefined, null]) {
      const parsed = parsePostBridgeAnalyticsList({ data: [row({ platform_post_id: value })] });
      expect(parsed.records[0]).not.toHaveProperty('platformPostId');
      expect(parsed.warnings).toEqual([]);
    }
    for (const value of ['', '   ', 'x'.repeat(201), 12345, { id: 'a' }]) {
      const parsed = parsePostBridgeAnalyticsList({ data: [row({ platform_post_id: value })] });
      expect(parsed.records[0]).not.toHaveProperty('platformPostId');
      expect(parsed.warnings).toHaveLength(1);
      expect(parsed.warnings[0]).toContain('not an identifier this app stores');
    }
  });

  it('reads a row that carries both, and one warning per refused field', () => {
    const parsed = parsePostBridgeAnalyticsList({
      data: [
        row({ match_confidence: 'exact', platform_post_id: 'tt-1' }),
        row({
          id: 'analytics-2',
          post_result_id: 'result-yt',
          match_confidence: 'Exact',
          platform_post_id: 99,
        }),
      ],
    });
    expect(parsed.records[0]).toMatchObject({ matchConfidence: 'exact', platformPostId: 'tt-1' });
    expect(parsed.records[1]).not.toHaveProperty('matchConfidence');
    expect(parsed.records[1]).not.toHaveProperty('platformPostId');
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings.every((warning) => warning.includes('result-yt'))).toBe(true);
  });

  it('reads a missing count as the provider’s own zero and an absent optional as absent', () => {
    const record = first({
      data: [{ id: 'a', post_result_id: 'r', platform: 'tiktok', share_url: '' }],
    });
    expect(record).toEqual({
      analyticsId: 'a',
      postResultId: 'r',
      platform: 'tiktok',
      views: 0,
      likes: 0,
      comments: 0,
      shares: 0,
    });
  });
});
