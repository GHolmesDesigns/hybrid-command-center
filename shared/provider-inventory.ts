import { PROVIDER_POST_STATE_LABEL, type ProviderPostState } from './publish.ts';
import type { SignalChannel } from './signal.ts';

/**
 * What else is in the provider: the vocabulary of an inventory this app did not create.
 *
 * `describe` answers *what does the provider say about this id*. Nothing answered *what else is in
 * there* — and a post created in the Post Bridge UI, by a VA, or by an agent over their MCP server
 * is the thing most likely to collide with a scheduled slot this app believes is empty.
 *
 * ## What this module is, and what it deliberately is not
 *
 * Everything here is a rule or a bound, and nothing here has a database, a clock, or a network in
 * it. The pagination contract, the caption excerpt, the safety bounds, which listed post counts as
 * an orphan, and the fingerprint an acknowledgement is taken against are all decided here, so each
 * of them is testable as data in and data out — and so there is exactly one of each. The pagination
 * rule in particular is shared with `scripts/probe-post-bridge/probe.ts`, which is where it was
 * verified: a second copy of it would be a second answer to *is this the last page*.
 *
 * ## An inventory is a snapshot, and it is read-only
 *
 * A row is what the provider said at `snapshotAt` and nothing more. There is no adoption, no
 * linking, no import, and no way to cancel or update one of these from this app — declined
 * explicitly in §0.3 of `docs/post-bridge-integrations-plan.md` — so nothing in this vocabulary
 * describes an action. The inventory is refreshed only when a person presses something; the alert
 * derived from it reads stored rows, which is what keeps `deriveQueueHealth` free of the network.
 */

/**
 * How wide one page is asked for, and how far a walk may go before it gives up.
 *
 * A hundred rows a page is the width C73 verified the contract at
 * (`docs/post-bridge-api-surface.md` §14, question 4), and twenty pages is the safety bound: two
 * thousand posts is far more than any workspace this app plans for holds, so reaching it means the
 * walk is not terminating rather than that the inventory is large. Hitting either bound fails the
 * refresh — it never truncates, because a short inventory silently presented as a complete one is
 * exactly the orphan that goes unnoticed.
 */
export const PROVIDER_INVENTORY_PAGE_SIZE = 100;
export const PROVIDER_INVENTORY_PAGE_MAX = 20;
export const PROVIDER_INVENTORY_ROW_MAX =
  PROVIDER_INVENTORY_PAGE_SIZE * PROVIDER_INVENTORY_PAGE_MAX;

/**
 * How much of somebody else's caption is stored.
 *
 * Enough to recognise a post, and bounded on purpose: this app stores no raw provider response and
 * no unbounded caption, because an inventory row exists to answer *is this one of mine* and not to
 * hold a copy of content the provider owns.
 */
export const PROVIDER_INVENTORY_CAPTION_MAX = 140;

/**
 * A caption reduced to one line and bounded.
 *
 * Whitespace is collapsed before the cut so a caption written as five short lines is recognisable
 * rather than arriving as its first word; the ellipsis is part of the budget, so no excerpt is ever
 * longer than the bound whatever the input was.
 */
export function providerInventoryCaptionExcerpt(caption: string): string {
  const line = caption.replace(/\s+/g, ' ').trim();
  return line.length > PROVIDER_INVENTORY_CAPTION_MAX
    ? `${line.slice(0, PROVIDER_INVENTORY_CAPTION_MAX - 1)}…`
    : line;
}

/**
 * One post the provider is holding, in this app's vocabulary rather than the vendor's.
 *
 * `providerPostId` is the stable key — C73 verified that every listed row carries an `id` and that a
 * deleted post is absent from a later complete read, which together are what make a generation
 * replaceable by id. The state is the same union a `describe` produces, so a listed post and a
 * described one cannot disagree about what "scheduled" means.
 */
export interface ProviderInventoryPost {
  providerPostId: string;
  state: ProviderPostState;
  /** Null is the provider holding no instant for it, which is its "post immediately". */
  scheduledInstant: string | null;
  /** Bounded by `providerInventoryCaptionExcerpt`. Never the whole caption. */
  captionExcerpt: string;
  accountIds: number[];
  /**
   * The provider's own address for this post, where it supplies one.
   *
   * Optional because the row shape §14 recorded carries no such field. Nothing invents one: a link
   * appears where the provider gave a link and nowhere else.
   */
  providerUrl?: string;
}

/**
 * One account a listed post names, with the local handle where this workspace happens to know it.
 *
 * The provider lists account ids and this app has met some of those accounts through its own
 * deliveries. Where it has, the handle is shown because an id identifies nothing to a reader; where
 * it has not, the id stands alone rather than being guessed at.
 */
export interface ProviderInventoryAccount {
  accountId: number;
  handle?: string;
  channel?: SignalChannel;
}

/** One stored row, as the panel reads it. */
export interface ProviderInventoryEntry extends ProviderInventoryPost {
  /** When the generation this row belongs to was read. */
  snapshotAt: string;
  /** True when no local publication claims this provider id. */
  orphan: boolean;
  accounts: ProviderInventoryAccount[];
}

/**
 * The inventory as it stands, and why it stands that way.
 *
 * `entries` is always a whole generation: every row shares a `snapshotAt`, because a refresh either
 * replaced the lot or replaced nothing. `reason` is why the last attempt did not replace anything,
 * and it sits beside the rows rather than instead of them — a failed read leaves the previous
 * inventory on screen, which is the only honest thing to show.
 */
export interface ProviderInventorySnapshot {
  /** False when no provider is configured, so the panel explains rather than offering a button. */
  available: boolean;
  entries: ProviderInventoryEntry[];
  counts: { posts: number; orphans: number };
  /** When a complete read last replaced the generation. */
  lastRefreshAt?: string;
  reason?: string;
}

/**
 * Where the next page is, or that there is no next page, or that the answer cannot be trusted.
 *
 * The three outcomes are separate values rather than a nullable number because they mean three
 * different things to a refresh: `done` completes it, an `offset` continues it, and `unknown` fails
 * it. An inventory read that guessed at a cursor could return the second page or the first one
 * again, and there is no way to tell which afterwards.
 */
export type ProviderInventoryNextIssue = 'META' | 'NEXT_STRING' | 'NEXT';
export type ProviderInventoryNext =
  { done: true } | { offset: number } | { unknown: ProviderInventoryNextIssue };

/**
 * The pagination contract of `GET /v1/posts`, exactly as C73 verified it.
 *
 * Every list answers `meta: { total, offset, limit, next }`, and the live probe walked to a `null`
 * `meta.next` at limit 100 (`docs/post-bridge-api-surface.md` §14, question 4). Null is therefore
 * the end of the walk. What a *non-null* `next` holds was not observed, because the account held one
 * page — so this reads the two shapes the vendor's own paging could mean and refuses everything
 * else:
 *
 * - a **number**, taken as the next offset;
 * - a **string** carrying `offset=` in a query, taken as that offset — a URL to the next page;
 * - anything else, including an opaque cursor whose parameter name is not in the document, refused
 *   as `unknown`. A refusal fails a refresh, which replaces nothing; a guess would silently replace
 *   a whole inventory with one page of it.
 *
 * `undefined` and `false` end the walk beside `null`: a provider that stops sending the field, or
 * sends it as "no more", has said there is no next page in the only ways that phrase can arrive.
 * A `meta` that is not an object at all is `unknown` rather than `done`, because a response missing
 * its envelope has not said anything about completeness.
 */
export function providerInventoryNextPage(meta: unknown): ProviderInventoryNext {
  if (!meta || typeof meta !== 'object') return { unknown: 'META' };
  const next = (meta as Record<string, unknown>).next;
  if (next === null || next === undefined || next === false) return { done: true };
  if (typeof next === 'number')
    return Number.isSafeInteger(next) && next >= 0 ? { offset: next } : { unknown: 'NEXT' };
  if (typeof next === 'string') {
    const match = /(?:^|[?&])offset=(\d+)/.exec(next);
    return match ? { offset: Number(match[1]) } : { unknown: 'NEXT_STRING' };
  }
  return { unknown: 'NEXT' };
}

/**
 * The listed posts no local publication claims.
 *
 * The whole of the orphan rule, in one function, used by the alert and by the panel. Membership is
 * by provider id and nothing else: a caption that happens to match a Signal post is not evidence
 * that this app sent it, and matching on one would make an orphan disappear the moment somebody
 * planned something similar.
 *
 * The ids it is asked about must be *every* publication's, not a recent window's. A post this app
 * sent last year is still one it sent.
 */
export function providerInventoryOrphans<T extends { providerPostId: string }>(
  posts: readonly T[],
  knownProviderPostIds: readonly string[],
): T[] {
  const known = new Set(knownProviderPostIds);
  return posts.filter((post) => !known.has(post.providerPostId));
}

/**
 * The facts an orphan acknowledgement is taken against: the provider ids and their states.
 *
 * Sorted, so the same inventory read twice fingerprints the same. Both halves matter — an orphan
 * that gets published has moved on, and a new one appearing is a new situation — so acknowledging
 * *these three, in these states* does not dismiss the fourth, and does not stay dismissed once one
 * of the three goes out.
 */
export function providerInventoryFingerprint(
  posts: readonly { providerPostId: string; state: ProviderPostState }[],
): string {
  return posts
    .map((post) => `${post.providerPostId}:${post.state}`)
    .sort()
    .join('|');
}

/**
 * One listed post named the way a reader recognises it: its excerpt, or its state and its id.
 *
 * A provider post has no title and its caption may be empty — a media-only post is ordinary — so
 * there has to be an answer for a row that carries no words at all.
 */
export function providerInventoryPostName(post: ProviderInventoryPost): string {
  return post.captionExcerpt || `${PROVIDER_POST_STATE_LABEL[post.state]} · ${post.providerPostId}`;
}
