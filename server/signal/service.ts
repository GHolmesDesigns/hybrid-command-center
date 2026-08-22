import { z } from 'zod';
import type { Db } from '../db.ts';
import {
  SIGNAL_CHANNELS,
  SIGNAL_CHANNEL_LABEL,
  SIGNAL_CTAS,
  SIGNAL_DATE_PATTERN,
  SIGNAL_DEFAULT_TIME,
  SIGNAL_FORMATS,
  SIGNAL_STATUSES,
  SIGNAL_TIME_PATTERN,
  isSignalDate,
  signalSlotOccupied,
  suggestNextOpenSignalSlot,
  type SignalChannel,
  type SignalPost,
  type SignalSlot,
} from '../../shared/signal.ts';
import {
  listPostVariants,
  toSignalPost,
  toSignalPosts,
  channelsByPost,
  mediaByPost,
  variantLayerKey,
  variantMediaByPost,
  type SignalPostRow,
  type SignalVariantRoleMedia,
} from './rows.ts';
import { campaignsByPost, signalPostCampaignNames, writePostCampaigns } from './campaigns.ts';
import { listPostPublishTargets } from './rows.ts';
import {
  signalMediaFingerprint,
  signalPostMediaIssue,
  urlPostMedia,
  type SignalPostMedia,
} from '../../shared/signal-media.ts';
import {
  publishRoleMediaIssue,
  PUBLISH_VARIANT_MEDIA_ROLES,
  PUBLISH_VARIANT_MEDIA_ROLE_LABEL,
} from '../../shared/publish-variant-media.ts';
import {
  driveMediaProvider,
  parseDriveMediaLink,
  resolveDriveMedia,
  type DriveMediaProvider,
} from '../drive/media.ts';
import {
  PUBLISH_PLATFORMS,
  PUBLISH_POST_KINDS,
  PUBLISH_POST_KIND_LABEL,
  publishCapabilityFor,
  publishKindSupported,
  publishPlatformFor,
} from '../../shared/publish-capabilities.ts';
import { PUBLISH_TARGET_SELECTION_MAX, type PublishTargetSelection } from '../../shared/publish.ts';
import {
  normalizePublishVariant,
  publishVariantFieldSupported,
  publishVariantIsEmpty,
  PUBLISH_VARIANT_FIELDS,
  PUBLISH_VARIANT_FIELD_LABEL,
  PUBLISH_VARIANT_MEDIA_FIELD,
  type PublishContentVariant,
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
 * A media list this app will not store: a descriptor that breaks the cross-field rule, the same
 * Drive file twice, or a recheck of a file the post does not carry. Answered as a 400.
 *
 * A Drive link that will not resolve is a `DriveMediaError` instead, thrown from the capability
 * that tried, so the message names what Drive said rather than what this service concluded.
 */
export class SignalMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalMediaError';
  }
}

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

/**
 * Whether an address is a usable `https:` one, without throwing on something that is not an
 * address at all.
 *
 * Zod collects every issue rather than stopping at the first, so a refinement runs even when the
 * `.url()` check on the same string has already failed — and `new URL('not-a-url')` throws, which
 * would leave the route answering 500 to a value the schema had correctly refused. The refusal is
 * the answer; the exception was never one.
 */
const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const mediaUrl = z
  .string()
  .trim()
  .min(1, 'A media URL cannot be empty.')
  .max(2048, 'A media URL is too long.')
  .url('Use a valid media URL.')
  .refine(isHttpsUrl, 'Media URLs must use https.');

/**
 * One media reference as a request states it.
 *
 * A `DRIVE` item carries a **link**, never a file id. That is the boundary rule from C74: a link
 * is parsed as a URL, checked against the Drive hosts, and matched against the documented forms
 * before anything is looked up, and there is no path by which a bare id from a browser becomes a
 * stored reference. The link is bounded here and understood in `server/drive/media.ts`, which owns
 * the one parsing rule that a paste, a save, and an explicit recheck all go through.
 *
 * Nothing about a Drive file's metadata is accepted from a request. The name, MIME type, size, and
 * version fingerprint are whatever Drive said when this app resolved the link, so a caller cannot
 * describe a file into existence — the worst a forged link achieves is a refusal.
 */
const mediaItemInput = z.discriminatedUnion('source', [
  z.object({ source: z.literal('URL'), url: mediaUrl }),
  z.object({
    source: z.literal('DRIVE'),
    url: z
      .string()
      .trim()
      .min(1, 'Paste a Google Drive file link.')
      .max(2048, 'That Drive link is too long.'),
  }),
]);
export type SignalMediaItemInput = z.output<typeof mediaItemInput>;
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
  /**
   * Ordered and bounded; per-platform media limits belong to the publisher preflight.
   *
   * The public-URL half of the media list, and the shape every caller wrote before a reference
   * could be a Drive file. It is still exactly that: a request that sends only this gets a post
   * whose media are all `URL` rows, unchanged in every respect. `media` below is the whole list
   * and wins when both are sent.
   */
  mediaUrls: z.array(mediaUrl).max(20, 'A post can reference at most 20 media items.').default([]),
  /**
   * The whole ordered media list, discriminated by source.
   *
   * When present this is authoritative and `mediaUrls` is ignored — they are alternatives rather
   * than a merge, the same way the provider treats its own `media` and `media_urls`
   * (`docs/post-bridge-api-surface.md` §5). Absent from a patch means the post's media are left
   * exactly as they are, which is what lets an edit to the caption leave a Drive fingerprint alone.
   */
  media: z.array(mediaItemInput).max(20, 'A post can reference at most 20 media items.').optional(),
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
 * A patch changes only what it names — and the defaults have to come off for that to be true.
 *
 * `.partial()` alone is not enough. It wraps each field in `ZodOptional`, but a field declared with
 * `.default(...)` keeps its default *inside* that wrapper, so parsing `{ text: 'Reworded' }`
 * against it yields `channels: []`, `mediaUrls: []`, `campaigns: []`, and `date: null` — a patch
 * that says nothing about those fields arriving at the write as a patch that clears them. Every
 * caller inside this module passes an object literal and so never met it; the `PATCH` route parses
 * the body and does.
 *
 * Stripping the default first is what makes an omitted field arrive as `undefined`, which is what
 * every `!== undefined` test below is written against. It is still derived from `postFields` rather
 * than typed out a second time, so a field added above is still patchable without a second edit.
 */
type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type SignalPostPatchShape = {
  [K in keyof typeof postFields]: z.ZodOptional<WithoutDefault<(typeof postFields)[K]>>;
};
const patchShape = Object.fromEntries(
  Object.entries(postFields).map(([field, schema]) => [
    field,
    (schema instanceof z.ZodDefault ? schema.unwrap() : schema).optional(),
  ]),
) as SignalPostPatchShape;
export const signalPostPatch = z.object(patchShape);

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

function writeMedia(db: Db, postId: string, media: SignalPostMedia[]): void {
  db.prepare('DELETE FROM signal_post_media WHERE post_id=?').run(postId);
  const insert = db.prepare(
    `INSERT INTO signal_post_media(
       post_id, position, url, source, drive_file_id, drive_name, mime_type, size_bytes,
       drive_version, drive_modified_at, drive_checksum, drive_verified_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  media.forEach((item, position) => {
    // The same rule the Zod boundary applied and the SQLite triggers will apply again. Stated
    // here as well because this is the only function that writes the table, and a descriptor
    // assembled in code rather than parsed from a request reaches it without passing the schema.
    const issue = signalPostMediaIssue(item);
    if (issue) throw new SignalMediaError(issue);
    insert.run(
      postId,
      position,
      item.url,
      item.source,
      item.driveFileId,
      item.driveName,
      item.mimeType,
      item.sizeBytes,
      item.driveVersion,
      item.driveModifiedAt,
      item.driveChecksum,
      item.driveVerifiedAt,
    );
  });
}

/** The media a post carries now, by Drive file id. Empty for a post that has none. */
function storedDriveMedia(db: Db, postId: string | null): Map<string, SignalPostMedia> {
  if (!postId) return new Map();
  const stored = mediaByPost(db, [postId]).get(postId) ?? [];
  return new Map(
    stored.flatMap((item) =>
      item.source === 'DRIVE' && item.driveFileId ? [[item.driveFileId, item] as const] : [],
    ),
  );
}

/**
 * Turns what a request asked for into the descriptors that will be stored.
 *
 * The rule for a Drive item is the point of this function, and it is short: **a reference the post
 * already carries is carried forward exactly as it stands, and only a new one is resolved.** That
 * is what makes a fingerprint change an explicit act. Saving an edit to the caption re-sends the
 * whole media list, and if that re-resolved every Drive item then a file replaced under the same
 * id would be silently adopted by an edit that was about the text — the opposite of the version
 * binding this card exists to give. `recheck` names the one file the user asked about, and it is
 * the only way an existing fingerprint is replaced.
 *
 * Resolution happens **before** the transaction that writes it. A Drive call inside `BEGIN
 * IMMEDIATE` would hold the write lock for the length of a network round trip.
 */
async function resolveMediaItems(
  db: Db,
  postId: string | null,
  items: SignalMediaItemInput[],
  provider: DriveMediaProvider,
  recheck: ReadonlySet<string> = new Set(),
): Promise<SignalPostMedia[]> {
  const carried = storedDriveMedia(db, postId);
  const seen = new Set<string>();
  const resolved: SignalPostMedia[] = [];
  for (const item of items) {
    if (item.source === 'URL') {
      resolved.push(urlPostMedia(item.url));
      continue;
    }
    const fileId = parseDriveMediaLink(item.url);
    if (seen.has(fileId))
      throw new SignalMediaError('A post cannot carry the same Drive file twice.');
    seen.add(fileId);
    const existing = carried.get(fileId);
    if (existing && !recheck.has(fileId)) {
      resolved.push(existing);
      continue;
    }
    resolved.push(await resolveDriveMedia({ link: item.url, provider }));
  }
  return resolved;
}

/**
 * What a create or a patch says the media list is, or `undefined` when it says nothing about it.
 *
 * `media` wins over `mediaUrls`; see the field notes on both. A patch naming neither leaves the
 * post's references untouched, fingerprints included.
 */
function mediaItemsOf(input: {
  media?: SignalMediaItemInput[];
  mediaUrls?: string[];
}): SignalMediaItemInput[] | undefined {
  if (input.media !== undefined) return input.media;
  if (input.mediaUrls !== undefined)
    return input.mediaUrls.map((url) => ({ source: 'URL' as const, url }));
  return undefined;
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

/**
 * The write itself, over media that is already resolved.
 *
 * Split from `createPost` so that a duplicate — which copies descriptors it already holds — needs
 * no Drive call and stays synchronous, and so that the transaction below contains no `await`.
 */
function insertPost(db: Db, input: SignalPostInput, media: SignalPostMedia[]): SignalPost {
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
    writeMedia(db, postId, media);
    writePostCampaigns(db, postId, input.campaigns);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPost(db, postId) as SignalPost;
}

/**
 * A new post, with any Drive references resolved first.
 *
 * Asynchronous because a Drive link the request has never seen resolved has to be looked up before
 * it can be stored, and only then: a post whose media are all public URLs contacts nothing and the
 * provider is never touched.
 */
export async function createPost(
  db: Db,
  input: SignalPostInput,
  provider: DriveMediaProvider = driveMediaProvider(db),
): Promise<SignalPost> {
  const items = mediaItemsOf(input) ?? [];
  return insertPost(db, input, await resolveMediaItems(db, null, items, provider));
}

/**
 * The stored fields of one post, and optionally its media, in one transaction.
 *
 * Media is passed already resolved for the same reason it is in `insertPost`: this is the ordinary
 * Signal edit transaction, and an explicit recheck writes a new fingerprint through it rather than
 * through a path of its own. Bumping `updated_at` is what invalidates an open publish preview,
 * because the plan hash covers it.
 */
function writePost(
  db: Db,
  postId: string,
  patch: SignalPostPatch,
  media: SignalPostMedia[] | undefined,
): SignalPost {
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
    if (media !== undefined) writeMedia(db, postId, media);
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
 * A patch, with any *new* Drive reference resolved first and every existing one left exactly as it
 * stands. See `resolveMediaItems` for why that asymmetry is the whole point.
 */
export async function updatePost(
  db: Db,
  postId: string,
  patch: SignalPostPatch,
  provider: DriveMediaProvider = driveMediaProvider(db),
): Promise<SignalPost> {
  if (!readRow(db, postId)) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const items = mediaItemsOf(patch);
  const media =
    items === undefined ? undefined : await resolveMediaItems(db, postId, items, provider);
  return writePost(db, postId, patch, media);
}

/**
 * Checks one Drive reference against Drive again, on purpose, and records what it found.
 *
 * The only way a stored fingerprint is replaced. It resolves through the same rule a paste uses —
 * from the reference's own stored link, which is Drive's canonical `webViewLink` and parses back
 * to the same id — and writes the result through the ordinary edit transaction, so the post's
 * `updated_at` moves and any open publish preview stops matching.
 *
 * A failure throws and **writes nothing**: the row keeps the metadata it had, the composer keeps
 * showing it beside the reason, and nothing about the reference is silently removed or rewritten.
 * C75 owns the mandatory revalidation at submit; this is the one a person asks for.
 */
export async function recheckPostMedia(
  db: Db,
  postId: string,
  driveFileId: string,
  provider: DriveMediaProvider = driveMediaProvider(db),
): Promise<SignalPost> {
  const post = getPost(db, postId);
  if (!post) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const target = post.media.find(
    (item) => item.source === 'DRIVE' && item.driveFileId === driveFileId,
  );
  if (!target)
    throw new SignalMediaError('That Drive file is not one of this post’s media references.');
  const items: SignalMediaItemInput[] = post.media.map((item) =>
    item.source === 'DRIVE'
      ? { source: 'DRIVE' as const, url: item.url }
      : { source: 'URL' as const, url: item.url },
  );
  const media = await resolveMediaItems(db, postId, items, provider, new Set([driveFileId]));
  return writePost(db, postId, {}, media);
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
  .refine(isHttpsUrl, 'Media URLs must use https.');

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
  /**
   * The two media roles, stated the way a post's own media is stated: a public `https:` URL, or a
   * Drive **link** that this app parses, host-checks, and resolves itself.
   *
   * Nothing about a Drive file's metadata is accepted here either — see `mediaItemInput`. A role
   * reaching no provider field yet is still stored under the full C74 contract, because the whole
   * point of the normalized table is that a role verified later needs no second migration.
   */
  coverImage: mediaItemInput.optional(),
  thumbnail: mediaItemInput.optional(),
});

export const signalVariantsInput = z.object({
  /** The whole set for the post: this is a replacement, not a patch. */
  variants: z
    .array(variantInput)
    .max(PUBLISH_PLATFORMS.length * 4)
    .default([]),
});
export type SignalVariantsInput = z.output<typeof signalVariantsInput>;

/** Which layer's role a person asked to check against Drive again. */
export const signalVariantMediaRecheckInput = z.object({
  platform: z.enum(PUBLISH_PLATFORMS),
  accountId: z.number().int().positive('A provider account id is a positive number.').nullable(),
  role: z.enum(PUBLISH_VARIANT_MEDIA_ROLES),
});
export type SignalVariantMediaRecheckInput = z.output<typeof signalVariantMediaRecheckInput>;

type VariantInput = z.output<typeof variantInput>;

/**
 * One layer as it will be written: its text overrides, and its role references already resolved.
 *
 * Split in two because they are two tables. The text half is what `signal_post_variants` holds and
 * is stored only when it says something; the roles are `signal_post_variant_media` rows and are
 * stored whether or not the text half exists, which is what makes a cover image on its own a real
 * override rather than one that needs a caption to hang from.
 */
interface ResolvedVariantLayer {
  platform: PublishVariantRecord['platform'];
  accountId: number | null;
  text: PublishContentVariant;
  roles: SignalVariantRoleMedia;
}

/** The role references stored for one post, by layer and role. Empty for a post with none. */
const storedRoleMedia = (db: Db, postId: string) => variantMediaByPost(db, postId);

/**
 * The two halves of a layer as the one record every rule is stated against.
 *
 * The tables are two; the layer is one. Every check — the capability contract, the empty-layer rule,
 * the media selection — asks about the layer, so it is assembled once here rather than spread back
 * together at each call.
 */
const variantRecordOf = (layer: ResolvedVariantLayer): PublishVariantRecord => ({
  platform: layer.platform,
  accountId: layer.accountId,
  ...layer.text,
  ...Object.fromEntries(
    PUBLISH_VARIANT_MEDIA_ROLES.flatMap((role) =>
      layer.roles[role] ? [[PUBLISH_VARIANT_MEDIA_FIELD[role], layer.roles[role]] as const] : [],
    ),
  ),
});

/**
 * Resolves the role references one request stated, carrying every existing one forward untouched.
 *
 * The same asymmetry `resolveMediaItems` is built on, and for the same reason: a save that
 * re-resolved every Drive role would let a file replaced under the same id be adopted by an edit
 * that was about a caption. A role the layer already holds at that file id is carried forward
 * exactly as it stands; only a new link, or one named in `recheck`, is looked up. Resolution
 * happens before the write transaction, because a Drive round trip inside `BEGIN IMMEDIATE` would
 * hold the write lock for its length.
 */
async function resolveVariantRoles(
  stored: Map<string, SignalVariantRoleMedia>,
  layer: VariantInput,
  provider: DriveMediaProvider,
  recheck: ReadonlySet<string> = new Set(),
): Promise<SignalVariantRoleMedia> {
  const roles: SignalVariantRoleMedia = {};
  const key = variantLayerKey(layer.platform, layer.accountId);
  for (const role of PUBLISH_VARIANT_MEDIA_ROLES) {
    const item = layer[PUBLISH_VARIANT_MEDIA_FIELD[role]];
    if (item === undefined) continue;
    if (item.source === 'URL') {
      roles[role] = urlPostMedia(item.url);
      continue;
    }
    const fileId = parseDriveMediaLink(item.url);
    const existing = stored.get(key)?.[role];
    if (
      existing?.source === 'DRIVE' &&
      existing.driveFileId === fileId &&
      !recheck.has(`${key}:${role}`)
    ) {
      roles[role] = existing;
      continue;
    }
    roles[role] = await resolveDriveMedia({ link: item.url, provider });
  }
  return roles;
}

/** The role references on a post as one comparable value, for deciding whether they moved. */
const roleFingerprints = (layers: readonly ResolvedVariantLayer[]) =>
  JSON.stringify(
    layers
      .flatMap((layer) =>
        PUBLISH_VARIANT_MEDIA_ROLES.flatMap((role) => {
          const media = layer.roles[role];
          return media
            ? [
                [
                  `${variantLayerKey(layer.platform, layer.accountId)}:${role}`,
                  signalMediaFingerprint(media),
                ] as const,
              ]
            : [];
        }),
      )
      .sort((a, b) => a[0].localeCompare(b[0])),
  );

/** The same value, taken from what the post currently holds. */
const storedRoleFingerprints = (stored: Map<string, SignalVariantRoleMedia>) =>
  JSON.stringify(
    [...stored.entries()]
      .flatMap(([key, roles]) =>
        PUBLISH_VARIANT_MEDIA_ROLES.flatMap((role) => {
          const media = roles[role];
          return media ? [[`${key}:${role}`, signalMediaFingerprint(media)] as const] : [];
        }),
      )
      .sort((a, b) => a[0].localeCompare(b[0])),
  );

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
  for (const role of PUBLISH_VARIANT_MEDIA_ROLES) {
    const media = variant[PUBLISH_VARIANT_MEDIA_FIELD[role]];
    if (!media) continue;
    // The C74 cross-field rule, plus the two bounds a role adds: a cover and a thumbnail are still
    // images, and the 8 MB image ceiling C73 measured applies to one exactly as it does to post
    // media. Refused here rather than warned about, because a role the provider would reject is
    // not a role worth storing.
    const issue = publishRoleMediaIssue(media, role);
    if (issue)
      throw new SignalVariantError(
        `${capability.label} ${PUBLISH_VARIANT_MEDIA_ROLE_LABEL[role]}: ${issue}`,
      );
  }
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
export async function replacePostVariants(
  db: Db,
  postId: string,
  input: SignalVariantsInput,
  provider: DriveMediaProvider = driveMediaProvider(db),
  recheck: ReadonlySet<string> = new Set(),
): Promise<PublishVariantRecord[]> {
  const post = getPost(db, postId);
  if (!post) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const stored = storedRoleMedia(db, postId);
  const seen = new Set<string>();
  const layers: ResolvedVariantLayer[] = [];
  for (const variant of input.variants) {
    const key = variantLayerKey(variant.platform, variant.accountId);
    if (seen.has(key))
      throw new SignalVariantError('That platform and account was given two overrides at once.');
    seen.add(key);
    // The Drive lookups happen out here, one layer at a time, and before anything is written.
    const roles = await resolveVariantRoles(stored, variant, provider, recheck);
    const { coverImage: _cover, thumbnail: _thumbnail, ...text } = variant;
    void _cover;
    void _thumbnail;
    layers.push({
      platform: variant.platform,
      accountId: variant.accountId,
      text: normalizePublishVariant(text),
      roles,
    });
  }
  // An empty layer is dropped rather than stored, roles included — a layer overriding nothing would
  // make a platform read as tailored when it is not.
  const checked = layers.filter((layer) => !publishVariantIsEmpty(variantRecordOf(layer)));
  for (const layer of checked) checkVariantAgainstContract(variantRecordOf(layer), post.mediaUrls);
  // Whether a role moved, decided before the write and over the fingerprints rather than the rows:
  // a recheck that finds the same version must leave the post's `updated_at` alone, or every open
  // publish confirmation would go stale for a file nobody had touched.
  const rolesMoved = roleFingerprints(checked) !== storedRoleFingerprints(stored);
  const timestamp = now();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM signal_post_variants WHERE post_id=?').run(postId);
    db.prepare('DELETE FROM signal_post_variant_media WHERE post_id=?').run(postId);
    const insert = db.prepare(
      `INSERT INTO signal_post_variants(
         post_id,platform,account_id,caption,media_urls,post_kind,title,first_comment,
         disclose_synthetic_media,cover_image_url,thumbnail_url,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
    );
    const insertRole = db.prepare(
      `INSERT INTO signal_post_variant_media(
         post_id, platform, account_id, role, url, source, drive_file_id, drive_name, mime_type,
         size_bytes, drive_version, drive_modified_at, drive_checksum, drive_verified_at, updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const layer of checked) {
      // The text row exists only where there is text to store. A layer whose sole override is a
      // cover image is a real layer and has no row here: it is read back from the role table, which
      // is what stops `signal_post_variants` from carrying rows that override nothing.
      if (!publishVariantIsEmpty(layer.text))
        insert.run(
          postId,
          layer.platform,
          layer.accountId,
          layer.text.caption ?? null,
          // Serialized rather than dropped when empty: `'[]'` is a platform that receives no media
          // and NULL is one that inherits the post's, and the two must survive the round trip.
          layer.text.mediaUrls ? JSON.stringify(layer.text.mediaUrls) : null,
          layer.text.postKind ?? null,
          layer.text.title ?? null,
          layer.text.firstComment ?? null,
          layer.text.discloseSyntheticMedia === undefined
            ? null
            : layer.text.discloseSyntheticMedia
              ? 1
              : 0,
          timestamp,
        );
      for (const role of PUBLISH_VARIANT_MEDIA_ROLES) {
        const media = layer.roles[role];
        if (!media) continue;
        // The same rule the Zod boundary applied and the SQLite triggers will apply again, stated
        // here because this is the only function that writes the table.
        const issue = signalPostMediaIssue(media);
        if (issue) throw new SignalMediaError(issue);
        insertRole.run(
          postId,
          layer.platform,
          layer.accountId,
          role,
          media.url,
          media.source,
          media.driveFileId,
          media.driveName,
          media.mimeType,
          media.sizeBytes,
          media.driveVersion,
          media.driveModifiedAt,
          media.driveChecksum,
          media.driveVerifiedAt,
          timestamp,
        );
      }
    }
    // A role edit is an edit to what a target receives, so it moves the post's `updated_at` and an
    // open publish confirmation stops matching — the same thing a recheck of the post's own media
    // does, through the same column, for the same reason. Text overrides need no bump: the plan hash
    // already covers the configurations they become.
    if (rolesMoved)
      db.prepare('UPDATE signal_posts SET updated_at=? WHERE id=?').run(timestamp, postId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listPostVariants(db, postId);
}

/**
 * Checks one layer's role reference against Drive again, because a person asked.
 *
 * The counterpart of `recheckPostMedia`, and the only way a stored role fingerprint is replaced. It
 * resolves from the reference's own stored link — Drive's canonical `webViewLink`, which parses back
 * to the same id — and rewrites the whole variant set through the ordinary replacement above, so the
 * post's `updated_at` moves exactly when the version actually changed.
 *
 * A failure throws and writes nothing: the row keeps the metadata it had and the composer shows the
 * reason beside it. C75 owns the mandatory revalidation at submit; this is the one a person asks for.
 */
export async function recheckVariantMedia(
  db: Db,
  postId: string,
  input: SignalVariantMediaRecheckInput,
  provider: DriveMediaProvider = driveMediaProvider(db),
): Promise<PublishVariantRecord[]> {
  if (!getPost(db, postId)) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);
  const key = variantLayerKey(input.platform, input.accountId);
  const target = storedRoleMedia(db, postId).get(key)?.[input.role];
  if (!target || target.source !== 'DRIVE')
    throw new SignalMediaError(
      `No Drive ${PUBLISH_VARIANT_MEDIA_ROLE_LABEL[input.role]} is stored for that platform.`,
    );
  const variants = listPostVariants(db, postId).map((layer) => ({
    platform: layer.platform,
    accountId: layer.accountId,
    ...(layer.caption !== undefined ? { caption: layer.caption } : {}),
    ...(layer.mediaUrls !== undefined ? { mediaUrls: layer.mediaUrls } : {}),
    ...(layer.postKind !== undefined ? { postKind: layer.postKind } : {}),
    ...(layer.title !== undefined ? { title: layer.title } : {}),
    ...(layer.firstComment !== undefined ? { firstComment: layer.firstComment } : {}),
    ...(layer.discloseSyntheticMedia !== undefined
      ? { discloseSyntheticMedia: layer.discloseSyntheticMedia }
      : {}),
    ...(layer.coverImage
      ? { coverImage: { source: layer.coverImage.source, url: layer.coverImage.url } }
      : {}),
    ...(layer.thumbnail
      ? { thumbnail: { source: layer.thumbnail.source, url: layer.thumbnail.url } }
      : {}),
  }));
  return replacePostVariants(
    db,
    postId,
    signalVariantsInput.parse({ variants }),
    provider,
    new Set([`${key}:${input.role}`]),
  );
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
  // The descriptors verbatim, Drive rows included: a duplicate is a copy of a plan, and the copy
  // means the same file at the same version the original was bound to. Copying them rather than
  // re-resolving is also why this needs no Drive call and stays synchronous — and it is honest,
  // because the fingerprint being copied is the last one this app actually verified.
  return insertPost(
    db,
    {
      text: source.text,
      channels: source.channels,
      mediaUrls: [],
      date: null,
      time: source.time,
      format: source.format,
      status: 'DRAFT',
      // The names, not the ids: they already exist, so the duplicate joins the same campaigns
      // rather than creating second rows with the same names.
      campaigns: source.campaigns.map((campaign) => campaign.name),
      cta: source.cta,
    },
    source.media,
  );
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
  // The write core rather than `updatePost`: a slot names no media, so there is nothing to resolve
  // and no reason for this to become a call that could contact Drive.
  return writePost(db, postId, { date: input.date, time: input.time }, undefined);
}

/**
 * A selection the provider's current account list does not support (C77).
 *
 * Separate from `SignalVariantError` because it is a different kind of wrongness: a variant error
 * is a value the contract does not allow, and this is a value that was allowed when the preview was
 * taken and is not allowed now. Both answer 400; only this one is worth re-reading the account list
 * over.
 */
export class SignalPublishTargetError extends Error {}

/** One channel's explicit account choices, as the preview sends them back. */
const publishTargetInput = z.object({
  channel: z.enum(SIGNAL_CHANNELS),
  providerAccountIds: z
    .array(z.number().int().positive('A provider account id is a positive number.'))
    .max(PUBLISH_TARGET_SELECTION_MAX),
});

/**
 * The whole selection for a post: a replacement, not a patch.
 *
 * The same shape `PUT /api/signal/posts/:id/variants` takes, and for the same reason — the preview
 * shows every channel's targets at once, so a partial write would let one channel's selection
 * survive a request that was reported as having failed.
 */
export const signalPublishTargetsInput = z.object({
  targets: z.array(publishTargetInput).max(SIGNAL_CHANNELS.length).default([]),
});
export type SignalPublishTargetsInput = z.output<typeof signalPublishTargetsInput>;

/**
 * Every explicit selection a post carries, ordered by channel and then account id.
 *
 * The order is deliberate and not the insertion order: the plan hash covers these ids, so a list
 * that came back in a different order after an unrelated write would invalidate a confirmation
 * nobody had touched.
 */
export function getPostPublishTargets(db: Db, postId: string): PublishTargetSelection[] {
  return listPostPublishTargets(db, postId);
}

/**
 * Replaces a post's explicit target selection, refusing anything the provider list does not carry.
 *
 * Three refusals, and they are three different facts rather than one "invalid account" sentence:
 * an id the provider does not list at all is disconnected or was never there; an id it lists under
 * another platform is a real account chosen for the wrong channel; and a channel the provider
 * cannot reach has no account to choose. Naming which one happened is the difference between a
 * person reconnecting an account and a person hunting for a typo.
 *
 * **The provider list is passed in, never fetched here.** It is the same list the preview was built
 * from, so a selection is validated against what the user was actually shown; refetching would let
 * this route accept an account that appeared between the preview and the save, which is exactly the
 * staleness the confirmation hash exists to catch.
 *
 * Writes no `integration_events` row: choosing a target is Signal editing its own local data, and
 * the log is for what an *integration* did (`AGENTS.md`).
 */
export function replacePostPublishTargets(
  db: Db,
  postId: string,
  input: SignalPublishTargetsInput,
  connected: readonly { id: number; platform: string }[],
  now: () => Date = () => new Date(),
): PublishTargetSelection[] {
  const post = getPost(db, postId);
  if (!post) throw new SignalPostNotFoundError(`No Signal post ${postId}.`);

  const byId = new Map(connected.map((target) => [target.id, target]));
  const rows: { channel: SignalChannel; providerAccountId: number }[] = [];
  const seenChannels = new Set<string>();

  for (const entry of input.targets) {
    if (seenChannels.has(entry.channel))
      throw new SignalPublishTargetError(
        `${SIGNAL_CHANNEL_LABEL[entry.channel] ?? entry.channel} was given two target lists at once.`,
      );
    seenChannels.add(entry.channel);
    const label = SIGNAL_CHANNEL_LABEL[entry.channel] ?? entry.channel;
    const platform = publishPlatformFor(entry.channel);
    if (entry.providerAccountIds.length && (platform === null || platform === undefined))
      throw new SignalPublishTargetError(
        `${label} is not reachable through this provider, so it has no account to choose.`,
      );
    const seenAccounts = new Set<number>();
    for (const id of entry.providerAccountIds) {
      // A repeat is the same choice rather than an error the user can act on, and the unique index
      // would refuse the second insert anyway. Collapse it here so the write stays idempotent.
      if (seenAccounts.has(id)) continue;
      seenAccounts.add(id);
      const target = byId.get(id);
      if (!target)
        throw new SignalPublishTargetError(
          `Account ${id} is not in the connected list this preview was built from. Reconnect it in Post Bridge, or take a new preview.`,
        );
      if (target.platform !== platform)
        throw new SignalPublishTargetError(
          `Account ${id} is a ${target.platform} account and ${label} publishes to ${String(platform)}. Choose an account on the right platform.`,
        );
      rows.push({ channel: entry.channel, providerAccountId: id });
    }
  }

  // Every refusal above happens before this, so the delete and the inserts are the whole
  // transaction and a rejected selection leaves the stored one exactly as it was.
  const timestamp = now().toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM signal_post_publish_targets WHERE post_id=?').run(postId);
    const insert = db.prepare(
      `INSERT INTO signal_post_publish_targets(post_id, channel, provider_account_id, created_at)
       VALUES(?,?,?,?)`,
    );
    for (const row of rows) insert.run(postId, row.channel, row.providerAccountId, timestamp);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getPostPublishTargets(db, postId);
}
