import { signalMediaKindFor } from './signal.ts';
import type { SignalPostMedia } from './signal-media.ts';
import type { BufferSchedulingType } from './buffer-capabilities.ts';
import type { PublishPlatform, PublishPlatformCapability } from './publish-capabilities.ts';
import type { PublishChannelContent } from './publish.ts';

export type BufferWireAsset =
  { image: { url: string } } | { video: { url: string } } | { document: { url: string } };

export interface BufferWirePreview {
  schedulingType: BufferSchedulingType;
  mode: 'customScheduled';
  assets: BufferWireAsset[];
  metadata?: {
    tiktok?: { title?: string };
    youtube?: { title?: string };
  };
}

export const BUFFER_TARGET_MEDIA_HINT =
  'Buffer cannot take media from Drive or upload files from this app. With notification scheduling, TikTok and YouTube posts carry text only; Buffer reminds you in the TikTok or YouTube app to attach media and finish the post there. Automatic TikTok may carry a direct public HTTPS address you already stored on the post; automatic YouTube is not available yet.';

export const BUFFER_MEDIA_ROUTE_SUMMARY =
  'Buffer fetches media from a direct public HTTPS address at publish time — hours or days after you schedule — so a signed or expiring address may fail when the post actually goes out.';

const bufferAssetKindFor = (media: SignalPostMedia): 'image' | 'video' | 'document' | undefined => {
  const kind = signalMediaKindFor(media);
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  if (kind === 'pdf') return 'document';
  return undefined;
};

const expiringUrlWarning = (url: string): string | undefined => {
  const parsed = new URL(url);
  if (parsed.search || parsed.hash) {
    return `${url} carries a query or fragment. Buffer may not fetch it when the post publishes.`;
  }
  return undefined;
};

export const bufferMediaPlan = (input: {
  capability: PublishPlatformCapability;
  platform: PublishPlatform;
  schedulingType: BufferSchedulingType;
  content: PublishChannelContent;
  media: readonly SignalPostMedia[];
}): { refusals: string[]; warnings: string[]; bufferWire?: BufferWirePreview } => {
  const { capability, platform, schedulingType, content, media } = input;
  const label = capability.label;
  const refusals: string[] = [];
  const warnings: string[] = [];

  const selected = content.mediaUrls.map(
    (url) => media.find((item) => item.url === url) ?? ({ source: 'URL', url } as SignalPostMedia),
  );

  for (const item of selected) {
    if (item.source === 'DRIVE') {
      const name = item.driveName ?? item.url;
      refusals.push(
        `${label} cannot use Drive files (${name}). Buffer has no upload path and cannot fetch a Drive viewer page. Attach media in the ${label} app after Buffer reminds you, or publish through Post Bridge instead.`,
      );
    }
  }
  if (refusals.length) return { refusals, warnings };

  if (schedulingType === 'automatic' && platform === 'youtube') {
    refusals.push(
      `${label} automatic scheduling through Buffer is not available yet. C83 has not verified a YouTube create; this app refuses rather than inferring one.`,
    );
    return { refusals, warnings };
  }

  const wire: BufferWirePreview = {
    schedulingType,
    mode: 'customScheduled',
    assets: [],
  };

  if (content.title !== undefined) {
    wire.metadata =
      platform === 'tiktok'
        ? { tiktok: { title: content.title } }
        : { youtube: { title: content.title } };
  }

  if (schedulingType === 'notification') {
    warnings.push(
      `${label} will carry the text only. Buffer will remind you in the ${label} app to attach media and finish the post.`,
    );
    return { refusals, warnings, bufferWire: wire };
  }

  const assets: BufferWireAsset[] = [];
  for (const item of selected) {
    if (item.source !== 'URL') continue;
    const assetKind = bufferAssetKindFor(item);
    if (!assetKind) {
      refusals.push(
        `${label} cannot classify ${item.url} as an image, video, or document for Buffer. Use a direct public HTTPS address whose kind is known.`,
      );
      continue;
    }
    const expiry = expiringUrlWarning(item.url);
    if (expiry) warnings.push(expiry);
    assets.push({ [assetKind]: { url: item.url } } as BufferWireAsset);
  }

  if (refusals.length) return { refusals, warnings };

  wire.assets = assets;
  warnings.push(BUFFER_MEDIA_ROUTE_SUMMARY);
  return { refusals, warnings, bufferWire: wire };
};
