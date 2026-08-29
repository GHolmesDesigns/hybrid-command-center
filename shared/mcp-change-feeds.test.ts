import { describe, expect, it } from 'vitest';
import {
  MCP_CHANGE_FEED_DEFAULT_LIMIT,
  MCP_CHANGE_FEED_EXPIRED_MESSAGE,
  MCP_CHANGE_FEED_MAX_LIMIT,
  MCP_CHANGE_FEED_SCOPE,
  decodeChangeFeedCursor,
  encodeChangeFeedCursor,
  mcpChangeFeedSchema,
  parseChangeFeedUri,
} from './mcp-change-feeds.ts';

describe('change-feed cursors', () => {
  it('round-trips a monotonic sequence as an opaque cursor', () => {
    const cursor = encodeChangeFeedCursor('coordination', 42);
    expect(cursor.startsWith('hcc_cf_')).toBe(true);
    expect(cursor.includes('coordination')).toBe(false);
    expect(decodeChangeFeedCursor(cursor)).toEqual({ feed: 'coordination', seq: 42 });
  });

  it('refuses a non-integer sequence on encode', () => {
    expect(() => encodeChangeFeedCursor('coordination', -1)).toThrow(/non-negative integer/);
    expect(() => encodeChangeFeedCursor('coordination', 1.5)).toThrow(/non-negative integer/);
  });

  it('refuses foreign or truncated cursor strings', () => {
    expect(decodeChangeFeedCursor('')).toBeNull();
    expect(decodeChangeFeedCursor('not-a-cursor')).toBeNull();
    expect(decodeChangeFeedCursor('hcc_cf_')).toBeNull();
    expect(
      decodeChangeFeedCursor(
        'hcc_cf_' + Buffer.from('v1|coordination|nope').toString('base64url'),
      ),
    ).toBeNull();
    expect(
      decodeChangeFeedCursor(
        'hcc_cf_' + Buffer.from('v1|coordination|9007199254740992').toString('base64url'),
      ),
    ).toBeNull();
  });

  it('keeps feed identity inside the cursor', () => {
    const cursor = encodeChangeFeedCursor('workspace', 7);
    expect(decodeChangeFeedCursor(cursor)?.feed).toBe('workspace');
  });
});

describe('parseChangeFeedUri', () => {
  it('parses coordination and workspace change URIs', () => {
    expect(parseChangeFeedUri('hcc://coordination/changes')).toEqual({
      feed: 'coordination',
      after: null,
      limit: MCP_CHANGE_FEED_DEFAULT_LIMIT,
    });
    expect(parseChangeFeedUri('hcc://workspace/changes?after=abc&limit=10')).toEqual({
      feed: 'workspace',
      after: 'abc',
      limit: 10,
    });
    expect(parseChangeFeedUri('hcc://coordination/changes?after=%20')).toEqual({
      feed: 'coordination',
      after: null,
      limit: MCP_CHANGE_FEED_DEFAULT_LIMIT,
    });
  });

  it('caps limit at the shared maximum', () => {
    expect(
      parseChangeFeedUri(`hcc://coordination/changes?limit=${MCP_CHANGE_FEED_MAX_LIMIT + 50}`),
    ).toMatchObject({ limit: MCP_CHANGE_FEED_MAX_LIMIT });
  });

  it('refuses a non-positive limit', () => {
    expect(() => parseChangeFeedUri('hcc://coordination/changes?limit=0')).toThrow(/limit/i);
    expect(() => parseChangeFeedUri('hcc://coordination/changes?limit=1.5')).toThrow(/limit/i);
  });

  it('ignores unrelated resources', () => {
    expect(parseChangeFeedUri('hcc://coordination/inbox?state=open')).toBeNull();
    expect(parseChangeFeedUri('https://coordination/changes')).toBeNull();
    expect(parseChangeFeedUri('not a url')).toBeNull();
  });
});

describe('change-feed scopes', () => {
  it('gates each feed on the matching read scope', () => {
    expect(MCP_CHANGE_FEED_SCOPE.coordination).toBe('coordination:read');
    expect(MCP_CHANGE_FEED_SCOPE.workspace).toBe('workspace:read');
    expect(mcpChangeFeedSchema.parse('coordination')).toBe('coordination');
  });

  it('exposes the expired message agents must surface', () => {
    expect(MCP_CHANGE_FEED_EXPIRED_MESSAGE).toBe('cursor expired; reload snapshot');
  });
});
