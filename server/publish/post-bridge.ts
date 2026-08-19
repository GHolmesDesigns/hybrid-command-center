/* v8 ignore file -- the live adapter is exercised only by the account owner's manual QA; automated publishing tests must use MockPublishProvider. */
import {
  PublishProviderError,
  PUBLISH_RATE_LIMIT_FALLBACK_SECONDS,
  type ProviderPostRecord,
  type PublishProvider,
  type PublishRequest,
  type PublishSubmission,
  type PublishTarget,
} from './provider.ts';
import type { ProviderPostState } from '../../shared/publish.ts';

export class PostBridgeProvider implements PublishProvider {
  readonly available = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  constructor(apiKey: string, baseUrl = 'https://api.post-bridge.com/v1') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  private async request(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...init?.headers,
        },
      });
    } catch (error) {
      throw new PublishProviderError((error as Error).message, true);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      // A 429 is a fact about the connection rather than about this request, so it is marked as one
      // and `Retry-After` is honoured where the response carries it (§9).
      const retryAfter = Number(response.headers.get('Retry-After'));
      throw new PublishProviderError(
        `Post Bridge refused the request (${response.status}).`,
        false,
        response.status === 429
          ? {
              rateLimited: true,
              retryAfterSeconds:
                Number.isFinite(retryAfter) && retryAfter > 0
                  ? retryAfter
                  : PUBLISH_RATE_LIMIT_FALLBACK_SECONDS,
            }
          : {},
      );
    }
    return body;
  }
  async listTargets(): Promise<PublishTarget[]> {
    const body = (await this.request('/social-accounts?limit=100')) as {
      data?: { id: number; platform: string; username?: string; name?: string }[];
    };
    return (body.data ?? []).map((row) => ({
      id: row.id,
      platform: row.platform,
      handle: row.username ?? '',
      name: row.username ?? '',
    }));
  }
  /**
   * The per-platform overrides, in the vendor's own vocabulary and nowhere else.
   *
   * `document_title` on LinkedIn and `title` everywhere else are the same field to this app and two
   * field names to Post Bridge, which is exactly the kind of difference that belongs in this module
   * and no other. A placement is sent only for a story, because that is the only placement the
   * source records; a reel reaches the platform as its single video.
   */
  private static platformConfigurations(request: PublishRequest) {
    const entries = (request.platformConfigurations ?? []).map((configuration) => {
      const fields: Record<string, unknown> = {};
      if (configuration.caption !== undefined) fields.caption = configuration.caption;
      if (configuration.firstComment !== undefined)
        fields.first_comment = configuration.firstComment;
      if (configuration.title !== undefined)
        fields[configuration.platform === 'linkedin' ? 'document_title' : 'title'] =
          configuration.title;
      if (configuration.story) fields.placement = 'story';
      return [configuration.platform, fields] as const;
    });
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  async submit(request: PublishRequest): Promise<PublishSubmission> {
    const platformConfigurations = PostBridgeProvider.platformConfigurations(request);
    const body = (await this.request('/posts', {
      method: 'POST',
      body: JSON.stringify({
        caption: request.caption,
        media_urls: request.mediaUrls,
        scheduled_at: request.scheduledInstant,
        social_accounts: request.targets.map((target) => target.accountId),
        // Only where non-empty, which is the artifact's own rule for this key.
        ...(platformConfigurations ? { platform_configurations: platformConfigurations } : {}),
      }),
    })) as { id: string; status?: string };
    if (!body.id)
      throw new PublishProviderError('Post Bridge answered without a publication id.', true);
    return {
      providerPostId: String(body.id),
      state:
        body.status === 'posted' ? 'CONFIRMED' : body.status === 'failed' ? 'FAILED' : 'SUBMITTED',
    };
  }
  async check(providerPostId: string): Promise<PublishSubmission> {
    const post = (await this.request(`/posts/${encodeURIComponent(providerPostId)}`)) as {
      id: string;
      status?: string;
    };
    const body = (await this.request(
      `/post-results?post_id=${encodeURIComponent(providerPostId)}&limit=100`,
    )) as {
      data?: {
        social_account_id: number;
        success: boolean;
        error?: unknown;
        platform_data?: { url?: string };
      }[];
    };
    const targets = (body.data ?? []).map((result) => ({
      accountId: result.social_account_id,
      outcome: result.success ? ('SUCCESS' as const) : ('FAILURE' as const),
      ...(result.platform_data?.url ? { permalink: result.platform_data.url } : {}),
      ...(!result.success && result.error
        ? { error: typeof result.error === 'string' ? result.error : JSON.stringify(result.error) }
        : {}),
    }));
    const successes = targets.filter((target) => target.outcome === 'SUCCESS').length;
    const state =
      targets.length === 0
        ? post.status === 'failed'
          ? 'FAILED'
          : 'SUBMITTED'
        : successes === targets.length
          ? 'CONFIRMED'
          : successes > 0
            ? 'PARTIAL'
            : 'FAILED';
    return { providerPostId: String(post.id), state, targets };
  }
  /**
   * The vendor's `status` and `is_draft` collapsed into the one union the rules read.
   *
   * `is_draft` wins over `status`, because a draft the vendor also calls `scheduled` is still a
   * draft — nothing goes out until it is updated — and treating it as scheduled would let the app
   * tell someone a post is on its way when it is sitting in Post Bridge waiting for them. Anything
   * unrecognised becomes `PROCESSING`, which is the fail-closed answer: it is the one state the
   * mutation rules refuse, so a status this adapter has never seen cannot be written over.
   */
  private static recordState(status: string | undefined, isDraft: boolean): ProviderPostState {
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

  /**
   * The provider's media array as plain URLs.
   *
   * The vendor documents `media` as an object and returns either bare strings or rows carrying a
   * `url`, depending on whether the post was created from uploaded media or from public addresses.
   * Both are read; anything else is dropped rather than stringified, because a diff line reading
   * `[object Object]` is worse than a diff line that is missing.
   */
  private static mediaUrls(media: unknown): string[] {
    if (!Array.isArray(media)) return [];
    return media
      .map((item) =>
        typeof item === 'string'
          ? item
          : typeof (item as { url?: unknown })?.url === 'string'
            ? (item as { url: string }).url
            : undefined,
      )
      .filter((url): url is string => Boolean(url));
  }

  async describe(providerPostId: string): Promise<ProviderPostRecord> {
    const post = (await this.request(`/posts/${encodeURIComponent(providerPostId)}`)) as {
      id: string;
      caption?: string;
      status?: string;
      scheduled_at?: string | null;
      social_accounts?: number[];
      media?: unknown;
      is_draft?: boolean;
      updated_at?: string;
    };
    return {
      providerPostId: String(post.id),
      state: PostBridgeProvider.recordState(post.status, post.is_draft === true),
      caption: post.caption ?? '',
      scheduledInstant: post.scheduled_at ?? null,
      mediaUrls: PostBridgeProvider.mediaUrls(post.media),
      accountIds: (post.social_accounts ?? []).map(Number),
      ...(post.updated_at ? { updatedAt: post.updated_at } : {}),
    };
  }

  /**
   * `PATCH /v1/posts/{id}`, always in full.
   *
   * **`scheduled_at` is sent on every update, without exception.** The vendor's own note on this
   * endpoint is that a scheduled post whose update omits it "will process immediately" — so the
   * field that looks optional is the one that publishes a post early, and the adapter never leaves
   * the caller's intent to a default. Sending the whole request also makes the call idempotent by
   * end state, which is the only idempotency this API offers: it documents no idempotency key on
   * any endpoint, so repeating a `PATCH` is safe and repeating a `POST` is not.
   */
  async update(providerPostId: string, request: PublishRequest): Promise<PublishSubmission> {
    const platformConfigurations = PostBridgeProvider.platformConfigurations(request);
    const body = (await this.request(`/posts/${encodeURIComponent(providerPostId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        caption: request.caption,
        media_urls: request.mediaUrls,
        scheduled_at: request.scheduledInstant,
        social_accounts: request.targets.map((target) => target.accountId),
        ...(platformConfigurations ? { platform_configurations: platformConfigurations } : {}),
      }),
    })) as { id?: string; status?: string };
    return {
      providerPostId: body.id ? String(body.id) : providerPostId,
      state:
        body.status === 'posted' ? 'CONFIRMED' : body.status === 'failed' ? 'FAILED' : 'SUBMITTED',
    };
  }

  /**
   * `DELETE /v1/posts/{id}`. The vendor refuses a published post with a `400`, which the service
   * also refuses ahead of time from the record it read — two guards for the one rule, because the
   * local one gives a sentence and the remote one is the one that cannot be raced past.
   */
  async cancel(providerPostId: string): Promise<void> {
    await this.request(`/posts/${encodeURIComponent(providerPostId)}`, { method: 'DELETE' });
  }
}
