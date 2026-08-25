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
  'Buffer cannot take media from Drive or upload files from this app — a Drive share link is a viewer page even when the file is public, not something Buffer can fetch. The Drive override on a channel tab converts one to a direct-download address instead, at the risk of a silent publish-time failure. With notification scheduling, TikTok and YouTube posts carry text only; Buffer reminds you in the TikTok or YouTube app to attach media and finish the post there. Automatic TikTok may carry a direct public HTTPS address you already stored on the post; automatic YouTube is not available yet.';

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

/**
 * Drive's own direct-download address for a file id.
 *
 * Drive's share link (`.../file/d/ID/view`) is an HTML viewer page and never something Buffer can
 * fetch, whatever the file's sharing setting says — "anyone with the link" makes the *viewer page*
 * public, not the bytes behind it. This form serves the raw bytes for a public file instead, which
 * is what makes the override in {@link bufferMediaPlan} possible at all. It is not a reliable
 * substitute for a real hosted URL: Drive interstitials larger files with a virus-scan warning page
 * instead of the content, unpredictably, and Buffer fetches this hours or days after the post is
 * scheduled — a link that resolves today can fail silently when it actually publishes. That is why
 * this conversion is never applied on its own; it exists only behind the explicit, per-send
 * `driveOverride` a person chose knowing the risk.
 */
export const driveDirectDownloadUrl = (fileId: string): string =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

const driveRefusal = (label: string, name: string): string =>
  `${label} cannot use Drive files (${name}). Buffer has no upload path and cannot fetch a Drive viewer page. Attach media in the ${label} app after Buffer reminds you, publish through Post Bridge instead, or use the Drive override for this send.`;

const driveOverrideWarning = (label: string, name: string): string =>
  `${label} media for ${name} was sent to Buffer as Drive's direct-download address, not a real hosted URL, because the Drive override was chosen for this send. Buffer fetches it at publish time — hours or days from now — and Drive may serve a virus-scan interstitial instead of the file for a larger one, unpredictably. The post can fail silently when it publishes; nothing here can detect that in advance.`;

export const bufferMediaPlan = (input: {
  capability: PublishPlatformCapability;
  platform: PublishPlatform;
  schedulingType: BufferSchedulingType;
  content: PublishChannelContent;
  media: readonly SignalPostMedia[];
  /**
   * Explicit, per-send permission to convert a Drive file's share link to its direct-download
   * address and send that to Buffer instead of refusing. Defaults to false, which preserves the
   * unconditional refusal below — nothing here applies the conversion on its own.
   */
  driveOverride?: boolean;
}): {
  refusals: string[];
  warnings: string[];
  bufferWire?: BufferWirePreview;
  /** Whether this target has Drive-sourced media the override above would actually affect. */
  driveOverridable: boolean;
} => {
  const { capability, platform, schedulingType, content, media, driveOverride = false } = input;
  const label = capability.label;
  const refusals: string[] = [];
  const warnings: string[] = [];

  const selected = content.mediaUrls.map(
    (url) => media.find((item) => item.url === url) ?? ({ source: 'URL', url } as SignalPostMedia),
  );
  const driveOverridable =
    schedulingType !== 'notification' && selected.some((item) => item.source === 'DRIVE');

  if (!driveOverride) {
    for (const item of selected) {
      if (item.source === 'DRIVE') refusals.push(driveRefusal(label, item.driveName ?? item.url));
    }
    if (refusals.length) return { refusals, warnings, driveOverridable };
  }

  if (schedulingType === 'automatic' && platform === 'youtube') {
    refusals.push(
      `${label} automatic scheduling through Buffer is not available yet. C83 has not verified a YouTube create; this app refuses rather than inferring one.`,
    );
    return { refusals, warnings, driveOverridable };
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
    return { refusals, warnings, bufferWire: wire, driveOverridable };
  }

  const assets: BufferWireAsset[] = [];
  for (const item of selected) {
    if (item.source === 'DRIVE') {
      // Only reachable with driveOverride true: without it, every Drive item already refused above
      // and this loop never runs.
      if (!item.driveFileId) {
        refusals.push(`${label} cannot use ${item.driveName ?? item.url} without a Drive file id.`);
        continue;
      }
      const assetKind = bufferAssetKindFor(item);
      if (!assetKind) {
        refusals.push(
          `${label} cannot classify ${item.driveName ?? item.url} as an image, video, or document for Buffer.`,
        );
        continue;
      }
      warnings.push(driveOverrideWarning(label, item.driveName ?? item.url));
      assets.push({
        [assetKind]: { url: driveDirectDownloadUrl(item.driveFileId) },
      } as BufferWireAsset);
      continue;
    }
    // `item.source` is narrowed to 'URL' here: the only other value the type admits is 'DRIVE',
    // and every path through that branch above continues.
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

  if (refusals.length) return { refusals, warnings, driveOverridable };

  wire.assets = assets;
  warnings.push(BUFFER_MEDIA_ROUTE_SUMMARY);
  return { refusals, warnings, bufferWire: wire, driveOverridable };
};
