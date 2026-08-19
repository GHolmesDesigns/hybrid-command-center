import { z } from 'zod';
import type { Db } from '../db.ts';
import {
  compareSignalCampaigns,
  normalizeSignalCampaignName,
  SIGNAL_CAMPAIGN_NAME_MAX,
  SIGNAL_POST_CAMPAIGN_MAX,
  type SignalCampaign,
  type SignalCampaignSummary,
} from '../../shared/signal.ts';

/**
 * The Signal campaign vocabulary: the list itself, and the one place a campaign is created,
 * renamed, or removed.
 *
 * Modelled on task tags and project categories, because it *is* that pattern one module over — a
 * shared, user-managed list of names attached through a join. Which means the three properties
 * `AGENTS.md` states for a label hold here by construction rather than by care: the name lives on
 * the campaign row, so renaming is one write that every post sees; the join cascades, so deleting a
 * campaign detaches it and cannot reach a post; and the name is unique `COLLATE NOCASE`, so the
 * shared spelling rule is enforced by the schema instead of trusted at each call site.
 *
 * It is a module of its own rather than more of `service.ts` for the same reason
 * `queue-health.ts` is: a vocabulary is not a post. What matters about the read/write split in this
 * directory is that nothing reachable through `SignalProvider` writes, and nothing here is — the
 * provider has no campaign method, and the planner reaches these through `app.ts` alone.
 */

const id = () => crypto.randomUUID();

/** A campaign that does not exist, answered as a 404 rather than as a silent no-op. */
export class SignalCampaignNotFoundError extends Error {}

/** A rename onto a name another campaign already holds. */
export class SignalCampaignNameTakenError extends Error {
  readonly name = 'SignalCampaignNameTakenError';
}

/** A deletion that would detach posts, refused until the caller confirms it. */
export class SignalCampaignInUseError extends Error {
  readonly name = 'SignalCampaignInUseError';
  readonly attachedPostCount: number;
  // Declared and assigned rather than a constructor parameter property: the server runs under
  // `node --experimental-strip-types` (`AGENTS.md` §Conventions).
  constructor(message: string, attachedPostCount: number) {
    super(message);
    this.attachedPostCount = attachedPostCount;
  }
}

/** A campaign name as the API accepts one: the shared rule, then the shared bound. */
export const signalCampaignName = z
  .string()
  .transform(normalizeSignalCampaignName)
  .pipe(z.string().min(1, 'A campaign needs a name.').max(SIGNAL_CAMPAIGN_NAME_MAX));

/** Optional decoration on a campaign chip. The name always carries the meaning. */
const campaignColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a #rrggbb colour.')
  .nullish();

export const signalCampaignInput = z.object({ name: signalCampaignName, color: campaignColor });
export const signalCampaignPatch = signalCampaignInput
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide a campaign field to update.',
  });

export type SignalCampaignInput = z.output<typeof signalCampaignInput>;
export type SignalCampaignPatch = z.output<typeof signalCampaignPatch>;

/**
 * The names a post write carries.
 *
 * Names rather than ids, and resolved-or-created on the way in, because the Signal editor saves a
 * whole draft in one press the way it does for channels and media — a chip typed into the form has
 * no id yet, and making the browser create the campaign first would let a failed save leave a
 * campaign nobody asked for. Deduplicated case-insensitively here, before the join's primary key
 * has to refuse a repeat as an error.
 */
export const signalPostCampaignNames = z
  .array(signalCampaignName)
  .max(
    SIGNAL_POST_CAMPAIGN_MAX,
    `A post can belong to at most ${SIGNAL_POST_CAMPAIGN_MAX} campaigns.`,
  )
  .transform((names) => {
    const seen = new Map<string, string>();
    for (const name of names) if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    return [...seen.values()];
  });

interface CampaignRow {
  id: string;
  name: string;
  color: string | null;
}

const toCampaign = (row: CampaignRow): SignalCampaign => ({
  id: row.id,
  name: row.name,
  ...(row.color ? { color: row.color } : {}),
});

/** Every campaign in the workspace, name-ordered, each beside how many posts carry it. */
export function listCampaigns(db: Db): SignalCampaignSummary[] {
  return (
    db
      .prepare(
        `SELECT c.id, c.name, c.color, COUNT(pc.post_id) AS post_count
           FROM signal_campaigns c
           LEFT JOIN signal_post_campaigns pc ON pc.campaign_id = c.id
          GROUP BY c.id
          ORDER BY c.name COLLATE NOCASE, c.id`,
      )
      .all() as unknown as (CampaignRow & { post_count: number })[]
  ).map((row) => ({ ...toCampaign(row), postCount: Number(row.post_count) }));
}

export function getCampaign(db: Db, campaignId: string): SignalCampaign | undefined {
  const row = db
    .prepare('SELECT id, name, color FROM signal_campaigns WHERE id=?')
    .get(campaignId) as CampaignRow | undefined;
  return row ? toCampaign(row) : undefined;
}

/**
 * The campaign holding this name, or a new one.
 *
 * Typing a name that already exists picks that campaign rather than refusing or duplicating it,
 * which is what makes the chip input safe to type into — the same behaviour the categories endpoint
 * has, and the reason the lookup is `COLLATE NOCASE` rather than exact.
 *
 * The caller owns the transaction. Every write path here is part of a larger one.
 */
export function resolveCampaign(db: Db, rawName: string): SignalCampaign {
  const name = normalizeSignalCampaignName(rawName);
  const existing = db
    .prepare('SELECT id, name, color FROM signal_campaigns WHERE name=? COLLATE NOCASE')
    .get(name) as CampaignRow | undefined;
  if (existing) return toCampaign(existing);
  const campaignId = id();
  db.prepare('INSERT INTO signal_campaigns(id,name,color) VALUES(?,?,NULL)').run(campaignId, name);
  return { id: campaignId, name };
}

/**
 * Adds a campaign to the list, or hands back the one already holding the name.
 *
 * `created` is reported rather than inferred, so the route can answer `201` for a new campaign and
 * `200` for a name that was already there — and the browser can say which happened instead of
 * claiming to have added something twice.
 */
export function createCampaign(
  db: Db,
  input: SignalCampaignInput,
): { campaign: SignalCampaign; created: boolean } {
  const existing = db
    .prepare('SELECT id, name, color FROM signal_campaigns WHERE name=? COLLATE NOCASE')
    .get(input.name) as CampaignRow | undefined;
  if (existing) return { campaign: toCampaign(existing), created: false };
  const campaignId = id();
  db.prepare('INSERT INTO signal_campaigns(id,name,color) VALUES(?,?,?)').run(
    campaignId,
    input.name,
    input.color ?? null,
  );
  return { campaign: getCampaign(db, campaignId) as SignalCampaign, created: true };
}

/**
 * Renaming a campaign: one `UPDATE`, on one row.
 *
 * The name is not copied onto the posts, so this is the whole of it — every post carrying the
 * campaign reads the new name on its next read. The clash check is here as well as in the schema
 * because the `UNIQUE` index would refuse the write with a message naming SQLite rather than the
 * campaign that already holds the name.
 */
export function updateCampaign(
  db: Db,
  campaignId: string,
  patch: SignalCampaignPatch,
): SignalCampaign {
  const current = db
    .prepare('SELECT id, name, color FROM signal_campaigns WHERE id=?')
    .get(campaignId) as CampaignRow | undefined;
  if (!current) throw new SignalCampaignNotFoundError(`No Signal campaign ${campaignId}.`);
  const name = patch.name ?? current.name;
  const color = patch.color === undefined ? current.color : (patch.color ?? null);
  const clash = db
    .prepare('SELECT id, name FROM signal_campaigns WHERE name=? COLLATE NOCASE AND id<>?')
    .get(name, campaignId) as { id: string; name: string } | undefined;
  // The clashing campaign's **own** spelling, not the one that was typed: a reader looking for the
  // campaign that is in the way needs the name it is actually listed under.
  if (clash)
    throw new SignalCampaignNameTakenError(`Another campaign is already called “${clash.name}”.`);
  db.prepare('UPDATE signal_campaigns SET name=?,color=? WHERE id=?').run(name, color, campaignId);
  return getCampaign(db, campaignId) as SignalCampaign;
}

export const countCampaignPosts = (db: Db, campaignId: string): number =>
  Number(
    (
      db
        .prepare('SELECT COUNT(*) AS count FROM signal_post_campaigns WHERE campaign_id=?')
        .get(campaignId) as { count: number }
    ).count,
  );

/**
 * Deletes a campaign, detaching it from every post that carries it and deleting none of them.
 *
 * The join rows cascade and no statement here touches `signal_posts` at all, which is what makes
 * that a property of the schema rather than a promise. A campaign attached to posts is refused
 * until `confirm` is passed, so the count can be named before anything is lost — the same
 * confirmation shape tags and categories use.
 */
export function deleteCampaign(
  db: Db,
  campaignId: string,
  confirm: boolean,
): { name: string; detachedFromPosts: number } {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) throw new SignalCampaignNotFoundError(`No Signal campaign ${campaignId}.`);
  const attached = countCampaignPosts(db, campaignId);
  if (attached > 0 && !confirm)
    throw new SignalCampaignInUseError(
      'This campaign is attached to posts. Confirm deletion to detach it everywhere.',
      attached,
    );
  db.prepare('DELETE FROM signal_campaigns WHERE id=?').run(campaignId);
  return { name: campaign.name, detachedFromPosts: attached };
}

/**
 * Replaces the campaigns on one post, resolving each name to a row and creating the ones that are
 * new. The caller owns the transaction; this is called from inside the post write.
 *
 * A replacement rather than a patch, for the same reason channels and media are: the editor holds
 * the whole set while it is being edited, and a post half-attached by a request that reported
 * success would be a plan nobody chose.
 */
export function writePostCampaigns(db: Db, postId: string, names: readonly string[]): void {
  db.prepare('DELETE FROM signal_post_campaigns WHERE post_id=?').run(postId);
  const attach = db.prepare(
    'INSERT OR IGNORE INTO signal_post_campaigns(post_id,campaign_id) VALUES(?,?)',
  );
  // Normalised and deduplicated here as well as at the API boundary, because the archive importer
  // reaches this with whatever its file says. A name that normalises to nothing is a post in no
  // campaign, never a campaign called nothing — which is the one value the unique name column would
  // happily accept and no view could ever render.
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normalizeSignalCampaignName(raw);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    attach.run(postId, resolveCampaign(db, name).id);
  }
}

/**
 * The campaigns attached to a set of posts, grouped by post id, in one statement — so listing a
 * month costs one more query rather than one per post.
 */
export function campaignsByPost(db: Db, postIds: string[]): Map<string, SignalCampaign[]> {
  const grouped = new Map<string, SignalCampaign[]>();
  if (postIds.length === 0) return grouped;
  const placeholders = postIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT pc.post_id, c.id, c.name, c.color
         FROM signal_post_campaigns pc
         JOIN signal_campaigns c ON c.id = pc.campaign_id
        WHERE pc.post_id IN (${placeholders})
        ORDER BY c.name COLLATE NOCASE, c.id`,
    )
    .all(...postIds) as unknown as (CampaignRow & { post_id: string })[];
  for (const row of rows) {
    const attached = grouped.get(row.post_id) ?? [];
    attached.push(toCampaign(row));
    grouped.set(row.post_id, attached);
  }
  // The SQL order is already the shared one; sorting again keeps the two from drifting if a caller
  // ever reaches this with rows from somewhere else.
  for (const [postId, attached] of grouped)
    grouped.set(postId, attached.sort(compareSignalCampaigns));
  return grouped;
}
