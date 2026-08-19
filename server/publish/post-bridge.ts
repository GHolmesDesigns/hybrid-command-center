/* v8 ignore file -- the live adapter is exercised only by the account owner's manual QA; automated publishing tests must use MockPublishProvider. */
import {
  PublishProviderError,
  type PublishProvider,
  type PublishRequest,
  type PublishSubmission,
  type PublishTarget,
} from './provider.ts';

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
    if (!response.ok)
      throw new PublishProviderError(
        `Post Bridge refused the request (${response.status}).`,
        false,
      );
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
  async cancel(providerPostId: string): Promise<void> {
    await this.request(`/posts/${encodeURIComponent(providerPostId)}`, { method: 'DELETE' });
  }
}
