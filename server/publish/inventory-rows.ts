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
  provider: string;
  provider_post_id: string;
  state: string;
  scheduled_instant: string | null;
  caption_excerpt: string;
  /** A JSON array of opaque provider account references. */
  account_refs: string;
  provider_url: string | null;
  snapshot_at: string;
}

/** A stored state this build does not know reads as the fail-closed one, never as scheduled. */
const storedState = (value: string): ProviderPostState =>
  (PROVIDER_POST_STATES as readonly string[]).includes(value)
    ? (value as ProviderPostState)
    : 'PROCESSING';

/** Account ids, defensively: a column this build cannot parse reads as no accounts named. */
const storedAccountRefs = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

export const toProviderInventoryPost = (
  row: ProviderInventoryRow,
  localIds = new Map<string, number>(),
): ProviderInventoryPost => ({
  provider: row.provider,
  providerPostId: row.provider_post_id,
  state: storedState(row.state),
  scheduledInstant: row.scheduled_instant,
  captionExcerpt: row.caption_excerpt,
  accountIds: storedAccountRefs(row.account_refs).flatMap((ref) => {
    const id = localIds.get(ref);
    return id === undefined ? [] : [id];
  }),
  accountRefs: storedAccountRefs(row.account_refs),
  ...(row.provider_url ? { providerUrl: row.provider_url } : {}),
});

const inventoryRows = (db: Db, provider: string): ProviderInventoryRow[] =>
  db
    .prepare(
      `SELECT * FROM signal_provider_inventory_posts WHERE provider=?
       ORDER BY scheduled_instant IS NULL, scheduled_instant, provider_post_id`,
    )
    .all(provider) as unknown as ProviderInventoryRow[];

const localAccountIds = (db: Db, provider: string): Map<string, number> =>
  new Map(
    (
      db
        .prepare(`SELECT id,provider_account_ref FROM signal_provider_accounts WHERE provider=?`)
        .all(provider) as { id: number; provider_account_ref: string }[]
    ).map((row) => [row.provider_account_ref, row.id]),
  );

/** The stored generation, soonest scheduled first, with undated rows last. */
export const readProviderInventoryPosts = (
  db: Db,
  provider = 'post-bridge',
): ProviderInventoryPost[] => {
  const ids = localAccountIds(db, provider);
  return inventoryRows(db, provider).map((row) => toProviderInventoryPost(row, ids));
};

/**
 * Every provider post id a local publication claims.
 *
 * **All of them**, with no window and no state filter, which is the point: `publicationsForHealth`
 * bounds what the summary reports on, and bounding this would turn every post sent before the
 * lookback into an orphan. A cancelled or failed publication counts too — this app created that
 * post, whatever became of it.
 */
export const knownProviderPostIds = (db: Db, provider = 'post-bridge'): string[] =>
  (
    db
      .prepare(
        `SELECT DISTINCT provider_post_id FROM signal_publications
          WHERE provider=? AND provider_post_id IS NOT NULL`,
      )
      .all(provider) as { provider_post_id: string }[]
  ).map((row) => row.provider_post_id);

/**
 * The handles this workspace happens to know for provider accounts, from its own deliveries.
 *
 * A best-effort label and never a claim about the provider's account list: an id this app has never
 * delivered to is shown as an id. The newest delivery wins where a handle has changed, because a row
 * showing the name an account used to have would be worse than showing none.
 */
const accountLabels = (db: Db, provider: string): Map<string, ProviderInventoryAccount> => {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, a.provider_account_ref, a.handle, t.channel
         FROM signal_provider_accounts a
         LEFT JOIN signal_publication_targets t ON t.provider_account_id=a.id
         LEFT JOIN signal_publications p ON p.id=t.publication_id
        WHERE a.provider=?
        ORDER BY p.created_at ASC, p.id`,
    )
    .all(provider) as {
    account_id: number;
    provider_account_ref: string;
    handle: string;
    channel: string | null;
  }[];
  const labels = new Map<string, ProviderInventoryAccount>();
  for (const row of rows)
    labels.set(row.provider_account_ref, {
      accountId: row.account_id,
      provider,
      accountRef: row.provider_account_ref,
      ...(row.handle ? { handle: row.handle } : {}),
      ...(row.channel && isSignalChannel(row.channel) ? { channel: row.channel } : {}),
    });
  return labels;
};

/**
 * The stored generation as the panel reads it: every row, marked orphan or not, with account labels.
 *
 * The orphan mark is `providerInventoryOrphans`' answer and not a second opinion about it, so the
 * panel and the alert cannot disagree about which posts this app did not make.
 */
export function readProviderInventoryEntries(
  db: Db,
  provider = 'post-bridge',
): ProviderInventoryEntry[] {
  const rows = inventoryRows(db, provider);
  const ids = localAccountIds(db, provider);
  const posts = rows.map((row) => toProviderInventoryPost(row, ids));
  const orphans = new Set(
    providerInventoryOrphans(
      posts,
      knownProviderPostIds(db, provider).map((providerPostId) => ({ provider, providerPostId })),
    ).map((post) => post.providerPostId),
  );
  const labels = accountLabels(db, provider);
  return posts.map((post, index) => ({
    ...post,
    snapshotAt: (rows[index] as ProviderInventoryRow).snapshot_at,
    orphan: orphans.has(post.providerPostId),
    accounts: (post.accountRefs ?? []).map(
      (accountRef) => labels.get(accountRef) ?? { provider, accountRef },
    ),
  }));
}
