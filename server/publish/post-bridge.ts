/* v8 ignore file -- the live adapter is exercised only by the account owner's manual QA; automated publishing tests must use MockPublishProvider. */
import {
  PublishMediaUploadError,
  PublishProviderError,
  PUBLISH_RATE_LIMIT_FALLBACK_SECONDS,
  type ProviderPostRecord,
  type PublishProvider,
  type PublishMediaSource,
  type PublishMediaUpload,
  type PublishRequest,
  type PublishSubmission,
  type PublishTarget,
} from './provider.ts';
import {
  parsePostBridgeUploadReservation,
  postBridgeMediaEvidence,
  postBridgePlatformConfigurations,
  postBridgePostBody,
  postBridgeUploadReservationBody,
  validatePostBridgeUploadUrl,
} from './post-bridge-wire.ts';
import { putSignedMedia } from './post-bridge-upload.ts';
import type { ProviderPostState } from '../../shared/publish.ts';
import { ANALYTICS_PLATFORMS, type AnalyticsPlatform } from '../../shared/publish-analytics.ts';
import type {
  AnalyticsProvider,
  ProviderAnalyticsDay,
  ProviderAnalyticsRecord,
} from './analytics-provider.ts';

/**
 * One bearer token, one base URL, and the `429` rule — shared by the two providers this file
 * implements.
 *
 * Extracted rather than duplicated because §9 makes *any* 429 from *any* endpoint authoritative, and
 * a second copy of that translation is a second place for the analytics path to quietly stop
 * honouring `Retry-After`. Nothing here knows what a post or a figure is; it knows how to ask.
 */
class PostBridgeApi {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
  async request(path: string, init?: RequestInit): Promise<unknown> {
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
}

export class PostBridgeProvider implements PublishProvider {
  readonly available = true;
  private readonly api: PostBridgeApi;
  constructor(apiKey: string, baseUrl = 'https://api.post-bridge.com/v1') {
    this.api = new PostBridgeApi(apiKey, baseUrl);
  }
  private request(path: string, init?: RequestInit): Promise<unknown> {
    return this.api.request(path, init);
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
  async uploadMedia(source: PublishMediaSource, signal?: AbortSignal): Promise<PublishMediaUpload> {
    const reservation = parsePostBridgeUploadReservation(
      await this.request('/media/create-upload-url', {
        method: 'POST',
        body: JSON.stringify(postBridgeUploadReservationBody(source)),
        ...(signal ? { signal } : {}),
      }),
    );
    const uploadUrl = validatePostBridgeUploadUrl(reservation.uploadUrl);
    try {
      await putSignedMedia(uploadUrl, source, signal);
    } catch (error) {
      if (error instanceof PublishProviderError)
        throw new PublishMediaUploadError(error.message, reservation.mediaId, error.ambiguous, {
          cause: error,
        });
      throw new PublishMediaUploadError(
        error instanceof Error ? error.message : 'The media stream failed.',
        reservation.mediaId,
        false,
        { cause: error },
      );
    }
    return { mediaId: reservation.mediaId };
  }
  async submit(request: PublishRequest): Promise<PublishSubmission> {
    const platformConfigurations = postBridgePlatformConfigurations(request);
    const body = (await this.request('/posts', {
      method: 'POST',
      body: JSON.stringify(postBridgePostBody(request, platformConfigurations)),
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
        id?: string;
        social_account_id: number;
        success: boolean;
        error?: unknown;
        platform_data?: { url?: string };
      }[];
    };
    const targets = (body.data ?? []).map((result) => ({
      accountId: result.social_account_id,
      outcome: result.success ? ('SUCCESS' as const) : ('FAILURE' as const),
      // The provider's own identity for this one delivery, and the only handle the analytics
      // endpoints accept. This is the only response that carries it, which is why reconciliation is
      // where it is captured.
      ...(result.id ? { resultId: String(result.id) } : {}),
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
    const media = postBridgeMediaEvidence(post.media);
    return {
      providerPostId: String(post.id),
      state: PostBridgeProvider.recordState(post.status, post.is_draft === true),
      caption: post.caption ?? '',
      scheduledInstant: post.scheduled_at ?? null,
      mediaUrls: media.mediaUrls,
      ...(media.mediaIds ? { mediaIds: media.mediaIds } : {}),
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
    const platformConfigurations = postBridgePlatformConfigurations(request);
    const body = (await this.request(`/posts/${encodeURIComponent(providerPostId)}`, {
      method: 'PATCH',
      body: JSON.stringify(postBridgePostBody(request, platformConfigurations)),
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

/**
 * The analytics half of Post Bridge: three endpoints, and the vendor's field names translated once.
 *
 * A separate class from `PostBridgeProvider` because it satisfies a separate interface, and the
 * separation is the point (`analytics-provider.ts`): the figures path is handed something that
 * cannot submit, update, or cancel. They share one `PostBridgeApi`, so they share one bearer token
 * and one reading of a `429`, and nothing else.
 */
export class PostBridgeAnalyticsProvider implements AnalyticsProvider {
  readonly available = true;
  private readonly api: PostBridgeApi;
  constructor(apiKey: string, baseUrl = 'https://api.post-bridge.com/v1') {
    this.api = new PostBridgeApi(apiKey, baseUrl);
  }

  /**
   * `POST /v1/analytics/sync`, with no `platform` filter.
   *
   * The vendor documents the parameter as *"Sync a specific platform only. Omit to sync all"*, so
   * omitting it is how this app asks for every platform the provider exposes — one request rather
   * than one per platform against the one endpoint whose `429` is documented. The returned list is
   * what that call covered, which is every platform in the contract.
   */
  async sync(): Promise<{ platforms: readonly AnalyticsPlatform[] }> {
    await this.api.request('/analytics/sync', { method: 'POST' });
    return { platforms: ANALYTICS_PLATFORMS };
  }

  /**
   * `GET /v1/analytics`, filtered by result id.
   *
   * `post_result_id` is a repeatable query parameter with OR semantics, so one request covers every
   * delivery on a post. `limit` is sent explicitly because the endpoint defaults to ten, and a post
   * that reached more accounts than that would silently come back short.
   */
  async list(postResultIds: readonly string[]): Promise<ProviderAnalyticsRecord[]> {
    if (!postResultIds.length) return [];
    const query = postResultIds
      .map((id) => `post_result_id=${encodeURIComponent(id)}`)
      .concat(`limit=${Math.max(postResultIds.length, 10)}`)
      .join('&');
    const body = (await this.api.request(`/analytics?${query}`)) as {
      data?: {
        id: string;
        post_result_id: string;
        platform: string;
        view_count?: number;
        like_count?: number;
        comment_count?: number;
        share_count?: number;
        last_synced_at?: string;
        share_url?: unknown;
      }[];
    };
    return (body.data ?? []).map((row) => ({
      analyticsId: String(row.id),
      postResultId: String(row.post_result_id),
      platform: row.platform,
      // The vendor types every count as a number and every optional string as an untyped object, so
      // the counts are coerced and the strings are checked. A missing count is zero *from the
      // provider*, which is a different thing from this app inventing one: the record exists, so it
      // has been measured.
      views: Number(row.view_count ?? 0),
      likes: Number(row.like_count ?? 0),
      comments: Number(row.comment_count ?? 0),
      shares: Number(row.share_count ?? 0),
      ...(row.last_synced_at ? { lastSyncedAt: row.last_synced_at } : {}),
      ...(typeof row.share_url === 'string' && row.share_url ? { shareUrl: row.share_url } : {}),
    }));
  }

  /**
   * `GET /v1/analytics/{id}/daily`, keeping `snapshots` and discarding `deltas`.
   *
   * The deltas are a subtraction between consecutive snapshots, and the app does that subtraction
   * itself on read. Storing both would be storing an answer beside its own derivation, and they
   * would disagree the first time a snapshot arrived out of order.
   */
  async days(analyticsId: string): Promise<ProviderAnalyticsDay[]> {
    const body = (await this.api.request(
      `/analytics/${encodeURIComponent(analyticsId)}/daily`,
    )) as {
      snapshots?: {
        date: string;
        view_count?: number;
        like_count?: number;
        comment_count?: number;
        share_count?: number;
      }[];
    };
    return (body.snapshots ?? [])
      .filter((snapshot) => typeof snapshot.date === 'string' && snapshot.date.length === 10)
      .map((snapshot) => ({
        date: snapshot.date,
        views: Number(snapshot.view_count ?? 0),
        likes: Number(snapshot.like_count ?? 0),
        comments: Number(snapshot.comment_count ?? 0),
        shares: Number(snapshot.share_count ?? 0),
      }));
  }
}
