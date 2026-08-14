import type { Db } from '../db.ts';
import type { SignalChannel, SignalPost } from '../../shared/signal.ts';

/**
 * Turning `signal_posts` rows into `SignalPost`s, shared by the read half and the write half so
 * both return a post shaped exactly one way.
 */

export interface SignalPostRow {
  id: string;
  text: string;
  date: string | null;
  time: string;
  format: string;
  status: string;
  campaign: string | null;
  cta: string;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * The channels for a set of posts, grouped by post id, in one statement — so listing a month
 * costs two queries rather than one per post.
 */
export function channelsByPost(db: Db, postIds: string[]): Map<string, SignalChannel[]> {
  const grouped = new Map<string, SignalChannel[]>();
  if (postIds.length === 0) return grouped;
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT post_id, channel FROM signal_post_channels
       WHERE post_id IN (${placeholders}) ORDER BY channel`,
    )
    .all(...postIds) as { post_id: string; channel: string }[];
  for (const row of rows) {
    const attached = grouped.get(row.post_id) ?? [];
    attached.push(row.channel as SignalChannel);
    grouped.set(row.post_id, attached);
  }
  return grouped;
}

/** Ordered media references for a set of posts, fetched in one query. */
export function mediaByPost(db: Db, postIds: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  if (postIds.length === 0) return grouped;
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT post_id, url FROM signal_post_media
       WHERE post_id IN (${placeholders}) ORDER BY post_id, position`,
    )
    .all(...postIds) as { post_id: string; url: string }[];
  for (const row of rows) {
    const attached = grouped.get(row.post_id) ?? [];
    attached.push(row.url);
    grouped.set(row.post_id, attached);
  }
  return grouped;
}

/**
 * One row plus its channels. The row's enum columns are passed through as their declared types:
 * nothing but this module's own validated writes puts values in these columns, so a cast here is
 * a statement about that invariant rather than a guess about the data.
 */
export function toSignalPost(
  row: SignalPostRow,
  channels: SignalChannel[],
  mediaUrls: string[],
): SignalPost {
  return {
    id: row.id,
    text: row.text,
    // Empty rather than absent, so every consumer can read `post.channels.length`.
    channels,
    mediaUrls,
    date: row.date,
    time: row.time,
    format: row.format as SignalPost['format'],
    status: row.status as SignalPost['status'],
    campaign: row.campaign,
    cta: row.cta as SignalPost['cta'],
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Rows and their channels together, in the order the rows arrived. */
export function toSignalPosts(db: Db, rows: SignalPostRow[]): SignalPost[] {
  const postIds = rows.map((row) => row.id);
  const channels = channelsByPost(db, postIds);
  const media = mediaByPost(db, postIds);
  return rows.map((row) => toSignalPost(row, channels.get(row.id) ?? [], media.get(row.id) ?? []));
}
