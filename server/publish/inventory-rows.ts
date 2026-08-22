import type { Db } from '../db.ts';
import {
  providerInventoryOrphans,
  type ProviderInventoryAccount,
  type ProviderInventoryEntry,
  type ProviderInventoryPost,
} from '../../shared/provider-inventory.ts';
import { PROVIDER_POST_STATES, type ProviderPostState } from '../../shared/publish.ts';
import { isSignalChannel } from '../../shared/signal.ts';

/**
 * The read-only half of the provider inventory.
 *
 * Every function here lists, and there is no counterpart in this file that writes one — the same
 * split `read.ts` keeps from `service.ts`, for the same reason. The queue-health summary is the main
 * caller, and it must be able to conclude an alert about what the provider holds without importing
 * anything that could ask the provider or replace a generation.
 *
 * Nothing here reaches the network. The rows were stored by somebody's own press of **Refresh
 * inventory**; reading them is local, which is what keeps `deriveQueueHealth` free of provider calls.
 */

export interface ProviderInventoryRow {
  provider_post_id: string;
  state: string;
  scheduled_instant: string | null;
  caption_excerpt: string;
  /** A JSON array of provider account ids. See `server/db.ts` for why it is packed. */
  account_ids: string;
  provider_url: string | null;
  snapshot_at: string;
}

/** A stored state this build does not know reads as the fail-closed one, never as scheduled. */
const storedState = (value: string): ProviderPostState =>
  (PROVIDER_POST_STATES as readonly string[]).includes(value)
    ? (value as ProviderPostState)
    : 'PROCESSING';

/** Account ids, defensively: a column this build cannot parse reads as no accounts named. */
const storedAccountIds = (value: string): number[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id))
      : [];
  } catch {
    return [];
  }
};

export const toProviderInventoryPost = (row: ProviderInventoryRow): ProviderInventoryPost => ({
  providerPostId: row.provider_post_id,
  state: storedState(row.state),
  scheduledInstant: row.scheduled_instant,
  captionExcerpt: row.caption_excerpt,
  accountIds: storedAccountIds(row.account_ids),
  ...(row.provider_url ? { providerUrl: row.provider_url } : {}),
});

const inventoryRows = (db: Db): ProviderInventoryRow[] =>
  db
    .prepare(
      `SELECT * FROM signal_provider_posts
       ORDER BY scheduled_instant IS NULL, scheduled_instant, provider_post_id`,
    )
    .all() as unknown as ProviderInventoryRow[];

/** The stored generation, soonest scheduled first, with undated rows last. */
export const readProviderInventoryPosts = (db: Db): ProviderInventoryPost[] =>
  inventoryRows(db).map(toProviderInventoryPost);

/**
 * Every provider post id a local publication claims.
 *
 * **All of them**, with no window and no state filter, which is the point: `publicationsForHealth`
 * bounds what the summary reports on, and bounding this would turn every post sent before the
 * lookback into an orphan. A cancelled or failed publication counts too — this app created that
 * post, whatever became of it.
 */
export const knownProviderPostIds = (db: Db): string[] =>
  (
    db
      .prepare(
        'SELECT DISTINCT provider_post_id FROM signal_publications WHERE provider_post_id IS NOT NULL',
      )
      .all() as { provider_post_id: string }[]
  ).map((row) => row.provider_post_id);

/**
 * The handles this workspace happens to know for provider accounts, from its own deliveries.
 *
 * A best-effort label and never a claim about the provider's account list: an id this app has never
 * delivered to is shown as an id. The newest delivery wins where a handle has changed, because a row
 * showing the name an account used to have would be worse than showing none.
 */
const accountLabels = (db: Db): Map<number, ProviderInventoryAccount> => {
  const rows = db
    .prepare(
      `SELECT t.provider_account_id AS account_id, t.handle, t.channel
         FROM signal_publication_targets t
         JOIN signal_publications p ON p.id = t.publication_id
        ORDER BY p.created_at ASC, p.id`,
    )
    .all() as { account_id: number; handle: string; channel: string }[];
  const labels = new Map<number, ProviderInventoryAccount>();
  for (const row of rows)
    labels.set(row.account_id, {
      accountId: row.account_id,
      ...(row.handle ? { handle: row.handle } : {}),
      ...(isSignalChannel(row.channel) ? { channel: row.channel } : {}),
    });
  return labels;
};

/**
 * The stored generation as the panel reads it: every row, marked orphan or not, with account labels.
 *
 * The orphan mark is `providerInventoryOrphans`' answer and not a second opinion about it, so the
 * panel and the alert cannot disagree about which posts this app did not make.
 */
export function readProviderInventoryEntries(db: Db): ProviderInventoryEntry[] {
  const rows = inventoryRows(db);
  const posts = rows.map(toProviderInventoryPost);
  const orphans = new Set(
    providerInventoryOrphans(posts, knownProviderPostIds(db)).map((post) => post.providerPostId),
  );
  const labels = accountLabels(db);
  return posts.map((post, index) => ({
    ...post,
    snapshotAt: (rows[index] as ProviderInventoryRow).snapshot_at,
    orphan: orphans.has(post.providerPostId),
    accounts: post.accountIds.map((accountId) => labels.get(accountId) ?? { accountId }),
  }));
}
