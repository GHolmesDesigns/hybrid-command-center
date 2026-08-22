import { PublishProviderError } from './provider.ts';
import type { ProviderInventoryPage } from './inventory-provider.ts';
import {
  providerInventoryCaptionExcerpt,
  providerInventoryNextPage,
  type ProviderInventoryPost,
} from '../../shared/provider-inventory.ts';
import type { ProviderPostState } from '../../shared/publish.ts';

/**
 * `GET /v1/posts` on the wire: the request this app sends, and how a page is read.
 *
 * Pure and covered, like `post-bridge-wire.ts` beside it, and for the same reason: the live adapter
 * in `post-bridge.ts` is `fetch` and a bearer token and is exercised only by the owner's manual QA,
 * so anything that decides what a response *means* has to live where a fixture can reach it. Every
 * field name here is the vendor's, spelled the way `docs/post-bridge-api-surface.md` §14 read it out
 * of a live response.
 */

/**
 * The vendor's `status` and `is_draft` collapsed into the one union the app's rules read.
 *
 * `is_draft` wins over `status`, because a draft the vendor also calls `scheduled` is still a draft —
 * nothing goes out until it is updated — and treating it as scheduled would let the app say a post
 * is on its way when it is sitting in Post Bridge waiting for somebody. Anything unrecognised becomes
 * `PROCESSING`, which is the fail-closed answer: it is the one state the mutation rules refuse, so a
 * status this adapter has never seen cannot be written over.
 *
 * Shared by `describe` and by the inventory read, because it is one question — *what is the provider
 * holding this as* — and a listed post and a described post must not answer it differently.
 */
export function postBridgeRecordState(
  status: string | undefined,
  isDraft: boolean,
): ProviderPostState {
  if (isDraft) return 'DRAFT';
  switch (status) {
    case 'posted':
      return 'PUBLISHED';
    case 'failed':
      return 'FAILED';
    case 'scheduled':
      return 'SCHEDULED';
    default:
      return 'PROCESSING';
  }
}

export interface PostBridgeInventoryQuery {
  limit: number;
  offset: number;
  /** Provider status values, in the vendor's own spelling. Omitted asks for every state. */
  statuses?: readonly string[];
  /** Provider platform names. Omitted asks for every platform. */
  platforms?: readonly string[];
}

/**
 * The path one page is asked for at.
 *
 * `limit` and `offset` are always sent: the endpoint defaults to ten rows, so a walk that omitted
 * them would read a tenth of a page at a time and call the result an inventory. Both are verified —
 * §14's question 4 walked pages at `limit=100` to a null `meta.next`.
 *
 * **The filter parameters are here and the app sends neither.** Which repeatable encoding actually
 * filters is the one claim the two probe runs contradict each other on: 20 August saw `status[]`
 * filter correctly, 22 August saw it return a row that was not scheduled while the bare repeated
 * name returned only scheduled rows. §14 records the encoding as *unresolved across sessions* and
 * requires a dedicated read before a request builder is built on either answer. An encoding that
 * silently fails to filter returns a superset, and a snapshot replacement would carry that straight
 * into the database.
 *
 * An unfiltered read is immune to all of it, which is why `ProviderInventoryService` sends no filter
 * and gets a superset on purpose: *what else is in there* is the question, and every state is part of
 * the answer. These parameters exist so that the shape lives in one tested place, and they default to
 * the bare repeated name — what the most recent run saw filter correctly. Sending one takes a dated
 * §14 result, exactly as flipping a capability does.
 */
export function postBridgeInventoryPath(query: PostBridgeInventoryQuery): string {
  const parts = [`limit=${query.limit}`, `offset=${query.offset}`];
  for (const status of query.statuses ?? []) parts.push(`status=${encodeURIComponent(status)}`);
  for (const platform of query.platforms ?? [])
    parts.push(`platform=${encodeURIComponent(platform)}`);
  return `/posts?${parts.join('&')}`;
}

const refuse = (detail: string): never => {
  throw new PublishProviderError(
    `Post Bridge listed a post this app cannot read: ${detail}`,
    false,
  );
};

/**
 * One account id out of a listed row's `social_accounts`.
 *
 * §14 recorded the array's presence and its length and not its element type, so the three shapes it
 * could be are all read: the id itself, the id as a string, and an object carrying one. Anything
 * else fails the page rather than being skipped — an inventory row that quietly lost an account
 * would say a post reaches fewer places than it does.
 */
function accountId(value: unknown): number {
  let raw: unknown = value;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    raw = row.id !== undefined ? row.id : row.social_account_id;
  }
  const id = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0
    ? id
    : refuse(`an account it names is ${JSON.stringify(value)}`);
}

/**
 * One listed row, normalized — or a refusal.
 *
 * The strictness is deliberate and it is not uniform, because the fields do not carry the same
 * weight. **Identity and state are strict**: a row with no readable `id`, a `status` that is not a
 * string, an `is_draft` that is not a boolean, a caption that is not a string, a `scheduled_at` that
 * is neither null nor an instant, or an account it cannot read, fails the whole refresh. Those are
 * the fields a snapshot *is*, and storing a guess for one of them would put a row in the inventory
 * that says something the provider never said.
 *
 * **A provider address is lenient**: the row shape §14 observed carries no URL field at all, so
 * anything other than an `https:` string there is simply absent. Refusing a whole generation over a
 * field nobody has ever seen arrive would make the inventory fail closed against its own
 * future-proofing.
 *
 * An unrecognised `status` *value* is not malformed — it becomes `PROCESSING` through
 * `postBridgeRecordState`, which is the fail-closed state — because the vendor adding a state is
 * ordinary and refusing the inventory over it would be this app breaking on someone else's release.
 */
export function parsePostBridgeInventoryRow(value: unknown): ProviderInventoryPost {
  if (!value || typeof value !== 'object') return refuse(`a row is ${JSON.stringify(value)}`);
  const row = value as Record<string, unknown>;
  const id =
    typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id).trim() : undefined;
  if (!id) return refuse('a row carries no id');
  if (row.status !== undefined && typeof row.status !== 'string')
    return refuse(`the status of ${id} is ${JSON.stringify(row.status)}`);
  if (row.is_draft !== undefined && typeof row.is_draft !== 'boolean')
    return refuse(`the draft flag of ${id} is ${JSON.stringify(row.is_draft)}`);
  if (row.caption !== undefined && row.caption !== null && typeof row.caption !== 'string')
    return refuse(`the caption of ${id} is not text`);
  const scheduled = row.scheduled_at;
  if (
    scheduled !== undefined &&
    scheduled !== null &&
    (typeof scheduled !== 'string' || !Number.isFinite(Date.parse(scheduled)))
  )
    return refuse(`the scheduled instant of ${id} is ${JSON.stringify(scheduled)}`);
  const accounts = row.social_accounts;
  if (accounts !== undefined && accounts !== null && !Array.isArray(accounts))
    return refuse(`the accounts of ${id} are ${JSON.stringify(accounts)}`);
  const url = [row.url, row.share_url, row.permalink].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.startsWith('https://'),
  );
  return {
    providerPostId: id,
    state: postBridgeRecordState(row.status as string | undefined, row.is_draft === true),
    scheduledInstant: typeof scheduled === 'string' ? scheduled : null,
    captionExcerpt: providerInventoryCaptionExcerpt(
      typeof row.caption === 'string' ? row.caption : '',
    ),
    accountIds: ((accounts ?? []) as unknown[]).map(accountId),
    ...(url ? { providerUrl: url } : {}),
  };
}

/**
 * One page: `data` as rows, `meta` as the answer about the next page.
 *
 * A body with no `data` array is refused rather than read as an empty page, which is the difference
 * between *the provider holds nothing* and *this app did not understand the answer*. The first is an
 * inventory; the second is a failed refresh that must replace nothing.
 *
 * `meta` is not validated here beyond the pagination rule: `providerInventoryNextPage` returns
 * `unknown` for an envelope it cannot read, and the caller fails the refresh on it. Deciding it here
 * would put half the walk in the parser.
 */
export function parsePostBridgeInventoryPage(body: unknown): ProviderInventoryPage {
  if (!body || typeof body !== 'object') return refuse(`a page is ${JSON.stringify(body ?? null)}`);
  const rows = (body as Record<string, unknown>).data;
  if (!Array.isArray(rows)) return refuse('a page carried no list of posts');
  return {
    posts: rows.map(parsePostBridgeInventoryRow),
    next: providerInventoryNextPage((body as Record<string, unknown>).meta),
  };
}
