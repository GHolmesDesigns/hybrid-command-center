import { PublishProviderError, type PublishRequest } from './provider.ts';
import { isIP } from 'node:net';

/** Pure, covered wire logic. The live transport stays in `post-bridge.ts`. */
export function postBridgeUploadReservationBody(source: {
  name: string;
  mimeType: string;
  sizeBytes: number;
}) {
  return { name: source.name, mime_type: source.mimeType, size_bytes: source.sizeBytes };
}

export function parsePostBridgeUploadReservation(value: unknown): {
  mediaId: string;
  uploadUrl: string;
} {
  const row = value as { media_id?: unknown; upload_url?: unknown };
  if (typeof row?.media_id !== 'string' || typeof row?.upload_url !== 'string')
    throw new PublishProviderError(
      'Post Bridge answered without a media id and signed upload URL.',
      false,
    );
  return { mediaId: row.media_id, uploadUrl: row.upload_url };
}

/** Inspects without reserialising: signed URL signatures cover the exact original string. */
export function validatePostBridgeUploadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublishProviderError('Post Bridge returned an invalid media upload URL.');
  }
  if (url.protocol !== 'https:')
    throw new PublishProviderError('Post Bridge returned a media upload URL that is not HTTPS.');
  if (url.username || url.password)
    throw new PublishProviderError('Post Bridge returned a media upload URL with credentials.');
  if (url.hash)
    throw new PublishProviderError('Post Bridge returned a media upload URL with a fragment.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isIP(hostname) !== 0
  )
    throw new PublishProviderError(
      'Post Bridge returned a media upload URL whose hostname is not an allowed public DNS name.',
    );
  return url;
}

/**
 * The per-platform overrides, in the vendor's own vocabulary and nowhere else.
 *
 * `document_title` on LinkedIn and `title` everywhere else are the same field to this app and two
 * field names to Post Bridge, which is exactly the kind of difference that belongs in this module
 * and no other. It lives here rather than inside the live adapter so it can be asserted without
 * contacting the vendor: the LinkedIn PDF document post is the one media role C73 actually verified
 * (`docs/post-bridge-api-surface.md` §14, question 3), and what verifies it end to end is this
 * mapping plus the ordinary C75 upload path — not a role row.
 *
 * A placement is sent only for a story, because that is the only placement the source records; a
 * reel reaches the platform as its single video.
 *
 * **No `cover_image` and no `thumbnail`.** Both are named by OpenAPI and neither is verified, and
 * inventing a wire field from a document is what C76 put out of scope. A stored role warns in the
 * preview instead; when a §14 result verifies one, this is the function it is added to.
 */
export function postBridgePlatformConfigurations(request: PublishRequest) {
  const entries = (request.platformConfigurations ?? []).map((configuration) => {
    const fields: Record<string, unknown> = {};
    if (configuration.caption !== undefined) fields.caption = configuration.caption;
    if (configuration.firstComment !== undefined) fields.first_comment = configuration.firstComment;
    if (configuration.title !== undefined)
      fields[configuration.platform === 'linkedin' ? 'document_title' : 'title'] =
        configuration.title;
    if (configuration.story) fields.placement = 'story';
    return [configuration.platform, fields] as const;
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * `account_configurations`, in the encoding C73 verified.
 *
 * **A list of objects each carrying `account_id`**, not a map keyed by id — the probe accepted that
 * shape on the first attempt and read it back unchanged after create and after `PATCH`
 * (`docs/post-bridge-api-surface.md` §14, question 1). The alternative encoding was never
 * accepted by anything, so it is not offered here.
 *
 * Only `caption` travels beside the id. A title, a first comment, a placement, and a media role are
 * platform-level on this provider and are emitted by `postBridgePlatformConfigurations` above; the
 * preview says so per account rather than this function silently dropping them.
 */
export function postBridgeAccountConfigurations(request: PublishRequest) {
  const entries = (request.accountConfigurations ?? []).map((configuration) => ({
    account_id: configuration.accountId,
    ...(configuration.caption !== undefined ? { caption: configuration.caption } : {}),
  }));
  return entries.length ? entries : undefined;
}

export function postBridgePostBody(
  request: PublishRequest,
  platformConfigurations?: unknown,
  accountConfigurations?: unknown,
) {
  return {
    caption: request.caption,
    ...('mediaIds' in request ? { media: request.mediaIds } : { media_urls: request.mediaUrls }),
    scheduled_at: request.scheduledInstant,
    social_accounts: request.targets.map((target) => target.accountId),
    ...(platformConfigurations ? { platform_configurations: platformConfigurations } : {}),
    ...(accountConfigurations ? { account_configurations: accountConfigurations } : {}),
  };
}

export function postBridgeMediaEvidence(media: unknown): {
  mediaUrls: string[];
  mediaIds?: string[];
} {
  if (!Array.isArray(media)) return { mediaUrls: [] };
  const mediaUrls: string[] = [];
  const mediaIds: string[] = [];
  for (const item of media) {
    if (typeof item === 'string') {
      // Uploaded media read back as ids in the verified live contract. Public URL media is exposed
      // as an object carrying `url`, so a bare string is kept as identity evidence.
      if (/^https:\/\//i.test(item)) mediaUrls.push(item);
      else mediaIds.push(item);
      continue;
    }
    if (typeof (item as { url?: unknown })?.url === 'string')
      mediaUrls.push((item as { url: string }).url);
    if (typeof (item as { id?: unknown })?.id === 'string')
      mediaIds.push((item as { id: string }).id);
  }
  return { mediaUrls, ...(mediaIds.length ? { mediaIds } : {}) };
}
