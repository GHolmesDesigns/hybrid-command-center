import { BUFFER_PROVIDER } from './buffer.ts';
import {
  PUBLISH_PLATFORM_LABEL,
  publishCapabilityFor,
  type PublishKindSupport,
  type PublishMediaRule,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
} from './publish-capabilities.ts';

export const BUFFER_SCHEDULING_TYPES = ['notification', 'automatic'] as const;
export type BufferSchedulingType = (typeof BUFFER_SCHEDULING_TYPES)[number];
export const DEFAULT_BUFFER_SCHEDULING_TYPE: BufferSchedulingType = 'notification';

const NO_FIELD = { supported: false, required: false, maxLength: null };

const NO_KIND: PublishKindSupport = {
  automatic: false,
  manualFinish: false,
  media: { min: 0, max: 0, video: 'FORBIDDEN', pdf: 'FORBIDDEN' },
  captionReachesReader: false,
};

const manualKind = (media: PublishMediaRule): PublishKindSupport => ({
  automatic: false,
  manualFinish: true,
  media,
  captionReachesReader: true,
});

const automaticKind = (media: PublishMediaRule): PublishKindSupport => ({
  automatic: true,
  manualFinish: false,
  media,
  captionReachesReader: true,
});

const notificationMedia: PublishMediaRule = {
  min: 0,
  max: null,
  video: 'FORBIDDEN',
  pdf: 'FORBIDDEN',
};

const BUFFER_NOTIFICATION_TIKTOK_KINDS: Record<PublishPostKind, PublishKindSupport> = {
  POST: manualKind(notificationMedia),
  CAROUSEL: manualKind({ min: 0, max: null, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
  REEL: manualKind({ min: 0, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' }),
  STORY: NO_KIND,
};

const BUFFER_NOTIFICATION_YOUTUBE_KINDS: Record<PublishPostKind, PublishKindSupport> = {
  POST: manualKind(notificationMedia),
  CAROUSEL: NO_KIND,
  REEL: manualKind({ min: 0, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' }),
  STORY: NO_KIND,
};

const BUFFER_AUTOMATIC_TIKTOK_KINDS: Record<PublishPostKind, PublishKindSupport> = {
  POST: automaticKind({ min: 1, max: null, video: 'ALONE_ONLY', pdf: 'FORBIDDEN' }),
  CAROUSEL: automaticKind({ min: 2, max: null, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
  REEL: automaticKind({ min: 1, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' }),
  STORY: NO_KIND,
};

const BUFFER_AUTOMATIC_YOUTUBE_KINDS: Record<PublishPostKind, PublishKindSupport> = {
  POST: NO_KIND,
  CAROUSEL: NO_KIND,
  REEL: NO_KIND,
  STORY: NO_KIND,
};

const bufferKindsFor = (
  platform: PublishPlatform,
  schedulingType: BufferSchedulingType,
): Record<PublishPostKind, PublishKindSupport> => {
  if (schedulingType === 'notification') {
    return platform === 'tiktok'
      ? BUFFER_NOTIFICATION_TIKTOK_KINDS
      : BUFFER_NOTIFICATION_YOUTUBE_KINDS;
  }
  return platform === 'tiktok' ? BUFFER_AUTOMATIC_TIKTOK_KINDS : BUFFER_AUTOMATIC_YOUTUBE_KINDS;
};

const bufferSharedFields = (
  platform: PublishPlatform,
): Omit<PublishPlatformCapability, 'platform' | 'label' | 'kinds'> => {
  const postBridge = publishCapabilityFor(platform);
  if (!postBridge) throw new Error(`Buffer capability asked for unmapped platform ${platform}`);
  return {
    captionMax: postBridge.captionMax,
    captionOverLimitRefuses: postBridge.captionOverLimitRefuses,
    stripsLinks: postBridge.stripsLinks,
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: postBridge.title,
    description: postBridge.description,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  };
};

export const bufferCapabilityFor = (
  platform: PublishPlatform,
  schedulingType: BufferSchedulingType,
): PublishPlatformCapability | undefined => {
  if (platform !== 'tiktok' && platform !== 'youtube') return undefined;
  return {
    platform,
    label: PUBLISH_PLATFORM_LABEL[platform],
    kinds: bufferKindsFor(platform, schedulingType),
    ...bufferSharedFields(platform),
  };
};

export const publishCapabilityForProvider = (
  provider: string | undefined,
  platform: PublishPlatform,
  schedulingType?: BufferSchedulingType,
): PublishPlatformCapability | undefined => {
  if (provider === BUFFER_PROVIDER) {
    return bufferCapabilityFor(platform, schedulingType ?? DEFAULT_BUFFER_SCHEDULING_TYPE);
  }
  return publishCapabilityFor(platform);
};

export const isBufferProvider = (provider: string | undefined): boolean =>
  provider === BUFFER_PROVIDER;
