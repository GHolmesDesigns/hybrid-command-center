import type { Db } from '../db.ts';
import type {
  SignalCampaign,
  SignalChannel,
  SignalDeliveryProvenance,
  SignalLifecycle,
  SignalLifecycleFilter,
  SignalPost,
} from '../../shared/signal.ts';
import type { SignalPostMedia } from '../../shared/signal-media.ts';
import type { ClientBranding } from '../../shared/branding.ts';
import { campaignsByPost } from './campaigns.ts';
import type { PublishPlatform, PublishPostKind } from '../../shared/publish-capabilities.ts';
import type { PublishTargetSelection } from '../../shared/publish.ts';
import {
  normalizePublishVariant,
  PUBLISH_VARIANT_MEDIA_FIELD,
  type PublishContentVariant,
  type PublishVariantRecord,
} from '../../shared/publish-variants.ts';
import {
  PUBLISH_VARIANT_MEDIA_ROLES,
  type PublishVariantMediaRole,
} from '../../shared/publish-variant-media.ts';

/**
 * Turning `signal_posts` rows into `SignalPost`s, shared by the read half and the write half so
 * both return a post shaped exactly one way.
 */

export interface SignalPostRow {
  id: string;
  project_id: string | null;
  text: string;
  date: string | null;
  time: string;
  format: string;
  status: string;
  /**
   * Deliberately absent. The `campaign` column is still on the table and is frozen — read once by
   * `backfillSignalCampaigns` and never again — so it is not described here: a row shape that named
   * it would be an invitation to read it, and what a post belongs to now comes from
   * `signal_post_campaigns`.
   */
  cta: string;
  position: number;
  lifecycle: string;
  retired_at: string | null;
  delivery_provenance: string;
  created_at: string;
  updated_at: string;
  revision: number;
  client_id: string | null;
  client_name: string | null;
  branding_logo_url: string | null;
  branding_color_one: string | null;
  branding_color_two: string | null;
}

/** One read shape for Signal posts, with the sole project-to-client binding resolved. */
export const signalPostSelect = `
  SELECT p.*, c.id AS client_id, c.name AS client_name,
         c.branding_logo_url, c.branding_color_one, c.branding_color_two
    FROM signal_posts p
    LEFT JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN clients c ON c.id = pr.client_id`;

/**
 * SQL fragment for the lifecycle filter a list or count applies.
 *
 * Named separately from planning status and delivery state so every caller states which dimension
 * it is narrowing. Default `active` matches ordinary planner / calendar / queue-health behaviour.
 */
export function signalLifecycleSql(filter: SignalLifecycleFilter = 'active'): {
  sql: string;
  params: string[];
} {
  if (filter === 'all') return { sql: '', params: [] };
  if (filter === 'retired') return { sql: " AND lifecycle = 'RETIRED'", params: [] };
  return { sql: " AND lifecycle = 'ACTIVE'", params: [] };
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

/**
 * The columns a stored media reference is made of, on whichever table holds it.
 *
 * `signal_post_media` and `signal_post_variant_media` carry the same eleven columns under the same
 * cross-field rule, so one parse serves both. The row types below add whatever keys their own table
 * is addressed by.
 */
export interface SignalMediaColumns {
  url: string;
  source: string;
  drive_file_id: string | null;
  drive_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  drive_version: string | null;
  drive_modified_at: string | null;
  drive_checksum: string | null;
  drive_verified_at: string | null;
}

export interface SignalPostMediaRow extends SignalMediaColumns {
  post_id: string;
}

/**
 * One stored reference as the descriptor.
 *
 * `source` is cast the way the post row's enum columns are: nothing but this module's own
 * validated writes reaches these columns, and the SQLite triggers in `server/db.ts` refuse a third
 * value outright, so the cast states that invariant rather than guessing at the data.
 */
export const toSignalPostMedia = (row: SignalMediaColumns): SignalPostMedia => ({
  source: row.source as SignalPostMedia['source'],
  url: row.url,
  driveFileId: row.drive_file_id,
  driveName: row.drive_name,
  mimeType: row.mime_type,
  // SQLite hands an INTEGER column back as a number or a bigint depending on its magnitude; the
  // sizes here are far inside the safe range, and normalising once here keeps every reader from
  // having to know that.
  sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  driveVersion: row.drive_version,
  driveModifiedAt: row.drive_modified_at,
  driveChecksum: row.drive_checksum,
  driveVerifiedAt: row.drive_verified_at,
});

/** Ordered media references for a set of posts, fetched in one query. */
export function mediaByPost(db: Db, postIds: string[]): Map<string, SignalPostMedia[]> {
  const grouped = new Map<string, SignalPostMedia[]>();
  if (postIds.length === 0) return grouped;
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT post_id, url, source, drive_file_id, drive_name, mime_type, size_bytes,
              drive_version, drive_modified_at, drive_checksum, drive_verified_at
         FROM signal_post_media
        WHERE post_id IN (${placeholders}) ORDER BY post_id, position`,
    )
    .all(...postIds) as unknown as SignalPostMediaRow[];
  for (const row of rows) {
    const attached = grouped.get(row.post_id) ?? [];
    attached.push(toSignalPostMedia(row));
    grouped.set(row.post_id, attached);
  }
  return grouped;
}

/**
 * One row plus its joins. The row's enum columns are passed through as their declared types:
 * nothing but this module's own validated writes puts values in these columns, so a cast here is
 * a statement about that invariant rather than a guess about the data.
 */
export function toSignalPost(
  row: SignalPostRow,
  channels: SignalChannel[],
  media: SignalPostMedia[],
  campaigns: SignalCampaign[],
): SignalPost {
  const client =
    row.client_id && row.client_name
      ? {
          id: row.client_id,
          name: row.client_name,
          ...(row.branding_logo_url || row.branding_color_one || row.branding_color_two
            ? {
                branding: {
                  logoUrl: row.branding_logo_url ?? '',
                  colorOne: row.branding_color_one ?? '',
                  colorTwo: row.branding_color_two ?? '',
                } satisfies ClientBranding,
              }
            : {}),
        }
      : undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    ...(client ? { client } : {}),
    text: row.text,
    // Empty rather than absent, so every consumer can read `post.channels.length`.
    channels,
    media,
    // Derived here and nowhere else, which is what stops the two from disagreeing.
    mediaUrls: media.map((item) => item.url),
    date: row.date,
    time: row.time,
    format: row.format as SignalPost['format'],
    status: row.status as SignalPost['status'],
    lifecycle: row.lifecycle as SignalLifecycle,
    retiredAt: row.retired_at,
    deliveryProvenance: row.delivery_provenance as SignalDeliveryProvenance,
    // Empty for a post in no campaign, for the same reason: **No campaign** is a group a reader can
    // see rather than an absence a caller has to test for.
    campaigns,
    cta: row.cta as SignalPost['cta'],
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: Number(row.revision),
  };
}

/** Rows and their joins together, in the order the rows arrived. */
export function toSignalPosts(db: Db, rows: SignalPostRow[]): SignalPost[] {
  const postIds = rows.map((row) => row.id);
  const channels = channelsByPost(db, postIds);
  const media = mediaByPost(db, postIds);
  const campaigns = campaignsByPost(db, postIds);
  return rows.map((row) =>
    toSignalPost(
      row,
      channels.get(row.id) ?? [],
      media.get(row.id) ?? [],
      campaigns.get(row.id) ?? [],
    ),
  );
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
  /**
   * `cover_image_url` and `thumbnail_url` are deliberately absent, exactly as
   * `signal_posts.campaign` is absent from `SignalPostRow`.
   *
   * Both columns are still on the table and are frozen: C76 moved every value into a
   * `signal_post_variant_media` role row and cleared them, so a row shape that named them would be
   * an invitation to read a column that holds nothing and could never hold a Drive reference. What a
   * layer's cover and thumbnail are comes from `variantMediaByPost`.
   */
  updated_at: string;
}

/** One role row: the layer it belongs to, the role it fills, and the reference itself. */
export interface SignalPostVariantMediaRow extends SignalMediaColumns {
  post_id: string;
  platform: string;
  account_id: number | null;
  role: string;
}

/**
 * The key a layer is addressed by here. The platform layer's account is `null`, the same shape
 * `publishVariantLayers` looks a layer up with.
 */
export const variantLayerKey = (platform: string, accountId: number | null) =>
  `${platform}:${accountId ?? 'platform'}`;

export type SignalVariantRoleMedia = Partial<Record<PublishVariantMediaRole, SignalPostMedia>>;

/**
 * Every role row on one post, grouped by the layer it belongs to.
 *
 * One query for the whole post rather than one per layer, the way `mediaByPost` reads a month's
 * media in one statement. A row whose `role` is not one this release knows is skipped rather than
 * cast: the column has a CHECK constraint, so reaching that means a database written by a later
 * release, and dropping the role is honest where guessing at it is not.
 */
export function variantMediaByPost(db: Db, postId: string): Map<string, SignalVariantRoleMedia> {
  const rows = db
    .prepare(
      `SELECT post_id, platform, account_id, role, url, source, drive_file_id, drive_name,
              mime_type, size_bytes, drive_version, drive_modified_at, drive_checksum,
              drive_verified_at
         FROM signal_post_variant_media
        WHERE post_id=? ORDER BY platform, account_id, role`,
    )
    .all(postId) as unknown as SignalPostVariantMediaRow[];
  const grouped = new Map<string, SignalVariantRoleMedia>();
  for (const row of rows) {
    if (!(PUBLISH_VARIANT_MEDIA_ROLES as readonly string[]).includes(row.role)) continue;
    const key = variantLayerKey(row.platform, row.account_id);
    const roles = grouped.get(key) ?? {};
    roles[row.role as PublishVariantMediaRole] = toSignalPostMedia(row);
    grouped.set(key, roles);
  }
  return grouped;
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
export function toSignalPostVariant(
  row: SignalPostVariantRow,
  roles: SignalVariantRoleMedia = {},
): PublishVariantRecord {
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
  // The roles arrive from their own table rather than from this row's frozen legacy columns, which
  // is what lets one of them be a version-bound Drive file rather than a URL string.
  for (const role of PUBLISH_VARIANT_MEDIA_ROLES) {
    const media = roles[role];
    if (media) variant[PUBLISH_VARIANT_MEDIA_FIELD[role]] = media;
  }
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
  const roles = variantMediaByPost(db, postId);
  const layers = rows.map((row) =>
    toSignalPostVariant(row, roles.get(variantLayerKey(row.platform, row.account_id)) ?? {}),
  );
  // A layer whose only override is a role has no text row to be read from: `signal_post_variants`
  // is the text table, and a row there that overrode no text would make a platform read as tailored
  // on fields it is not. So a role-only layer is composed from the role table alone, which is what
  // keeps `publishVariantLayers` able to find every layer by platform and account without knowing
  // which table answered for it.
  const seen = new Set(layers.map((layer) => variantLayerKey(layer.platform, layer.accountId)));
  const roleOnly = db
    .prepare(
      `SELECT platform, account_id, MAX(updated_at) AS updated_at
         FROM signal_post_variant_media WHERE post_id=?
        GROUP BY platform, account_id
        ORDER BY platform, account_id IS NOT NULL, account_id`,
    )
    .all(postId) as unknown as {
    platform: string;
    account_id: number | null;
    updated_at: string;
  }[];
  for (const row of roleOnly) {
    const key = variantLayerKey(row.platform, row.account_id);
    if (seen.has(key)) continue;
    seen.add(key);
    layers.push(
      toSignalPostVariant(
        {
          post_id: postId,
          platform: row.platform,
          account_id: row.account_id,
          caption: null,
          media_urls: null,
          post_kind: null,
          title: null,
          first_comment: null,
          disclose_synthetic_media: null,
          updated_at: row.updated_at,
        },
        roles.get(key) ?? {},
      ),
    );
  }
  return layers;
}

/**
 * The provider accounts a person explicitly chose for one post's channels (C77).
 *
 * Ordered by channel and then account id, so two reads of an unchanged post produce the same list.
 * The plan hash covers these ids, and an order that wandered would invalidate a confirmation
 * nobody had touched.
 *
 * Here rather than in the service because it is a read: `read.ts` is the half everything outside
 * Signal consumes and it must not reach into the write module to answer a question.
 */
export function listPostPublishTargets(db: Db, postId: string): PublishTargetSelection[] {
  return db
    .prepare(
      `SELECT channel, provider_account_id FROM signal_post_publish_targets
       WHERE post_id=? ORDER BY channel, provider_account_id`,
    )
    .all(postId)
    .map((row) => {
      const record = row as { channel: string; provider_account_id: number };
      return {
        channel: record.channel as SignalChannel,
        providerAccountId: record.provider_account_id,
      };
    });
}
