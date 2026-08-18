import crypto from 'node:crypto';
import {
  signalMediaKind,
  signalTextHasLink,
  SIGNAL_CHANNEL_LABEL,
  type SignalChannel,
  type SignalMediaKind,
  type SignalPost,
} from '../../shared/signal.ts';
import {
  publishCapabilityFor,
  publishKindSupported,
  publishPlatformFor,
  publishPostKindFor,
  PUBLISH_POST_KIND_LABEL,
  type PublishPlatformCapability,
  type PublishPostKind,
} from '../../shared/publish-capabilities.ts';
import type { PublishChannelReport, PublishPreview } from '../../shared/publish.ts';
import { publishPreviewRefusals } from '../../shared/publish.ts';
import type { PublishRequest, PublishTarget } from './provider.ts';

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

/** What preflight is handed about one submission. No database, no network, no `SignalPost`. */
export interface PlatformPreflight {
  capability: PublishPlatformCapability;
  kind: PublishPostKind;
  caption: string;
  mediaKinds: SignalMediaKind[];
}

/**
 * One platform's preflight, answered entirely from the shared capability contract.
 *
 * It takes a capability rather than a platform key so the rules can be exercised against any
 * contract entry — including combinations no connected platform has today, such as a shape that
 * only finishes by hand. Every refusal names what has to change, because a preview that says a
 * post is wrong without saying how is a preview the user has to guess at.
 */
export function preflightPlatform(input: PlatformPreflight): {
  refusals: string[];
  warnings: string[];
} {
  const { capability, kind, caption, mediaKinds } = input;
  const refusals: string[] = [];
  const warnings: string[] = [];
  const label = capability.label;
  const kindLabel = PUBLISH_POST_KIND_LABEL[kind];
  const support = capability.kinds[kind];

  if (!publishKindSupported(support)) {
    refusals.push(
      `${label} does not accept a ${kindLabel} from this provider. Change the post's format or remove ${label}.`,
    );
    return { refusals, warnings };
  }
  if (!support.automatic)
    warnings.push(
      `${label} finishes a ${kindLabel} by hand: the provider delivers it to the ${label} app and you complete it there.`,
    );
  if (!support.captionReachesReader && caption)
    warnings.push(
      `${label} shows no caption on a ${kindLabel}, so this text will not reach the reader.`,
    );

  if (caption.length > capability.captionMax) {
    const over = caption.length - capability.captionMax;
    const message = `${label} limits captions to ${capability.captionMax} characters and this one is ${caption.length}. Remove ${over}.`;
    if (capability.captionOverLimitRefuses) refusals.push(message);
    else warnings.push(message);
  }

  const { min, max, video, pdf } = support.media;
  const count = mediaKinds.length;
  if (count < min)
    refusals.push(
      min === 1
        ? `${label} requires media on a ${kindLabel}. Add an image or a video.`
        : `${label} requires at least ${min} media items on a ${kindLabel} and this post has ${count}.`,
    );
  if (max !== null && count > max)
    refusals.push(
      `${label} accepts at most ${max} media item${max === 1 ? '' : 's'} on a ${kindLabel} and this post has ${count}. Remove ${count - max}.`,
    );

  const videos = mediaKinds.filter((media) => media === 'video').length;
  if (video === 'REQUIRED_ALONE' && (count !== 1 || videos !== 1))
    refusals.push(`${label} requires exactly one video and no other media on a ${kindLabel}.`);
  if (video === 'ALONE_ONLY' && videos > 0 && count > 1)
    refusals.push(
      `${label} accepts a video only when it is the only media item. Remove the other ${count - 1} item${count === 2 ? '' : 's'}.`,
    );
  if (video === 'FORBIDDEN' && videos > 0)
    refusals.push(`${label} does not accept video on a ${kindLabel}. Remove it.`);

  const pdfs = mediaKinds.filter((media) => media === 'pdf').length;
  if (pdfs > 0) {
    if (pdf === 'FORBIDDEN')
      refusals.push(`${label} does not accept a PDF on a ${kindLabel}. Remove it.`);
    if (pdf === 'DOCUMENT_POST' && count > 1)
      refusals.push(
        `${label} posts a PDF only as a document post, on its own. Remove the other ${count - 1} media item${count === 2 ? '' : 's'}.`,
      );
    if (pdf === 'DROPPED')
      warnings.push(`${label} drops PDFs, so that media item will not appear.`);
  }
  if (mediaKinds.includes('unknown'))
    warnings.push(
      `${label} media could not be classified from its URL, so these limits were checked without knowing whether it is an image or a video.`,
    );

  if (capability.stripsLinks && signalTextHasLink(caption))
    warnings.push(
      `${label} removes links from the post body; move the link to a reply before publishing.`,
    );
  if (capability.title.supported && capability.title.required)
    warnings.push(
      `${label} takes a title separate from the description and Signal has none, so the caption is used as the title.`,
    );
  if (kind === 'REEL' && !capability.thumbnail)
    warnings.push(`${label} chooses its own thumbnail; this provider sends none.`);

  return { refusals, warnings };
}

const planHash = (value: unknown) =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Resolves one channel to one provider account, or explains why it could not.
 *
 * Only `G.Holmes Designs` may receive this campaign's work on Facebook, and zero or several
 * matches refuse rather than falling back to another page (`docs/publishing-integration.md` §3.1).
 */
function resolveTarget(
  platform: string,
  label: string,
  connected: PublishTarget[],
): { target?: PublishTarget; refusal?: string } {
  const candidates = connected.filter((target) => target.platform === platform);
  const resolved =
    platform === 'facebook'
      ? candidates.filter(
          (target) =>
            target.name === 'G.Holmes Designs' ||
            target.handle.toLowerCase().replace(/[^a-z0-9]/g, '') === 'gholmesdesigns',
        )
      : candidates;
  if (resolved.length === 1) return { target: resolved[0] as PublishTarget };
  return {
    refusal:
      resolved.length === 0
        ? `${label} has no connected account${platform === 'facebook' ? ' for G.Holmes Designs' : ''}. Connect one in Post Bridge.`
        : `${label} resolved to ${resolved.length} connected accounts${platform === 'facebook' ? ' for G.Holmes Designs' : ''} and this app sends to exactly one. Disconnect the ones this campaign must not reach.`,
  };
}

/** Preflights one channel: what it maps to, what it resolved to, and what it refuses. */
function reportForChannel(
  channel: SignalChannel,
  kind: PublishPostKind,
  caption: string,
  mediaKinds: SignalMediaKind[],
  connected: PublishTarget[],
): PublishChannelReport {
  const channelLabel = SIGNAL_CHANNEL_LABEL[channel] ?? channel;
  const platform = publishPlatformFor(channel);
  if (platform === null)
    return {
      channel,
      platform: null,
      kind,
      status: 'NOT_AVAILABLE',
      refusals: [],
      warnings: [
        `${channelLabel} is not available from this provider. Publish it yourself and mark the post published.`,
      ],
    };
  const capability = platform === undefined ? undefined : publishCapabilityFor(platform);
  if (!capability)
    return {
      channel,
      platform: platform ?? null,
      kind,
      status: 'BLOCKED',
      refusals: [
        `${channelLabel} is not answered by the provider capability contract, so nothing can be sent to it. Record it in shared/publish-capabilities.ts before publishing to it.`,
      ],
      warnings: [],
    };
  const { refusals, warnings } = preflightPlatform({ capability, kind, caption, mediaKinds });
  const { target, refusal } = resolveTarget(capability.platform, capability.label, connected);
  if (refusal) refusals.push(refusal);
  return {
    channel,
    platform: capability.platform,
    kind,
    status: refusals.length ? 'BLOCKED' : 'READY',
    ...(target ? { accountId: target.id, handle: target.handle || target.name } : {}),
    refusals,
    warnings,
  };
}

export function buildPublishPlan(
  post: SignalPost,
  connected: PublishTarget[],
  zone: string,
  now = new Date(),
): PublishPreview & { request?: PublishRequest } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const caption = post.text.trim();
  // Post Bridge requires a caption on every submission, including the platform formats that show
  // only media, so this is provider-wide rather than a platform capability.
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

  const kind = publishPostKindFor(post.format);
  const mediaKinds = post.mediaUrls.map(signalMediaKind);
  const channels = post.channels.map((channel) =>
    reportForChannel(channel, kind, caption, mediaKinds, connected),
  );
  const targets: PublishPreview['targets'] = channels
    .filter((report) => report.status === 'READY' && report.platform && report.accountId)
    .map((report) => ({
      channel: report.channel,
      platform: report.platform as string,
      accountId: report.accountId as number,
      handle: report.handle as string,
    }));
  // Plan-level only when nothing resolved at all. A channel that resolved and is blocked has
  // already said why, and repeating it here as "nothing resolved" would contradict its own report.
  if (channels.every((report) => report.accountId === undefined))
    refusals.push('No publishable channel has a resolved provider target.');

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
    channels,
    warnings,
    refusals,
  };
  if (scheduledInstant && publishPreviewRefusals(preview).length === 0)
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
