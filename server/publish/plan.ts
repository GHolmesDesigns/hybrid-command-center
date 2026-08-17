import crypto from 'node:crypto';
import {
  signalMediaKind,
  signalTextHasLink,
  type SignalChannel,
  type SignalPost,
} from '../../shared/signal.ts';
import type { PublishPreview } from '../../shared/publish.ts';
import type { PublishRequest, PublishTarget } from './provider.ts';

const PLATFORM: Partial<Record<SignalChannel, string>> = {
  x: 'twitter',
  fb: 'facebook',
  li: 'linkedin',
  bsky: 'bluesky',
  ig: 'instagram',
  tt: 'tiktok',
  yt: 'youtube',
};

export const PLATFORM_CAPABILITIES = {
  twitter: { caption: 280, minMedia: 0, maxMedia: 4, videoAloneOnly: true, stripsLinks: true },
  facebook: { caption: 63206, minMedia: 0 },
  linkedin: { caption: 3000, minMedia: 0, maxMedia: 20, videoAloneOnly: true },
  bluesky: { caption: 300, minMedia: 0, maxMedia: 4, videoAloneOnly: true },
  instagram: { caption: 2200, minMedia: 1, maxMedia: 10 },
  tiktok: { caption: 2200, minMedia: 1 },
  youtube: { caption: 5000, minMedia: 1, maxMedia: 1, videoOnly: true },
  pinterest: { caption: 800, minMedia: 1, maxMedia: 1 },
  threads: { caption: 500, minMedia: 0, maxMedia: 4 },
  google_business: { caption: 1500, minMedia: 0, maxMedia: 1, noVideo: true },
} as const;

const partsInZone = (instant: Date, zone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
};

/** Converts a configured-zone wall time, refusing gaps and choosing the first repeated instant. */
export function publishInstantFor(date: string, time: string, zone: string): string {
  // Constructing the formatter validates the IANA zone before the scan.
  new Intl.DateTimeFormat('en', { timeZone: zone }).format();
  const wanted = `${date} ${time}`;
  const center = Date.parse(`${date}T${time}:00Z`);
  const matches: Date[] = [];
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 1) {
    const candidate = new Date(center + offset * 60_000);
    if (partsInZone(candidate, zone) === wanted) matches.push(candidate);
  }
  if (matches.length === 0)
    throw new Error(
      `${wanted} does not exist in ${zone} because of the daylight-saving time change. Choose another time.`,
    );
  matches.sort((a, b) => a.getTime() - b.getTime());
  return (matches[0] as Date).toISOString();
}

const planHash = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildPublishPlan(
  post: SignalPost,
  connected: PublishTarget[],
  zone: string,
  now = new Date(),
): PublishPreview & { request?: PublishRequest } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const targets: PublishPreview['targets'] = [];
  const caption = post.text.trim();
  if (!caption) refusals.push('Post Bridge requires a caption.');
  if (!post.date) refusals.push('An unscheduled post has no publishing instant.');
  let scheduledInstant: string | undefined;
  if (post.date) {
    try {
      scheduledInstant = publishInstantFor(post.date, post.time, zone);
      if (new Date(scheduledInstant) <= now)
        refusals.push('The publishing instant is in the past. Choose a future date and time.');
    } catch (error) {
      refusals.push((error as Error).message);
    }
  }
  if (post.status === 'PUBLISHED')
    warnings.push('You marked this published yourself; sending it will post it again.');
  const mediaKinds = post.mediaUrls.map(signalMediaKind);
  for (const channel of post.channels) {
    const platform = PLATFORM[channel];
    if (!platform) {
      warnings.push(`${channel === 'blog' ? 'Blog' : channel} is not published by Post Bridge.`);
      continue;
    }
    const capability = PLATFORM_CAPABILITIES[platform as keyof typeof PLATFORM_CAPABILITIES];
    if (caption.length > capability.caption) {
      const message = `${platform} limits captions to ${capability.caption} characters.`;
      if (platform === 'twitter' || platform === 'bluesky') refusals.push(message);
      else warnings.push(message);
    }
    if (post.mediaUrls.length < capability.minMedia) refusals.push(`${platform} requires media.`);
    if ('maxMedia' in capability && post.mediaUrls.length > capability.maxMedia)
      refusals.push(`${platform} accepts at most ${capability.maxMedia} media item(s).`);
    if (
      'videoOnly' in capability &&
      capability.videoOnly &&
      (mediaKinds.length !== 1 || mediaKinds[0] !== 'video')
    )
      refusals.push(`${platform} requires exactly one video.`);
    if (
      'videoAloneOnly' in capability &&
      capability.videoAloneOnly &&
      mediaKinds.includes('video') &&
      mediaKinds.length > 1
    )
      refusals.push(`${platform} accepts a video only when it is the only media item.`);
    if ('noVideo' in capability && capability.noVideo && mediaKinds.includes('video'))
      refusals.push(`${platform} does not accept video.`);
    if (platform === 'instagram' && mediaKinds.includes('pdf'))
      warnings.push('Instagram drops PDFs.');
    if ('stripsLinks' in capability && capability.stripsLinks && signalTextHasLink(caption))
      warnings.push(
        'X removes links from the post body; move the link to a reply before publishing.',
      );
    if (platform === 'youtube')
      warnings.push(
        'YouTube will use the caption as its title because Signal has no separate title.',
      );
    const candidates = connected.filter((target) => target.platform === platform);
    const resolved =
      platform === 'facebook'
        ? candidates.filter(
            (target) =>
              target.name === 'G.Holmes Designs' ||
              target.handle.toLowerCase().replace(/[^a-z0-9]/g, '') === 'gholmesdesigns',
          )
        : candidates;
    if (resolved.length !== 1) {
      refusals.push(
        `${platform} needs exactly one connected target${platform === 'facebook' ? ' for G.Holmes Designs' : ''}.`,
      );
      continue;
    }
    const target = resolved[0] as PublishTarget;
    targets.push({ channel, platform, accountId: target.id, handle: target.handle || target.name });
  }
  if (targets.length === 0) refusals.push('No publishable channel has a resolved provider target.');
  const stable = {
    postId: post.id,
    updatedAt: post.updatedAt,
    caption,
    mediaUrls: post.mediaUrls,
    scheduledInstant,
    timezone: zone,
    targets,
  };
  const preview: PublishPreview & { request?: PublishRequest } = {
    available: true,
    postId: post.id,
    planHash: planHash(stable),
    caption,
    scheduledInstant,
    timezone: zone,
    targets,
    warnings,
    refusals,
  };
  if (scheduledInstant && refusals.length === 0)
    preview.request = {
      caption,
      mediaUrls: post.mediaUrls,
      scheduledInstant,
      timezone: zone,
      targets: targets.map((target) => ({
        accountId: target.accountId,
        platform: target.platform,
      })),
    };
  return preview;
}
