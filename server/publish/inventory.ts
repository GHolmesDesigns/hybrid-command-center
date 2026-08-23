import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import {
  providerInventoryOrphans,
  PROVIDER_INVENTORY_PAGE_MAX,
  PROVIDER_INVENTORY_PAGE_SIZE,
  PROVIDER_INVENTORY_ROW_MAX,
  type ProviderInventoryPost,
  type ProviderInventorySnapshot,
} from '../../shared/provider-inventory.ts';
import { PublishProviderError, PUBLISH_RATE_LIMIT_FALLBACK_SECONDS } from './provider.ts';
import type { ProviderInventoryProvider } from './inventory-provider.ts';
import { knownProviderPostIds, readProviderInventoryEntries } from './inventory-rows.ts';
import { readSyncHealth, recordSyncHealth } from './sync-health.ts';

/**
 * What else is in Post Bridge: read on request, stored as one generation, and never acted on.
 *
 * ## The one thing this service guarantees
 *
 * **Every page is read before anything is written.** The walk accumulates rows in memory; only a
 * walk that reached the provider's own end-of-list marker writes anything at all, and when it does it
 * replaces the whole generation in one transaction. A refusal, a malformed page, a cursor that does
 * not advance, or a safety bound leaves every prior row exactly where it was and records the failure.
 * There is no mixed-generation inventory, and no row that keeps raising an alert merely because a
 * later read could not be finished.
 *
 * That is also why the outcome vocabulary is only `SUCCESS` or `FAILURE`. `PARTIAL` means *some of it
 * landed*, and by construction none of it can: the write is one transaction after every read. A
 * future design that deliberately persisted some provider rows would be the thing that made
 * `PARTIAL` correct here.
 *
 * ## Read-only, in the strong sense
 *
 * The provider it holds can list and nothing else (`inventory-provider.ts`), so nothing on this path
 * can submit, update, cancel, or adopt a post. Locally it writes
 * `signal_provider_inventory_posts`, its own provider-qualified settings row, and one
 * `integration_events` row per attempt — never a post, a publication, a target, or a planning
 * status. Adoption, linking, and importing an orphan are declined in §0.3 of
 * `docs/post-bridge-integrations-plan.md`, and there is nothing here that could do one.
 *
 * ## Only when a person presses something
 *
 * `read` makes no provider call on any path, and `refresh` is reached only from the route a button
 * calls. There is no timer, no schedule, and no background job — which is what lets the queue-health
 * alert derive from stored rows and keeps `deriveQueueHealth` free of the network.
 */

/**
 * The record of the last attempt: when a complete read last replaced the generation, and why the
 * most recent one did not.
 *
 * A settings row rather than a table because there is exactly one of it, the same reason
 * `sync-health.ts` is one. It is deliberately *not* a snapshot row and cannot become one: it holds no
 * provider post, so writing it on a failed refresh cannot produce a mixed generation — the rows carry
 * their own `snapshot_at` and a failed read leaves every one of them untouched. Without it a failed
 * refresh could only say nothing, and a panel that silently keeps showing last week's inventory is
 * the thing this card exists to prevent.
 *
 * Nothing here is a credential and nothing here is a provider response body: one timestamp and one
 * already-redacted sentence.
 */
export const PROVIDER_INVENTORY_KEY = 'signal_provider_inventory';
const inventoryKey = (provider: string) =>
  provider === 'post-bridge' ? PROVIDER_INVENTORY_KEY : `${PROVIDER_INVENTORY_KEY}:${provider}`;

interface StoredInventoryRecord {
  lastRefreshAt?: string;
  reason?: string;
}

/** The stored record, or nothing. A row this build cannot parse is treated as absent. */
export function readProviderInventoryRecord(
  db: Db,
  provider = 'post-bridge',
): StoredInventoryRecord {
  const raw = getSetting(db, inventoryKey(provider));
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as StoredInventoryRecord;
    return {
      ...(typeof stored.lastRefreshAt === 'string' ? { lastRefreshAt: stored.lastRefreshAt } : {}),
      ...(typeof stored.reason === 'string' ? { reason: stored.reason } : {}),
    };
  } catch {
    return {};
  }
}

const writeProviderInventoryRecord = (
  db: Db,
  record: StoredInventoryRecord,
  provider = 'post-bridge',
): void => {
  setSetting(
    db,
    inventoryKey(provider),
    JSON.stringify({
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    }),
  );
};

/** What a walk that could not finish has to say for itself. */
class InventoryReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryReadError';
  }
}

export class ProviderInventoryService {
  private readonly db: Db;
  private readonly provider: ProviderInventoryProvider;
  private readonly clock: () => Date;
  private readonly providerId: string;
  // Declared and assigned rather than constructor parameter properties: the server runs under
  // `node --experimental-strip-types` (`AGENTS.md` §Conventions).
  constructor(
    db: Db,
    provider: ProviderInventoryProvider,
    clock: () => Date = () => new Date(),
    providerId = 'post-bridge',
  ) {
    this.db = db;
    this.provider = provider;
    this.clock = clock;
    this.providerId = providerId;
  }

  /**
   * The stored inventory. No provider call on any path through this method.
   *
   * Which is what lets the planner show what the provider was holding the moment the page opens,
   * without a page load ever spending a provider request.
   */
  read(): ProviderInventorySnapshot {
    const entries = readProviderInventoryEntries(this.db, this.providerId);
    const record = readProviderInventoryRecord(this.db, this.providerId);
    return {
      available: this.provider.available,
      entries,
      counts: {
        posts: entries.length,
        orphans: entries.filter((entry) => entry.orphan).length,
      },
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    };
  }

  /**
   * Reads every page, then replaces the generation — or replaces nothing and says why.
   *
   * The two refusals that happen *before* any provider call are not attempts and write no event: an
   * unconfigured provider was never asked, and a rate limit in force means §9 forbids asking
   * (`docs/publishing-integration.md`). Every attempt that does reach the provider writes exactly one
   * `SUCCESS` or `FAILURE` event.
   */
  async refresh(): Promise<ProviderInventorySnapshot> {
    const stored = this.read();
    if (!this.provider.available)
      return { ...stored, reason: 'The provider inventory needs POST_BRIDGE_API_KEY.' };
    const waiting = readSyncHealth(this.db)?.rateLimitedUntil;
    if (waiting && Date.parse(waiting) > this.clock().getTime())
      return {
        ...stored,
        reason: `The provider is rate-limiting this app until ${waiting}. Nothing is asked before then, so the inventory below is the last one it gave.`,
      };

    let posts: ProviderInventoryPost[];
    try {
      posts = await this.walk();
    } catch (error) {
      return this.failed(error as Error);
    }
    return this.replace(posts);
  }

  /**
   * Every page, in order, with the bounds that make the walk finite.
   *
   * Four ways it stops without an inventory, and each of them throws rather than returning what it
   * has: the provider refuses a page, a page cannot be read, `meta.next` is a shape nobody has
   * verified, or the next offset does not advance past the one just read — which is what a repeated
   * cursor looks like from here. The page and row bounds are the backstop for a provider that keeps
   * answering with a fresh offset for ever.
   *
   * Rows are keyed by provider id as they arrive, so a post that shifts between pages while the walk
   * is running is one row rather than two, and the last page to mention it wins.
   */
  private async walk(): Promise<ProviderInventoryPost[]> {
    const posts = new Map<string, ProviderInventoryPost>();
    let offset = 0;
    for (let page = 1; page <= PROVIDER_INVENTORY_PAGE_MAX; page += 1) {
      const answer = await this.provider.page(offset);
      for (const post of answer.posts) posts.set(post.providerPostId, post);
      if (posts.size > PROVIDER_INVENTORY_ROW_MAX)
        throw new InventoryReadError(
          `The provider listed more than ${PROVIDER_INVENTORY_ROW_MAX} posts, which is past the safety bound for one read.`,
        );
      const next = answer.next;
      if ('done' in next) return [...posts.values()];
      if ('unknown' in next)
        throw new InventoryReadError(
          next.unknown === 'META'
            ? 'The provider answered a page without the pagination envelope this app reads.'
            : 'The provider answered with a next-page token this app has not verified, so the rest of the inventory was not guessed at.',
        );
      if (next.offset <= offset)
        throw new InventoryReadError(
          `The provider's next page did not advance past offset ${offset}, so the walk was stopped rather than repeated.`,
        );
      offset = next.offset;
    }
    throw new InventoryReadError(
      `The provider was still listing posts after ${PROVIDER_INVENTORY_PAGE_MAX} pages of ${PROVIDER_INVENTORY_PAGE_SIZE}, so the read was stopped at its safety bound.`,
    );
  }

  /**
   * The generation replaced, in one transaction: absent ids deleted, current rows upserted, the
   * record stamped, and one `SUCCESS` event written.
   *
   * Deleted by difference rather than by emptying the table first, which is the same statement about
   * intent that the card's wording is: a row disappears because the provider stopped listing it, and
   * C73 verified that a deleted post is absent from a later complete read
   * (`docs/post-bridge-api-surface.md` §14, question 4) — so absence is deletion and not silence.
   */
  private replace(posts: ProviderInventoryPost[]): ProviderInventorySnapshot {
    const snapshotAt = this.clock().toISOString();
    const qualified = posts.map((post) => ({ ...post, provider: this.providerId }));
    const orphans = providerInventoryOrphans(
      qualified,
      knownProviderPostIds(this.db, this.providerId).map((providerPostId) => ({
        provider: this.providerId,
        providerPostId,
      })),
    ).length;
    transaction(this.db, () => {
      const listed = new Set(qualified.map((post) => post.providerPostId));
      const remove = this.db.prepare(
        'DELETE FROM signal_provider_inventory_posts WHERE provider=? AND provider_post_id=?',
      );
      for (const row of this.db
        .prepare('SELECT provider_post_id FROM signal_provider_inventory_posts WHERE provider=?')
        .all(this.providerId) as { provider_post_id: string }[])
        if (!listed.has(row.provider_post_id)) remove.run(this.providerId, row.provider_post_id);
      const upsert = this.db.prepare(
        `INSERT INTO signal_provider_inventory_posts(
           provider,provider_post_id,state,scheduled_instant,caption_excerpt,account_refs,provider_url,snapshot_at
         ) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(provider,provider_post_id) DO UPDATE SET
           state=excluded.state, scheduled_instant=excluded.scheduled_instant,
           caption_excerpt=excluded.caption_excerpt, account_refs=excluded.account_refs,
           provider_url=excluded.provider_url, snapshot_at=excluded.snapshot_at`,
      );
      for (const post of qualified)
        upsert.run(
          this.providerId,
          post.providerPostId,
          post.state,
          post.scheduledInstant,
          post.captionExcerpt,
          JSON.stringify(post.accountRefs ?? post.accountIds.map(String)),
          post.providerUrl ?? null,
          snapshotAt,
        );
      writeProviderInventoryRecord(this.db, { lastRefreshAt: snapshotAt }, this.providerId);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.provider-inventory-refresh',
        outcome: 'SUCCESS',
        summary: `Read the whole provider inventory: ${posts.length} ${posts.length === 1 ? 'post' : 'posts'}, ${orphans} of them not created here.`,
      });
    });
    return this.read();
  }

  /**
   * A failed read: nothing replaced, one `FAILURE` event, and the reason on screen.
   *
   * A rate limit is also written to the shared connection record, because a `429` is a fact about the
   * whole connection whichever endpoint returned it (`docs/publishing-integration.md` §9) — the same
   * rule the figures path follows. Nothing else about the connection is touched: this read
   * synchronised no delivery answer, so it has no business stamping `lastSyncedAt`.
   */
  private failed(error: Error): ProviderInventorySnapshot {
    const rateLimited = error instanceof PublishProviderError && error.rateLimited;
    const message = redactSecrets(error.message);
    const reason = `The provider inventory could not be read, so nothing was replaced: ${message}`;
    const stored = readProviderInventoryRecord(this.db, this.providerId);
    transaction(this.db, () => {
      writeProviderInventoryRecord(
        this.db,
        {
          ...(stored.lastRefreshAt ? { lastRefreshAt: stored.lastRefreshAt } : {}),
          reason,
        },
        this.providerId,
      );
      if (rateLimited) {
        const seconds =
          (error as PublishProviderError).retryAfterSeconds ?? PUBLISH_RATE_LIMIT_FALLBACK_SECONDS;
        recordSyncHealth(this.db, {
          rateLimitedUntil: new Date(this.clock().getTime() + seconds * 1000).toISOString(),
        });
      }
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.provider-inventory-refresh',
        outcome: 'FAILURE',
        summary: 'The provider inventory could not be read; no snapshot row was replaced.',
        error: message,
      });
    });
    return this.read();
  }
}
