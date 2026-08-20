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

export function postBridgePostBody(request: PublishRequest, platformConfigurations?: unknown) {
  return {
    caption: request.caption,
    ...('mediaIds' in request ? { media: request.mediaIds } : { media_urls: request.mediaUrls }),
    scheduled_at: request.scheduledInstant,
    social_accounts: request.targets.map((target) => target.accountId),
    ...(platformConfigurations ? { platform_configurations: platformConfigurations } : {}),
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
