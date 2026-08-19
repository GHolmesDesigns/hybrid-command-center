import { z } from 'zod';
import type { Db } from '../db.ts';
import {
  SIGNAL_CHANNELS,
  SIGNAL_CTAS,
  SIGNAL_FORMATS,
  SIGNAL_STATUSES,
} from '../../shared/signal.ts';
import archive from './campaign-archive.json' with { type: 'json' };
import { writePostCampaigns } from './campaigns.ts';

/**
 * The campaign content Signal already held, carried across when Signal was re-hosted here.
 *
 * Signal used to be a page that kept its posts in browser storage, where nothing could read
 * them. `campaign-archive.json` is that content — two campaigns, written copy, links and all —
 * lifted out of it once and committed so it is reviewable rather than retyped.
 *
 * ## Why it can be run twice
 *
 * Every post carries a stable id derived from its own content, so importing is idempotent by
 * primary key: a second run inserts nothing, and a post edited after import keeps the row the
 * edit was made on rather than being duplicated beside it or overwritten by the file. Nothing
 * here updates an existing row — this brings content in, it does not push it back over yours.
 *
 * ## What it writes for a campaign
 *
 * The file still names one campaign per post, because that is what Signal held; the importer
 * resolves that name through the shared list and writes the **join**, leaving the frozen
 * `signal_posts.campaign` column NULL like every other write in this app. Resolving is
 * case-insensitive and creates the campaign only when it is new, so importing does not duplicate a
 * campaign a workspace already has under a different spelling.
 *
 * Idempotency is unchanged and for the same reason: the join rows are written only for the posts
 * this run inserts. A post already present is skipped whole, so a second run writes no campaign, no
 * attachment, and no post — and a campaign detached by hand afterwards stays detached, because the
 * importer never revisits a post it did not just create.
 *
 * The archive's labels are `Clarity Campaign — Wk1: The Problem` and its siblings, so a workspace
 * importing it gains one campaign per week rather than one per campaign. That is what the file says,
 * and splitting a label on its dash would be this importer inventing a vocabulary nobody typed.
 *
 * This is not `db:seed`. That invents demo data for an empty workspace; this restores real
 * content the user wrote.
 */

const archivedPost = z.object({
  id: z.string().uuid(),
  text: z.string().min(1),
  channels: z.array(z.enum(SIGNAL_CHANNELS)),
  date: z.string().nullable(),
  time: z.string(),
  format: z.enum(SIGNAL_FORMATS),
  status: z.enum(SIGNAL_STATUSES),
  campaign: z.string().nullable(),
  cta: z.enum(SIGNAL_CTAS),
  position: z.number().int().min(0),
});

export type ArchivedPost = z.output<typeof archivedPost>;

/** The archive, validated against the same vocabulary the API enforces. */
export const campaignArchive = (): ArchivedPost[] => z.array(archivedPost).parse(archive);

export interface ArchiveImportResult {
  /** Posts written by this run. */
  imported: number;
  /** Posts already present, by id, and therefore left exactly as they were. */
  skipped: number;
}

/**
 * Writes any archived post the workspace does not already have, in one transaction, and reports
 * what it did. An import that cannot finish leaves the schedule as it found it.
 *
 * `posts` defaults to the committed archive and is a parameter so that guarantee is testable:
 * a deliberately broken set proves the rollback, which is otherwise only reachable by corrupting
 * the file on disk.
 */
export function importCampaignArchive(
  db: Db,
  posts: ArchivedPost[] = campaignArchive(),
): ArchiveImportResult {
  const existing = new Set(
    (db.prepare('SELECT id FROM signal_posts').all() as unknown as { id: string }[]).map(
      (row) => row.id,
    ),
  );
  const missing = posts.filter((post) => !existing.has(post.id));

  const stamp = new Date().toISOString();
  const insertPost = db.prepare(
    `INSERT INTO signal_posts(id,text,date,time,format,status,cta,position,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertChannel = db.prepare(
    'INSERT INTO signal_post_channels(post_id, channel) VALUES(?,?)',
  );

  db.exec('BEGIN');
  try {
    for (const post of missing) {
      insertPost.run(
        post.id,
        post.text,
        post.date,
        post.time,
        post.format,
        post.status,
        post.cta,
        post.position,
        stamp,
        stamp,
      );
      for (const channel of post.channels) insertChannel.run(post.id, channel);
      // The file's campaign name, resolved through the shared list into the join. A blank or
      // whitespace-only value is a post in no campaign rather than a campaign called nothing.
      if (post.campaign !== null) writePostCampaigns(db, post.id, [post.campaign]);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { imported: missing.length, skipped: posts.length - missing.length };
}
