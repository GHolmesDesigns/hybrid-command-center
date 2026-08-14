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
  type SignalPost,
} from '../../shared/signal.ts';
import {
  toSignalPost,
  toSignalPosts,
  channelsByPost,
  mediaByPost,
  type SignalPostRow,
} from './rows.ts';

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
  campaign: z.string().trim().max(200).nullable().default(null),
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
  // The post, channels, and media land together: a post missing part of the requested plan would
  // be a half-written record the caller was told succeeded.
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO signal_posts(id,text,date,time,format,status,campaign,cta,position,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      postId,
      input.text,
      input.date,
      input.time,
      input.format,
      input.status,
      input.campaign,
      input.cta,
      input.date === null ? nextQueuePosition(db) : 0,
      timestamp,
      timestamp,
    );
    writeChannels(db, postId, input.channels);
    writeMedia(db, postId, input.mediaUrls);
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
    campaign: patch.campaign === undefined ? existing.campaign : patch.campaign,
    cta: patch.cta ?? existing.cta,
  };
  // A post returning to the queue joins the end of it; one leaving keeps a position nothing
  // reads. Position only ever means something for an undated post.
  const position =
    next.date === null ? (existing.date === null ? existing.position : nextQueuePosition(db)) : 0;

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE signal_posts SET text=?,date=?,time=?,format=?,status=?,campaign=?,cta=?,position=?,updated_at=?
       WHERE id=?`,
    ).run(
      next.text,
      next.date,
      next.time,
      next.format,
      next.status,
      next.campaign,
      next.cta,
      position,
      now(),
      postId,
    );
    if (patch.channels !== undefined) writeChannels(db, postId, patch.channels);
    if (patch.mediaUrls !== undefined) writeMedia(db, postId, patch.mediaUrls);
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
