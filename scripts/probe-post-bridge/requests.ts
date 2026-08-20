/**
 * Every request the probe can make, as a value.
 *
 * Nothing here talks to anything. A builder takes what a question needs and returns the method,
 * the path, and the body, so "what exactly does this probe put on the wire" is answered by a test
 * asserting on an object rather than by reading a live transcript afterwards. The serialization is
 * the thing under examination — a probe that asks the wrong question politely proves nothing — so
 * these are the functions the test file spends most of its length on.
 *
 * Field names are the vendor's, spelled the way `docs/post-bridge-api-surface.md` read them out of
 * the OpenAPI document. Where the document leaves a shape ambiguous, the builder takes the shape as
 * a parameter and the probe records which one the provider accepted; it does not pick one and call
 * a `400` a negative result.
 */
import type { ProbeApiRequest } from './client.ts';

/** The five values `mime_type` is documented to accept, and nothing else. */
export const PROBE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
] as const;
export type ProbeMimeType = (typeof PROBE_MIME_TYPES)[number];

/**
 * A repeatable query parameter, spelled both of the two ways this API could mean.
 *
 * The OpenAPI document writes `?status[]` and `?platform[]`; NestJS commonly also accepts the bare
 * repeated name. Which one actually filters is question 4, and it is only answerable by sending
 * each and comparing what comes back, so the encoding is an argument rather than a decision.
 */
export type RepeatableStyle = 'bracket' | 'repeat';

export function encodeRepeatable(
  name: string,
  values: readonly string[],
  style: RepeatableStyle,
): string[] {
  const key = style === 'bracket' ? `${name}[]` : name;
  return values.map((value) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
}

function query(parts: readonly string[]): string {
  const kept = parts.filter((part) => part.length > 0);
  return kept.length ? `?${kept.join('&')}` : '';
}

/** `GET /v1/social-accounts`. `limit` is explicit because the endpoint defaults to ten. */
export function listSocialAccountsRequest(limit = 100): ProbeApiRequest {
  return { method: 'GET', path: `/social-accounts${query([`limit=${limit}`])}` };
}

export interface ListPostsOptions {
  limit: number;
  offset: number;
  status?: readonly string[];
  platform?: readonly string[];
  style?: RepeatableStyle;
}

/** `GET /v1/posts` — the endpoint the app does not call yet, and all of question 4. */
export function listPostsRequest(options: ListPostsOptions): ProbeApiRequest {
  const style = options.style ?? 'bracket';
  return {
    method: 'GET',
    path: `/posts${query([
      `limit=${options.limit}`,
      `offset=${options.offset}`,
      ...encodeRepeatable('status', options.status ?? [], style),
      ...encodeRepeatable('platform', options.platform ?? [], style),
    ])}`,
  };
}

export function getPostRequest(providerPostId: string): ProbeApiRequest {
  return { method: 'GET', path: `/posts/${encodeURIComponent(providerPostId)}` };
}

export function deletePostRequest(providerPostId: string): ProbeApiRequest {
  return { method: 'DELETE', path: `/posts/${encodeURIComponent(providerPostId)}` };
}

/** One account's override, in the shape `AccountConfigurationDto` describes. */
export interface AccountConfigurationInput {
  accountId: number;
  caption?: string;
  mediaIds?: readonly string[];
}

/**
 * `account_configurations` written both of the two ways the document could mean.
 *
 * `AccountConfigurationDto` makes `account_id` required, which reads as a list of objects. An API
 * that keys the map by account id instead would make that field redundant, so the list is the first
 * guess — but only a guess, and question 1 is worthless if a wrong guess is filed as "the provider
 * refuses account overrides". The probe sends `list`, and retries `keyed` once if the refusal names
 * the field.
 */
export type AccountConfigurationStyle = 'list' | 'keyed';

export function encodeAccountConfigurations(
  configurations: readonly AccountConfigurationInput[],
  style: AccountConfigurationStyle,
): unknown {
  const fields = (configuration: AccountConfigurationInput) => ({
    ...(configuration.caption === undefined ? {} : { caption: configuration.caption }),
    ...(configuration.mediaIds === undefined ? {} : { media: [...configuration.mediaIds] }),
  });
  if (style === 'keyed')
    return Object.fromEntries(
      configurations.map((configuration) => [
        String(configuration.accountId),
        fields(configuration),
      ]),
    );
  return configurations.map((configuration) => ({
    account_id: configuration.accountId,
    ...fields(configuration),
  }));
}

export interface ProbePostInput {
  caption: string;
  /** Always explicit, always in the future. `null` posts instantly and the probe never sends it. */
  scheduledAt: string;
  accountIds: readonly number[];
  mediaIds?: readonly string[];
  mediaUrls?: readonly string[];
  platformConfigurations?: Record<string, Record<string, unknown>>;
  accountConfigurations?: readonly AccountConfigurationInput[];
  accountConfigurationStyle?: AccountConfigurationStyle;
}

/**
 * The body `POST /v1/posts` and `PATCH /v1/posts/{id}` share.
 *
 * `scheduled_at` is required by this builder rather than optional, and there is no way to ask it for
 * `null`. The vendor's own note is that a `PATCH` omitting the field processes the post
 * immediately; a probe whose whole safety story is "nothing is ever published" cannot have a code
 * path that leaves that to a default.
 *
 * `media` and `media_urls` may both be set, but only by a caller that means to: question 2 asks
 * which one wins when both are present, and it can only be asked by sending both.
 */
export function probePostBody(input: ProbePostInput): Record<string, unknown> {
  if (!input.scheduledAt) throw new Error('A probe post always carries an explicit scheduled_at.');
  if (!input.accountIds.length)
    throw new Error('A probe post always names its accounts explicitly.');
  return {
    caption: input.caption,
    scheduled_at: input.scheduledAt,
    social_accounts: [...input.accountIds],
    ...(input.mediaIds === undefined ? {} : { media: [...input.mediaIds] }),
    ...(input.mediaUrls === undefined ? {} : { media_urls: [...input.mediaUrls] }),
    ...(input.platformConfigurations === undefined
      ? {}
      : { platform_configurations: input.platformConfigurations }),
    ...(input.accountConfigurations === undefined
      ? {}
      : {
          account_configurations: encodeAccountConfigurations(
            input.accountConfigurations,
            input.accountConfigurationStyle ?? 'list',
          ),
        }),
  };
}

export function createPostRequest(input: ProbePostInput): ProbeApiRequest {
  return { method: 'POST', path: '/posts', body: probePostBody(input) };
}

export function updatePostRequest(providerPostId: string, input: ProbePostInput): ProbeApiRequest {
  return {
    method: 'PATCH',
    path: `/posts/${encodeURIComponent(providerPostId)}`,
    body: probePostBody(input),
  };
}

/** `POST /v1/media/create-upload-url`. All three fields are documented as required. */
export function createUploadUrlRequest(input: {
  name: string;
  mimeType: string;
  sizeBytes: number;
}): ProbeApiRequest {
  return {
    method: 'POST',
    path: '/media/create-upload-url',
    body: { name: input.name, mime_type: input.mimeType, size_bytes: input.sizeBytes },
  };
}

export function getMediaRequest(mediaId: string): ProbeApiRequest {
  return { method: 'GET', path: `/media/${encodeURIComponent(mediaId)}` };
}

export function deleteMediaRequest(mediaId: string): ProbeApiRequest {
  return { method: 'DELETE', path: `/media/${encodeURIComponent(mediaId)}` };
}

export interface AnalyticsQueryOptions {
  limit: number;
  offset: number;
  postResultIds?: readonly string[];
  platform?: string;
  timeframe?: string;
  style?: RepeatableStyle;
}

/**
 * `GET /v1/analytics`, with every filter question 5 asks about.
 *
 * `platform` and `timeframe` are single-valued in the document, so they are plain parameters;
 * `post_result_id` is the repeatable one and takes the same style argument as the post filters,
 * because if the two endpoints disagree about repeatable encoding that is itself a finding.
 */
export function analyticsRequest(options: AnalyticsQueryOptions): ProbeApiRequest {
  return {
    method: 'GET',
    path: `/analytics${query([
      `limit=${options.limit}`,
      `offset=${options.offset}`,
      ...encodeRepeatable('post_result_id', options.postResultIds ?? [], options.style ?? 'repeat'),
      options.platform ? `platform=${encodeURIComponent(options.platform)}` : '',
      options.timeframe ? `timeframe=${encodeURIComponent(options.timeframe)}` : '',
    ])}`,
  };
}
