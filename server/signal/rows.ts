import type { Db } from '../db.ts';
import type { SignalChannel, SignalPost } from '../../shared/signal.ts';
import type { PublishPlatform, PublishPostKind } from '../../shared/publish-capabilities.ts';
import {
  normalizePublishVariant,
  type PublishContentVariant,
  type PublishVariantRecord,
} from '../../shared/publish-variants.ts';

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

export interface SignalPostVariantRow {
  post_id: string;
  platform: string;
  account_id: number | null;
  caption: string | null;
  media_urls: string | null;
  post_kind: string | null;
  title: string | null;
  first_comment: string | null;
  disclose_synthetic_media: number | null;
  cover_image_url: string | null;
  thumbnail_url: string | null;
  updated_at: string;
}

/**
 * A stored layer as the resolution reads it.
 *
 * SQL NULL and "inherit" are the same thing here, which is what lets one row hold a caption
 * override and leave every other field to the post. `media_urls` is the one column where NULL and
 * an empty value differ: NULL inherits the post's media and `'[]'` is a platform that receives
 * none, so the parse keeps them apart rather than folding both into an empty array.
 *
 * A malformed `media_urls` reads as inherit rather than throwing. It is the one column holding
 * anything but a scalar, and a plan that cannot be previewed at all is a worse answer than one
 * that shows the post's own media and lets the selection be made again.
 */
export function toSignalPostVariant(row: SignalPostVariantRow): PublishVariantRecord {
  const variant: PublishContentVariant = {};
  if (row.caption !== null) variant.caption = row.caption;
  if (row.media_urls !== null) {
    try {
      const parsed: unknown = JSON.parse(row.media_urls);
      if (Array.isArray(parsed)) variant.mediaUrls = parsed.filter((v) => typeof v === 'string');
    } catch {
      // Left to inherit: see above.
    }
  }
  if (row.post_kind !== null) variant.postKind = row.post_kind as PublishPostKind;
  if (row.title !== null) variant.title = row.title;
  if (row.first_comment !== null) variant.firstComment = row.first_comment;
  if (row.disclose_synthetic_media !== null)
    variant.discloseSyntheticMedia = row.disclose_synthetic_media !== 0;
  if (row.cover_image_url !== null) variant.coverImageUrl = row.cover_image_url;
  if (row.thumbnail_url !== null) variant.thumbnailUrl = row.thumbnail_url;
  return {
    platform: row.platform as PublishPlatform,
    accountId: row.account_id,
    ...normalizePublishVariant(variant),
    updatedAt: row.updated_at,
  };
}

/**
 * Every layer stored for one post, platform layers before their accounts.
 *
 * The order is for a person reading the list, not for the resolution: `publishVariantLayers` looks
 * each layer up by platform and account id, so nothing depends on which row arrives first.
 */
export function listPostVariants(db: Db, postId: string): PublishVariantRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM signal_post_variants WHERE post_id=?
       ORDER BY platform, account_id IS NOT NULL, account_id`,
    )
    .all(postId) as unknown as SignalPostVariantRow[];
  return rows.map(toSignalPostVariant);
}
