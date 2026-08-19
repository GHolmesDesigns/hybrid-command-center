import { z } from 'zod';
import type { Db } from '../db.ts';
import {
  SIGNAL_CHANNELS,
  SIGNAL_CTAS,
  SIGNAL_DATE_PATTERN,
  SIGNAL_DEFAULT_TIME,
  SIGNAL_FORMATS,
  SIGNAL_STATUSES,
  SIGNAL_TIME_PATTERN,
  isSignalDate,
  signalSlotOccupied,
  suggestNextOpenSignalSlot,
  type SignalPost,
  type SignalSlot,
} from '../../shared/signal.ts';
import {
  listPostVariants,
  toSignalPost,
  toSignalPosts,
  channelsByPost,
  mediaByPost,
  type SignalPostRow,
} from './rows.ts';
import { campaignsByPost, signalPostCampaignNames, writePostCampaigns } from './campaigns.ts';
import {
  PUBLISH_PLATFORMS,
  PUBLISH_POST_KINDS,
  PUBLISH_POST_KIND_LABEL,
  publishCapabilityFor,
  publishKindSupported,
} from '../../shared/publish-capabilities.ts';
import {
  normalizePublishVariant,
  publishVariantFieldSupported,
  publishVariantIsEmpty,
  PUBLISH_VARIANT_FIELDS,
  PUBLISH_VARIANT_FIELD_LABEL,
  type PublishVariantRecord,
} from '../../shared/publish-variants.ts';

/**
 * Signal's writes, and the only place they live.
 *
 * The read half (`read.ts`) and the interface it satisfies (`provider.ts`) have no write between
 * them, so the calendar cannot reach anything in this file. The planner imports it; nothing else
 * should.
 *
 * These writes deliberately record **no** `integration_events`. Signal is local data now, like
 * projects and tasks, and those do not write to the log either. The log is for what an
 * *integration* did to local data (`AGENTS.md`), and diluting it with ordinary edits would cost
 * it both its meaning and its 200-row budget.
 */

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** A post that does not exist, answered as a 404 rather than as a silent no-op. */
export class SignalPostNotFoundError extends Error {}

/**
 * A suggested slot was refused: either the confirmed cell is now taken, or the search window
 * found no free cell. Carries a replacement suggestion when one exists, so the editor can show
 * it without a second round-trip.
 */
export class SignalSlotConflictError extends Error {
  readonly status: 409;
  readonly suggestion: SignalSlot | null;
  constructor(message: string, suggestion: SignalSlot | null) {
    super(message);
    this.name = 'SignalSlotConflictError';
    this.status = 409;
    this.suggestion = suggestion;
  }
}

const channel = z.enum(SIGNAL_CHANNELS);
const mediaUrl = z
  .string()
  .trim()
  .min(1, 'A media URL cannot be empty.')
  .max(2048, 'A media URL is too long.')
  .url('Use a valid media URL.')
  .refine((value) => new URL(value).protocol === 'https:', 'Media URLs must use https.');
const date = z
  .string()
  .regex(SIGNAL_DATE_PATTERN, 'Use a YYYY-MM-DD date.')
  // A real calendar day, not merely four-two-two digits: this rejects `2026-02-31`, which the
  // pattern alone would pass and which would then sit in a cell that never renders.
  .refine(isSignalDate, 'That date does not exist.');

const postFields = {
  text: z.string().trim().min(1, 'A post needs content.').max(20_000),
  /** Deduplicated, because the join's primary key would reject a repeat as an error. */
  channels: z
    .array(channel)
    .max(SIGNAL_CHANNELS.length)
    .transform((values) => [...new Set(values)])
    .default([]),
  /** Ordered and bounded; per-platform media limits belong to the publisher preflight. */
  mediaUrls: z.array(mediaUrl).max(20, 'A post can reference at most 20 media items.').default([]),
  /** Null is the unscheduled queue, and is the default: an idea starts without a day. */
  date: date.nullable().default(null),
  time: z
    .string()
    .regex(SIGNAL_TIME_PATTERN, 'Use a 24-hour HH:MM time.')
    .default(SIGNAL_DEFAULT_TIME),
  format: z.enum(SIGNAL_FORMATS).default('TEXT'),
  status: z.enum(SIGNAL_STATUSES).default('DRAFT'),
  /**
   * The campaigns this post belongs to, by name.
   *
   * Names rather than ids: the editor saves a whole draft in one press, so a campaign typed into
   * the form has no id yet, and each name is resolved against the shared list — matched
   * case-insensitively, created when it is new — inside the same transaction as the post. Defaults
   * to none, which is a post under **No campaign** and the ordinary state of a fresh idea.
   */
  campaigns: signalPostCampaignNames.default([]),
  cta: z.enum(SIGNAL_CTAS).default('NONE'),
};

export const signalPostInput = z.object(postFields);
/**
 * A patch changes only what it names. `.partial()` over the same fields is what keeps the two
 * from drifting: a field added above is patchable without a second edit here.
 */
export const signalPostPatch = z.object(postFields).partial();

export type SignalPostInput = z.output<typeof signalPostInput>;
export type SignalPostPatch = z.output<typeof signalPostPatch>;

export const signalRangeQuery = z.object({
  from: date,
  to: date,
});

/** The local day the planner is looking from. The server never derives this from an instant. */
export const signalSlotFromQuery = z.object({
  from: date,
});

/** The cell the user confirmed, plus the local day used to recompute if it is now taken. */
export const signalSlotInput = z.object({
  date,
  time: z.string().regex(SIGNAL_TIME_PATTERN, 'Use a 24-hour HH:MM time.'),
  from: date,
});

export type SignalSlotInput = z.output<typeof signalSlotInput>;

/** Where a new unscheduled post sits: after everything already queued. */
function nextQueuePosition(db: Db): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(position), -1) AS max FROM signal_posts WHERE date IS NULL')
    .get() as { max: number };
  return row.max + 1;
}

function writeChannels(db: Db, postId: string, channels: string[]): void {
  db.prepare('DELETE FROM signal_post_channels WHERE post_id=?').run(postId);
  const insert = db.prepare('INSERT INTO signal_post_channels(post_id, channel) VALUES(?,?)');
  for (const value of channels) insert.run(postId, value);
}

function writeMedia(db: Db, postId: string, mediaUrls: string[]): void {
  db.prepare('DELETE FROM signal_post_media WHERE post_id=?').run(postId);
  const insert = db.prepare('INSERT INTO signal_post_media(post_id, position, url) VALUES(?,?,?)');
  mediaUrls.forEach((url, position) => insert.run(postId, position, url));
}

function readRow(db: Db, postId: string): SignalPostRow | undefined {
  return db.prepare('SELECT * FROM signal_posts WHERE id=?').get(postId) as
    SignalPostRow | undefined;
}

/** One post with its channels, or undefined when there is no such post. */
export function getPost(db: Db, postId: string): SignalPost | undefined {
  const row = readRow(db, postId);
  if (!row) return undefined;
  return toSignalPost(
    row,
    channelsByPost(db, [postId]).get(postId) ?? [],
    mediaByPost(db, [postId]).get(postId) ?? [],
    campaignsByPost(db, [postId]).get(postId) ?? [],
  );
}

/**
 * The unscheduled queue, in its manual order. Dated posts are read through the provider, by
 * range; this is the other half of the planner's view and the only place these appear.
 */
export function listQueue(db: Db): SignalPost[] {
  const rows = db
    .prepare('SELECT * FROM signal_posts WHERE date IS NULL ORDER BY position, created_at, id')
    .all() as unknown as SignalPostRow[];
  return toSignalPosts(db, rows);
}

export function createPost(db: Db, input: SignalPostInput): SignalPost {
  const postId = id();
  const timestamp = now();
  // The post, channels, media, and campaigns land together: a post missing part of the requested
  // plan would be a half-written record the caller was told succeeded. A campaign created for a
  // post that then failed to write would be a name in the shared list nobody asked for.
  db.exec('BEGIN');
  try {
    // `campaign`, the frozen free-text column, is deliberately not in this statement: it is left
    // NULL on every post written from now on, and what a post belongs to lives in the join below.
    db.prepare(
      `INSERT INTO signal_posts(id,text,date,time,format,status,cta,position,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      postId,
      input.text,
      input.date,
      input.time,
      input.format,
      input.status,
      input.cta,
      input.date === null ? nextQueuePosition(db) : 0,
      timestamp,
      timestamp,
    );
    writeChannels(db, postId, input.channels);
    writeMedia(db, postId, input.mediaUrls);
    writePostCampaigns(db, postId, input.campaigns);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPost(db, postId) as SignalPost;
}

export function updatePost(db: Db, postId: string, patch: SignalPostPatch): SignalPost {
  const existing = readRow(db, postId);
  if (!existing) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);

  const next = {
    text: patch.text ?? existing.text,
    date: patch.date === undefined ? existing.date : patch.date,
    time: patch.time ?? existing.time,
    format: patch.format ?? existing.format,
    status: patch.status ?? existing.status,
    cta: patch.cta ?? existing.cta,
  };
  // A post returning to the queue joins the end of it; one leaving keeps a position nothing
  // reads. Position only ever means something for an undated post.
  const position =
    next.date === null ? (existing.date === null ? existing.position : nextQueuePosition(db)) : 0;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE signal_posts SET text=?,date=?,time=?,format=?,status=?,cta=?,position=?,updated_at=?
       WHERE id=?`,
    ).run(
      next.text,
      next.date,
      next.time,
      next.format,
      next.status,
      next.cta,
      position,
      now(),
      postId,
    );
    if (patch.channels !== undefined) writeChannels(db, postId, patch.channels);
    if (patch.mediaUrls !== undefined) writeMedia(db, postId, patch.mediaUrls);
    // A patch changes only what it names, campaigns included: an edit to the time leaves the
    // campaigns alone, and `[]` is the deliberate answer *this post belongs to none*.
    if (patch.campaigns !== undefined) writePostCampaigns(db, postId, patch.campaigns);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPost(db, postId) as SignalPost;
}

/**
 * Removes a post outright. Signal posts are plans rather than records of work, so there is
 * nothing here to archive; the channel and media rows go with it by cascade.
 */
export function deletePost(db: Db, postId: string): void {
  const result = db.prepare('DELETE FROM signal_posts WHERE id=?').run(postId);
  if (result.changes === 0) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
}

/**
 * Platform and account content overrides: validation, and the one write.
 *
 * The layers themselves are `shared/publish-variants.ts`; this is where a layer is checked against
 * the provider capability contract and stored. The check is here as well as in the composer and in
 * the publisher's preflight on purpose — a form that hides a field the API would take is a form one
 * `curl` walks around, and a limit the API refuses that the form still offers is a limit the user
 * meets after typing.
 */

/** A layer the contract will not carry, or a media selection the post does not have. */
export class SignalVariantError extends Error {}

const variantUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048, 'A media URL is too long.')
  .url('Use a valid media URL.')
  .refine((value) => new URL(value).protocol === 'https:', 'Media URLs must use https.');

/**
 * One stored layer, structurally.
 *
 * The lengths here are outer bounds rather than the platform's own: a title's real limit is
 * `capability.title.maxLength`, which differs per platform and is preflight's refusal to make with
 * the platform named. What this schema refuses is a value no platform could ever take.
 */
const variantInput = z.object({
  platform: z.enum(PUBLISH_PLATFORMS),
  /** Null is the platform layer; a provider account id is that account's layer. */
  accountId: z.number().int().positive('A provider account id is a positive number.').nullable(),
  caption: z.string().max(20_000).optional(),
  /** Absent inherits the post's media; `[]` is a platform that deliberately receives none. */
  mediaUrls: z
    .array(variantUrl)
    .max(20, 'A platform can receive at most 20 media items.')
    .optional(),
  postKind: z.enum(PUBLISH_POST_KINDS).optional(),
  title: z.string().max(500).optional(),
  firstComment: z.string().max(20_000).optional(),
  discloseSyntheticMedia: z.boolean().optional(),
  coverImageUrl: variantUrl.optional(),
  thumbnailUrl: variantUrl.optional(),
});

export const signalVariantsInput = z.object({
  /** The whole set for the post: this is a replacement, not a patch. */
  variants: z
    .array(variantInput)
    .max(PUBLISH_PLATFORMS.length * 4)
    .default([]),
});
export type SignalVariantsInput = z.output<typeof signalVariantsInput>;

/**
 * Refuses a layer the platform's own capability entry does not accept.
 *
 * Fail-closed in the same direction the contract itself fails: an unanswered platform refuses
 * rather than being stored against nothing, and a field the platform has no room for is named
 * along with the platform, because "unsupported field" without either is a message the user cannot
 * act on.
 */
function checkVariantAgainstContract(variant: PublishVariantRecord, postMedia: string[]): void {
  const capability = publishCapabilityFor(variant.platform);
  if (!capability)
    throw new SignalVariantError(
      `${variant.platform} is not answered by the provider capability contract, so no override can be stored for it.`,
    );
  for (const field of PUBLISH_VARIANT_FIELDS) {
    if (variant[field] === undefined) continue;
    if (publishVariantFieldSupported(field, capability)) continue;
    throw new SignalVariantError(
      `${capability.label} takes no ${PUBLISH_VARIANT_FIELD_LABEL[field].toLowerCase()} from this provider, so it cannot be overridden there.`,
    );
  }
  if (variant.postKind && !publishKindSupported(capability.kinds[variant.postKind]))
    throw new SignalVariantError(
      `${capability.label} does not accept a ${PUBLISH_POST_KIND_LABEL[variant.postKind]} from this provider.`,
    );
  if (variant.mediaUrls) {
    const unknown = variant.mediaUrls.find((url) => !postMedia.includes(url));
    if (unknown)
      throw new SignalVariantError(
        'A platform can only be given media the post already carries. Add the URL to the post first.',
      );
    if (new Set(variant.mediaUrls).size !== variant.mediaUrls.length)
      throw new SignalVariantError('A platform cannot receive the same media item twice.');
  }
}

/**
 * Replaces every layer on one post, in one transaction.
 *
 * A replacement rather than a patch, for the reason branding is: the composer holds the whole set
 * while it is edited, and a half-applied set would leave a platform tailored by a request that was
 * reported as having failed. An empty layer is dropped rather than stored — a row overriding nothing
 * would make a platform read as tailored when it is not.
 */
export function replacePostVariants(
  db: Db,
  postId: string,
  input: SignalVariantsInput,
): PublishVariantRecord[] {
  const post = getPost(db, postId);
  if (!post) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const seen = new Set<string>();
  const layers = input.variants
    .map((variant) => ({
      platform: variant.platform,
      accountId: variant.accountId,
      ...normalizePublishVariant(variant),
    }))
    .filter((variant) => !publishVariantIsEmpty(variant));
  for (const layer of layers) {
    const key = `${layer.platform}:${layer.accountId ?? 'platform'}`;
    if (seen.has(key))
      throw new SignalVariantError('That platform and account was given two overrides at once.');
    seen.add(key);
    checkVariantAgainstContract(layer, post.mediaUrls);
  }
  const timestamp = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM signal_post_variants WHERE post_id=?').run(postId);
    const insert = db.prepare(
      `INSERT INTO signal_post_variants(
         post_id,platform,account_id,caption,media_urls,post_kind,title,first_comment,
         disclose_synthetic_media,cover_image_url,thumbnail_url,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const layer of layers)
      insert.run(
        postId,
        layer.platform,
        layer.accountId,
        layer.caption ?? null,
        // Serialized rather than dropped when empty: `'[]'` is a platform that receives no media
        // and NULL is one that inherits the post's, and the two must survive the round trip.
        layer.mediaUrls ? JSON.stringify(layer.mediaUrls) : null,
        layer.postKind ?? null,
        layer.title ?? null,
        layer.firstComment ?? null,
        layer.discloseSyntheticMedia === undefined ? null : layer.discloseSyntheticMedia ? 1 : 0,
        layer.coverImageUrl ?? null,
        layer.thumbnailUrl ?? null,
        timestamp,
      );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listPostVariants(db, postId);
}

/** Every layer on a post, for the composer to edit. The publisher reads them through the provider. */
export function getPostVariants(db: Db, postId: string): PublishVariantRecord[] {
  if (!getPost(db, postId)) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  return listPostVariants(db, postId);
}

/**
 * Copies composition onto a new unscheduled post. Publication and delivery rows stay on the
 * original: a duplicate is a new plan, not a second record of a send.
 */
export function duplicatePost(db: Db, postId: string): SignalPost {
  const source = getPost(db, postId);
  if (!source) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  return createPost(db, {
    text: source.text,
    channels: source.channels,
    mediaUrls: source.mediaUrls,
    date: null,
    time: source.time,
    format: source.format,
    status: 'DRAFT',
    // The names, not the ids: `createPost` resolves them, and they already exist, so the duplicate
    // joins the same campaigns rather than creating second rows with the same names.
    campaigns: source.campaigns.map((campaign) => campaign.name),
    cta: source.cta,
  });
}

function occupiedSlots(db: Db, exceptPostId: string): SignalSlot[] {
  return db
    .prepare('SELECT date, time FROM signal_posts WHERE date IS NOT NULL AND id != ?')
    .all(exceptPostId) as unknown as SignalSlot[];
}

function suggestionFor(
  post: SignalPost,
  occupied: SignalSlot[],
  fromDate: string,
): SignalSlot | null {
  return suggestNextOpenSignalSlot({
    occupied,
    time: post.time,
    fromDate,
    skip: post.date ? { date: post.date, time: post.time } : null,
  });
}

/** The next free Signal cell at this post's time, computed from the schedule alone. */
export function suggestPostSlot(db: Db, postId: string, fromDate: string): SignalSlot {
  const post = getPost(db, postId);
  if (!post) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const suggestion = suggestionFor(post, occupiedSlots(db, postId), fromDate);
  if (!suggestion)
    throw new SignalSlotConflictError('No open slot was found in the next two years.', null);
  return suggestion;
}

/**
 * Writes a confirmed slot after recomputing occupancy. A taken cell is refused rather than
 * overwritten, and the replacement suggestion is whatever the schedule now has free.
 */
export function applyPostSlot(db: Db, postId: string, input: SignalSlotInput): SignalPost {
  const post = getPost(db, postId);
  if (!post) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const occupied = occupiedSlots(db, postId);
  const confirmed = { date: input.date, time: input.time };
  if (signalSlotOccupied(occupied, confirmed)) {
    throw new SignalSlotConflictError(
      'That slot is no longer open.',
      suggestionFor(post, occupied, input.from),
    );
  }
  return updatePost(db, postId, { date: input.date, time: input.time });
}
