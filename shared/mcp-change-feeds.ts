/**
 * Cursor-based MCP change feeds (C132).
 *
 * Durable, resumable feeds replace inbox polling: an agent asks what changed after its last
 * opaque cursor. Retention is bounded; a cursor that falls behind retention returns an explicit
 * expired result rather than a silent gap.
 */
import { z } from 'zod';
import type { McpAgentScope } from './mcp-agent-registry.ts';

export const MCP_CHANGE_FEEDS = ['coordination', 'workspace'] as const;
export type McpChangeFeed = (typeof MCP_CHANGE_FEEDS)[number];

/** Newest rows kept per feed; same append-only discipline as `mcp_agent_events`. */
export const MCP_CHANGE_FEED_RETENTION = 500;

/** Hard ceiling on changes returned in one resource read. */
export const MCP_CHANGE_FEED_MAX_LIMIT = 100;

/** Default page size when the URI omits a limit. */
export const MCP_CHANGE_FEED_DEFAULT_LIMIT = 50;

export const COORDINATION_CHANGES_URI = 'hcc://coordination/changes';
export const WORKSPACE_CHANGES_URI = 'hcc://workspace/changes';

export const MCP_CHANGE_FEED_SCOPE: Record<McpChangeFeed, McpAgentScope> = {
  coordination: 'coordination:read',
  workspace: 'workspace:read',
};

export const MCP_CHANGE_FEED_EXPIRED_MESSAGE = 'cursor expired; reload snapshot';

const CURSOR_PREFIX = 'hcc_cf_';

export type McpChangeFeedEvent = {
  /** Opaque cursor for this event; pass as `after` to resume past it. */
  cursor: string;
  at: string;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  summary: string;
};

export type McpChangeFeedOk = {
  status: 'ok';
  feed: McpChangeFeed;
  changes: McpChangeFeedEvent[];
  /** Opaque tip the client should store for the next poll. */
  cursor: string;
  /** True when more retained changes exist after this page. */
  truncated: boolean;
};

export type McpChangeFeedExpired = {
  status: 'cursor_expired';
  feed: McpChangeFeed;
  message: typeof MCP_CHANGE_FEED_EXPIRED_MESSAGE;
};

export type McpChangeFeedResult = McpChangeFeedOk | McpChangeFeedExpired;

export const mcpChangeFeedSchema = z.enum(MCP_CHANGE_FEEDS);

/**
 * Encode a monotonic sequence into an opaque cursor. Clients must not parse the payload —
 * only round-trip it as `after`.
 */
export function encodeChangeFeedCursor(feed: McpChangeFeed, seq: number): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error('Change-feed cursor sequence must be a non-negative integer.');
  }
  const payload = Buffer.from(`v1|${feed}|${seq}`, 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}${payload}`;
}

/** Decode an opaque cursor; returns null when the string is not a cursor for this build. */
export function decodeChangeFeedCursor(raw: string): { feed: McpChangeFeed; seq: number } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CURSOR_PREFIX)) return null;
  const decoded = Buffer.from(trimmed.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8');
  const match = /^v1\|(coordination|workspace)\|(\d+)$/.exec(decoded);
  if (!match) return null;
  const feed = match[1] as McpChangeFeed;
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { feed, seq };
}

export function parseChangeFeedUri(uri: string): {
  feed: McpChangeFeed;
  after: string | null;
  limit: number;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(uri.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'hcc:') return null;
  const feed =
    parsed.hostname === 'coordination' && parsed.pathname === '/changes'
      ? 'coordination'
      : parsed.hostname === 'workspace' && parsed.pathname === '/changes'
        ? 'workspace'
        : null;
  if (!feed) return null;

  const afterRaw = parsed.searchParams.get('after');
  const after = afterRaw != null && afterRaw.trim() !== '' ? afterRaw.trim() : null;

  const limitRaw = parsed.searchParams.get('limit');
  let limit = MCP_CHANGE_FEED_DEFAULT_LIMIT;
  if (limitRaw != null && limitRaw.trim() !== '') {
    const parsedLimit = Number(limitRaw);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new Error('Change-feed limit must be a positive integer.');
    }
    limit = Math.min(parsedLimit, MCP_CHANGE_FEED_MAX_LIMIT);
  }

  return { feed, after, limit };
}
