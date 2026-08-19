import type { ProviderPostRecord } from '../../shared/publish.ts';

export type { ProviderPostRecord };

export interface PublishTarget {
  id: number;
  platform: string;
  handle: string;
  name: string;
}

/**
 * One platform's tailored content, as the provider takes it.
 *
 * Per platform and not per account, which is the provider's own shape: `platform_configurations` is
 * keyed by platform, so an account override arrives as its platform's configuration and the plan
 * refuses rather than guessing when two accounts on one platform disagree
 * (`shared/publish-capabilities.ts`, `accountContentOverride`).
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

export interface PublishRequest {
  caption: string;
  /**
   * One array for the whole submission — the provider's shape, not a choice made here. A
   * per-platform media selection is delivered through this array, so every target has to agree on
   * it and `plan.ts` refuses when they do not.
   */
  mediaUrls: string[];
  scheduledInstant: string;
  timezone: string;
  targets: { accountId: number; platform: string }[];
  /** Omitted entirely when no platform is tailored. */
  platformConfigurations?: PublishPlatformConfiguration[];
}

export interface PublishSubmission {
  providerPostId: string;
  state: 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'FAILED';
  targets?: {
    accountId: number;
    outcome: 'SUCCESS' | 'FAILURE';
    permalink?: string;
    error?: string;
  }[];
  error?: string;
}

export class PublishProviderError extends Error {
  readonly ambiguous: boolean;
  constructor(message: string, ambiguous = false) {
    super(message);
    this.name = 'PublishProviderError';
    this.ambiguous = ambiguous;
  }
}

export interface PublishProvider {
  readonly available: boolean;
  listTargets(): Promise<PublishTarget[]>;
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
