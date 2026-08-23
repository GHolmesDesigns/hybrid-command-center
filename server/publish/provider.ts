import type { ProviderPostRecord } from '../../shared/publish.ts';

export type { ProviderPostRecord };

export interface PublishTarget {
  /** Local numeric surrogate used by SQLite joins. Never derived from an opaque provider id. */
  id: number;
  /** Durable provider route. Legacy callers omit it and resolve as Post Bridge. */
  provider?: string;
  /** Provider-owned account identity, kept byte-for-byte. Legacy callers use String(id). */
  accountRef?: string;
  platform: string;
  handle: string;
  name: string;
}

/**
 * One platform's tailored content, as the provider takes it.
 *
 * Per platform, and **no longer the only level** — see `PublishAccountConfiguration` below. This
 * one stays keyed by platform and carries the fields that are platform-level on the wire whatever
 * else is true: a title, a first comment, and a placement. Where a platform's
 * `accountContentOverride` is false, an account override still arrives here as its platform's
 * configuration, which is unambiguous exactly while that platform resolves to one account.
 *
 * A configuration is emitted only where something differs from the submission's own caption, so a
 * post with no overrides sends exactly the request it sent before this existed.
 */
export interface PublishPlatformConfiguration {
  platform: string;
  /** Present when this platform's effective caption differs from the request's caption. */
  caption?: string;
  title?: string;
  firstComment?: string;
  /**
   * A provider placement, and only where the provider has one. A story is a real placement; a reel
   * is one video in the platform's ordinary post, so it is not sent as a placement and nothing
   * pretends otherwise.
   */
  story?: true;
}

/**
 * One account's tailored content, as the provider takes it (C77).
 *
 * C73's live probe verified this level and its exact encoding — a **list of objects each carrying
 * `account_id`**, read back after create and again after `PATCH`
 * (`docs/post-bridge-api-surface.md` §14, question 1). It is emitted only for a platform whose
 * `accountContentOverride` is true, which today means the one platform that evidence covers.
 *
 * **Two fields, because two fields are what the probe verified.** `caption` and per-account media
 * ids are named by the vendor's `AccountConfigurationDto` and were exercised live. A title, a first
 * comment, a post shape, a placement, and a media role are **not** account-level on this provider:
 * they stay in `PublishPlatformConfiguration` and the preview warns, per account, that an override
 * of one of them travels as the platform's. Adding a field here takes a dated §14 result, exactly
 * as flipping a capability does.
 */
export interface PublishAccountConfiguration {
  accountId: number;
  /** Present when this account's effective caption differs from the request's own. */
  caption?: string;
  /**
   * Provider media ids for this account alone, present only where it selected its own media.
   *
   * Ids and never URLs, for the reason the whole request is a discriminated union: per-account
   * media exists only for an all-Drive post, uploaded immediately before the request through the
   * C75 path. A public-URL account override refuses at preview rather than arriving here.
   */
  mediaIds?: string[];
}

interface PublishRequestBase {
  caption: string;
  scheduledInstant: string;
  timezone: string;
  targets: { accountId: number; provider?: string; accountRef?: string; platform: string }[];
  /** Omitted entirely when no platform is tailored. */
  platformConfigurations?: PublishPlatformConfiguration[];
  /**
   * Omitted entirely when no account is tailored, so a post that predates C77 serialises exactly
   * the request it always did.
   */
  accountConfigurations?: PublishAccountConfiguration[];
}

/**
 * One provider submission carries public URLs or freshly uploaded provider ids, never both.
 *
 * Keeping the alternatives in the type prevents the adapter from accidentally serialising both
 * keys and relying on the provider's current "media wins" behaviour. Drive ids are ephemeral and
 * are produced immediately before the request; they are not Signal media references.
 */
export type PublishRequest = PublishRequestBase &
  ({ mediaUrls: string[]; mediaIds?: never } | { mediaIds: string[]; mediaUrls?: never });

/** A byte source with no Drive vocabulary in it. */
export interface PublishMediaSource {
  name: string;
  mimeType: string;
  sizeBytes: number;
  body: AsyncIterable<Uint8Array>;
}

export interface PublishMediaUpload {
  mediaId: string;
}

export interface PublishSubmission {
  providerPostId: string;
  state: 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'FAILED';
  targets?: {
    accountId: number;
    /** One-provider-per-target post identity; absent for Post Bridge's group submission. */
    remotePostId?: string;
    outcome: 'SUCCESS' | 'FAILURE';
    /**
     * The provider's own identity for this one delivery — the `post-results` row id, which is
     * neither the post id nor the account id.
     *
     * It is the only handle the analytics endpoints accept, and this response is the only place it
     * appears, which is why reconciliation is where it gets captured. Optional because a response
     * that omits it has said nothing about it: the service stores what it is given and never
     * overwrites a known identity with an absent one.
     */
    resultId?: string;
    permalink?: string;
    error?: string;
  }[];
  error?: string;
}

export class PublishProviderError extends Error {
  readonly ambiguous: boolean;
  /**
   * Whether the provider refused because we are asking too often.
   *
   * Kept apart from `ambiguous`, which is about whether the request may have landed. A rate limit
   * landed nothing and is not a fact about this post at all — it is a fact about the connection, and
   * `docs/publishing-integration.md` §9 makes any 429 authoritative. The app reports it rather than
   * hiding it inside one post's error, which is what `server/publish/sync-health.ts` records.
   */
  readonly rateLimited: boolean;
  /** How long the provider asked us to wait, in seconds, where it said. */
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    ambiguous = false,
    rateLimit: { rateLimited?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'PublishProviderError';
    this.ambiguous = ambiguous;
    this.rateLimited = rateLimit.rateLimited ?? false;
    if (rateLimit.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = rateLimit.retryAfterSeconds;
  }
}

/** Upload failed after the provider had already reserved an ephemeral asset id. */
export class PublishMediaUploadError extends PublishProviderError {
  readonly providerMediaId: string;
  constructor(message: string, providerMediaId: string, ambiguous = false, options?: ErrorOptions) {
    super(message, ambiguous);
    this.name = 'PublishMediaUploadError';
    this.providerMediaId = providerMediaId;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * How long to treat the connection as rate-limited when the provider named no delay.
 *
 * The cap §9 sets on backoff, used as the deadline here for the same reason: a limit whose length
 * nobody stated is not a limit to guess low on, and reporting a minute is a claim the next manual
 * refresh can disprove immediately.
 */
export const PUBLISH_RATE_LIMIT_FALLBACK_SECONDS = 60;

export interface PublishProvider {
  readonly available: boolean;
  listTargets(): Promise<PublishTarget[]>;
  /** Creates one ephemeral provider asset. It never retries an ambiguous body transfer. */
  uploadMedia(source: PublishMediaSource, signal?: AbortSignal): Promise<PublishMediaUpload>;
  submit(request: PublishRequest): Promise<PublishSubmission>;
  check(providerPostId: string): Promise<PublishSubmission>;
  /**
   * The provider's own record of one post — what it is holding, not what became of it.
   *
   * Distinct from `check`, which answers *how did the delivery go* out of `post-results`. This
   * answers *what does it currently say*, which is the only honest left-hand side of a difference
   * the user is about to act on. It is read fresh every time and never cached.
   */
  describe(providerPostId: string): Promise<ProviderPostRecord>;
  /**
   * Rewrites a post the provider is still holding, in full.
   *
   * Full-state rather than a partial patch, and that is a safety property rather than a preference:
   * Post Bridge processes a scheduled post **immediately** when an update omits `scheduled_at`, so
   * an adapter that forwarded only the changed fields would publish a post early the first time
   * someone edited a caption. Every implementation sends the whole request, which also makes the
   * call idempotent by end state — the same request twice leaves the same post.
   */
  update(providerPostId: string, request: PublishRequest): Promise<PublishSubmission>;
  cancel(providerPostId: string): Promise<void>;
}

export class UnavailablePublishProvider implements PublishProvider {
  readonly available = false;
  private readonly reason: string;
  constructor(reason = 'Publishing is not configured.') {
    this.reason = reason;
  }
  private fail(): never {
    throw new Error(this.reason);
  }
  async listTargets(): Promise<PublishTarget[]> {
    return this.fail();
  }
  async uploadMedia(
    _source: PublishMediaSource,
    _signal?: AbortSignal,
  ): Promise<PublishMediaUpload> {
    void _source;
    void _signal;
    return this.fail();
  }
  async submit(_request: PublishRequest): Promise<PublishSubmission> {
    void _request;
    return this.fail();
  }
  async check(_providerPostId: string): Promise<PublishSubmission> {
    void _providerPostId;
    return this.fail();
  }
  async describe(_providerPostId: string): Promise<ProviderPostRecord> {
    void _providerPostId;
    return this.fail();
  }
  async update(_providerPostId: string, _request: PublishRequest): Promise<PublishSubmission> {
    void _providerPostId;
    void _request;
    return this.fail();
  }
  async cancel(_providerPostId: string): Promise<void> {
    void _providerPostId;
    return this.fail();
  }
}
