/**
 * Append-only MCP change feeds (`mcp_change_feed`).
 *
 * One INSERT and one retention DELETE per write — nothing updates a row. Each feed has its own
 * contiguous monotonic sequence so cross-feed traffic cannot look like a retention gap. Cursors
 * encode that sequence opaquely; a cursor that falls behind retention returns `cursor_expired`
 * rather than a partial replay.
 */
import type { Db } from './db.ts';
import { redactSecrets } from './integration-log.ts';
import {
  MCP_CHANGE_FEED_EXPIRED_MESSAGE,
  MCP_CHANGE_FEED_RETENTION,
  decodeChangeFeedCursor,
  encodeChangeFeedCursor,
  type McpChangeFeed,
  type McpChangeFeedEvent,
  type McpChangeFeedResult,
} from '../shared/mcp-change-feeds.ts';

export interface ChangeFeedEventInput {
  feed: McpChangeFeed;
  kind: string;
  summary: string;
  entityType?: string | null;
  entityId?: string | null;
  at?: string;
}

interface FeedRow {
  seq: number;
  feed: string;
  at: string;
  kind: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
}

export function recordChangeFeedEvent(db: Db, input: ChangeFeedEventInput): McpChangeFeedEvent {
  const at = input.at ?? new Date().toISOString();
  const summary = redactSecrets(input.summary);
  const next = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM mcp_change_feed WHERE feed = ?`)
    .get(input.feed) as { next_seq: number };
  const seq = Number(next.next_seq);
  db.prepare(
    `INSERT INTO mcp_change_feed(feed, seq, at, kind, entity_type, entity_id, summary)
     VALUES(?,?,?,?,?,?,?)`,
  ).run(input.feed, seq, at, input.kind, input.entityType ?? null, input.entityId ?? null, summary);
  db.prepare(
    `DELETE FROM mcp_change_feed WHERE feed = ? AND seq NOT IN (
       SELECT seq FROM mcp_change_feed WHERE feed = ? ORDER BY seq DESC LIMIT ?
     )`,
  ).run(input.feed, input.feed, MCP_CHANGE_FEED_RETENTION);
  return {
    cursor: encodeChangeFeedCursor(input.feed, seq),
    at,
    kind: input.kind,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary,
  };
}

export function readChangeFeed(
  db: Db,
  feed: McpChangeFeed,
  options: { after?: string | null; limit: number },
): McpChangeFeedResult {
  const bounds = feedBounds(db, feed);
  const tipSeq = bounds.maxSeq ?? 0;
  const tipCursor = encodeChangeFeedCursor(feed, tipSeq);

  if (options.after == null || options.after === '') {
    return {
      status: 'ok',
      feed,
      changes: [],
      cursor: tipCursor,
      truncated: false,
    };
  }

  const decoded = decodeChangeFeedCursor(options.after);
  if (!decoded || decoded.feed !== feed) {
    return {
      status: 'cursor_expired',
      feed,
      message: MCP_CHANGE_FEED_EXPIRED_MESSAGE,
    };
  }

  const afterSeq = decoded.seq;

  // Empty feed: only the zero tip is valid; anything else cannot be verified.
  if (bounds.minSeq == null) {
    if (afterSeq === 0) {
      return { status: 'ok', feed, changes: [], cursor: tipCursor, truncated: false };
    }
    return {
      status: 'cursor_expired',
      feed,
      message: MCP_CHANGE_FEED_EXPIRED_MESSAGE,
    };
  }

  // Gap between the cursor and the oldest retained row — never return a partial window.
  if (afterSeq + 1 < bounds.minSeq) {
    return {
      status: 'cursor_expired',
      feed,
      message: MCP_CHANGE_FEED_EXPIRED_MESSAGE,
    };
  }

  if (afterSeq >= tipSeq) {
    return {
      status: 'ok',
      feed,
      changes: [],
      cursor: encodeChangeFeedCursor(feed, Math.min(afterSeq, tipSeq)),
      truncated: false,
    };
  }

  const limit = options.limit;
  const rows = db
    .prepare(
      `SELECT seq, feed, at, kind, entity_type, entity_id, summary
       FROM mcp_change_feed
       WHERE feed = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(feed, afterSeq, limit + 1) as unknown as FeedRow[];

  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  const changes = page.map(toEvent);
  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : afterSeq;

  return {
    status: 'ok',
    feed,
    changes,
    cursor: encodeChangeFeedCursor(feed, lastSeq),
    truncated,
  };
}

function feedBounds(db: Db, feed: McpChangeFeed): { minSeq: number | null; maxSeq: number | null } {
  const row = db
    .prepare(`SELECT MIN(seq) AS min_seq, MAX(seq) AS max_seq FROM mcp_change_feed WHERE feed = ?`)
    .get(feed) as { min_seq: number | null; max_seq: number | null };
  return {
    minSeq: row.min_seq == null ? null : Number(row.min_seq),
    maxSeq: row.max_seq == null ? null : Number(row.max_seq),
  };
}

function toEvent(row: FeedRow): McpChangeFeedEvent {
  return {
    cursor: encodeChangeFeedCursor(row.feed as McpChangeFeed, row.seq),
    at: row.at,
    kind: row.kind,
    entityType: row.entity_type,
    entityId: row.entity_id,
    summary: row.summary,
  };
}
