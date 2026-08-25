import crypto from 'node:crypto';
import {
  samePlatformNearDuplicateWarning,
  samePlatformPolicyRefusal,
} from '../../shared/publish-same-platform.ts';
import {
  signalMediaKind,
  signalMediaKindFor,
  signalTextHasLink,
  SIGNAL_CHANNEL_LABEL,
  type SignalChannel,
  type SignalMediaKind,
  type SignalPost,
} from '../../shared/signal.ts';
import {
  SIGNAL_DRIVE_IMAGE_MAX_ITEMS,
  SIGNAL_DRIVE_TOTAL_MAX_BYTES,
  signalMediaFingerprint,
  type SignalPostMedia,
} from '../../shared/signal-media.ts';
import {
  publishCapabilityFor,
  publishKindSupported,
  publishPlatformFor,
  publishPostKindFor,
  PUBLISH_POST_KIND_LABEL,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
} from '../../shared/publish-capabilities.ts';
import { BUFFER_PROVIDER } from '../../shared/buffer.ts';
import {
  DEFAULT_BUFFER_SCHEDULING_TYPE,
  isBufferProvider,
  publishCapabilityForProvider,
  type BufferSchedulingType,
} from '../../shared/buffer-capabilities.ts';
import { bufferMediaPlan, type BufferWirePreview } from '../../shared/buffer-media.ts';
import {
  publishEffectiveCaption,
  publishVariantFieldSupported,
  publishVariantLayers,
  resolvePublishContent,
  PUBLISH_ACCOUNT_DELIVERABLE_FIELDS,
  PUBLISH_VARIANT_FIELDS,
  PUBLISH_VARIANT_FIELD_LABEL,
  PUBLISH_VARIANT_MEDIA_FIELD,
  type PublishVariantField,
  type PublishVariantRecord,
} from '../../shared/publish-variants.ts';
import {
  publishRoleDelivers,
  publishRoleMediaIssue,
  publishRoleWarning,
  PUBLISH_VARIANT_MEDIA_ROLES,
  PUBLISH_VARIANT_MEDIA_ROLE_LABEL,
} from '../../shared/publish-variant-media.ts';
import type {
  PublishChannelContent,
  PublishChannelReport,
  PublishChannelStatus,
  PublishTargetSelections,
  PublishPreview,
} from '../../shared/publish.ts';
import { deliveryModeForCapability, publishPreviewRefusals } from '../../shared/publish.ts';
import type {
  PublishAccountConfiguration,
  PublishPlatformConfiguration,
  PublishRequest,
  PublishTarget,
} from './provider.ts';

/**
 * One formatter per zone, because building one is what the conversion below actually spent its
 * time on.
 *
 * `publishInstantFor` reads the wall clock 1681 times per call — once a minute across the whole
 * plus-or-minus-fourteen-hour range of possible offsets — and it used to construct a fresh
 * `Intl.DateTimeFormat` for every one of those reads. Constructing one is orders of magnitude
 * dearer than formatting with it: a conversion measured 90 ms that way against 6 ms reusing a
 * single instance, and a preview converts once per channel while a submit converts again, so one
 * publish spent most of a second inside a date conversion (#245). An `Intl.DateTimeFormat` is
 * immutable and keeps no per-call state, so one instance per zone is safe to share, and the set of
 * IANA zone names is finite so the map is bounded by it.
 *
 * Building the entry is also what rejects a zone that does not exist, which is why the conversion
 * asks for its formatter before it scans rather than trusting the caller.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneFormatter = (zone: string) => {
  const cached = zoneFormatters.get(zone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  zoneFormatters.set(zone, formatter);
  return formatter;
};

const partsInZone = (instant: Date, zone: string) => {
  const parts = zoneFormatter(zone).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}`;
};

/** Converts a configured-zone wall time, refusing gaps and choosing the first repeated instant. */
export function publishInstantFor(date: string, time: string, zone: string): string {
  // Building the zone's formatter validates the IANA zone before the scan.
  zoneFormatter(zone);
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

/**
 * What preflight is handed about one submission. No database, no network, no `SignalPost`.
 *
 * `content` is the **resolved** content for one target — base, then the platform override, then the
 * account override, with the effective caption already carrying any disclosure the platform has no
 * field for. Preflight checks what will be sent rather than what was typed, which is the whole
 * point of resolving before checking: a caption that fits until the LinkedIn override lengthens it
 * has to be measured after the override, not before.
 */
export interface PlatformPreflight {
  capability: PublishPlatformCapability;
  content: PublishChannelContent;
  /**
   * The post's media descriptors, so a reference can be classified by what it *is*.
   *
   * `content.mediaUrls` is a selection stated in URLs, which is the vocabulary the per-platform
   * override speaks; a Drive reference's URL is a viewer page and says nothing about the file. The
   * descriptors are matched to it by URL, and a Drive row is classified from the MIME type Drive
   * reported when the reference was resolved — **no Drive call happens here or anywhere else in a
   * preview.** Omitted, every reference is classified from its pathname, which is what a caller
   * holding nothing but URLs correctly gets.
   */
  media?: readonly SignalPostMedia[];
}

/**
 * The post's own content, before any platform or account layer.
 *
 * `mediaUrls` and `media` are the same references twice: the URLs are what a per-platform
 * selection is stated in and what the provider request carries, and the descriptors are what says
 * whether each one is a public URL or a version-bound Drive file. The selection resolves in URLs
 * and is classified through the descriptors.
 */
interface PublishPlanBase {
  caption: string;
  mediaUrls: string[];
  media: readonly SignalPostMedia[];
  postKind: PublishPostKind;
}

/** Classifies the selected URLs, using a descriptor wherever one is known for the URL. */
function mediaKindsFor(
  mediaUrls: readonly string[],
  media: readonly SignalPostMedia[] | undefined,
): SignalMediaKind[] {
  if (!media?.length) return mediaUrls.map(signalMediaKind);
  const byUrl = new Map(media.map((item) => [item.url, item]));
  return mediaUrls.map((url) => {
    const descriptor = byUrl.get(url);
    return descriptor ? signalMediaKindFor(descriptor) : signalMediaKind(url);
  });
}

/** The override fields a platform can refuse outright, and nothing to do with their values. */
const REFUSABLE_VARIANT_FIELDS: PublishVariantField[] = [
  'title',
  'firstComment',
  'coverImage',
  'thumbnail',
];

/**
 * One platform's preflight, answered entirely from the shared capability contract.
 *
 * It takes a capability rather than a platform key so the rules can be exercised against any
 * contract entry — including combinations no connected platform has today, such as a shape that
 * only finishes by hand, or a platform that accepts a chosen thumbnail. Every refusal names what
 * has to change, because a preview that says a post is wrong without saying how is a preview the
 * user has to guess at.
 */
export function preflightPlatform(input: PlatformPreflight): {
  refusals: string[];
  warnings: string[];
} {
  const { capability, content } = input;
  const kind = content.postKind;
  const caption = content.caption;
  const mediaKinds = mediaKindsFor(content.mediaUrls, input.media);
  const refusals: string[] = [];
  const warnings: string[] = [];
  const label = capability.label;
  const kindLabel = PUBLISH_POST_KIND_LABEL[kind];
  const support = capability.kinds[kind];

  /**
   * A stored override the contract does not carry.
   *
   * The composer never offers these fields where they are unsupported and the HTTP boundary refuses
   * them, so reaching this means the capability table changed under content that was already
   * stored. It refuses rather than dropping the field: a title silently discarded is a YouTube video
   * published under the wrong name.
   */
  for (const field of REFUSABLE_VARIANT_FIELDS) {
    if (content[field] === undefined) continue;
    if (publishVariantFieldSupported(field, capability)) continue;
    refusals.push(
      `${label} takes no ${PUBLISH_VARIANT_FIELD_LABEL[field].toLowerCase()} from this provider, and one is set for it. Remove it.`,
    );
  }
  const titleMax = capability.title.maxLength;
  if (content.title !== undefined && titleMax !== null && content.title.length > titleMax)
    refusals.push(
      `${label} limits the title to ${titleMax} characters and this one is ${content.title.length}. Remove ${content.title.length - titleMax}.`,
    );
  const commentMax = capability.firstComment.maxLength;
  if (
    content.firstComment !== undefined &&
    commentMax !== null &&
    content.firstComment.length > commentMax
  )
    refusals.push(
      `${label} limits the first comment to ${commentMax} characters and this one is ${content.firstComment.length}. Remove ${content.firstComment.length - commentMax}.`,
    );
  /**
   * A stored role: whether it is usable, and whether it can be delivered.
   *
   * Two answers, and they are separate. A cover or a thumbnail the provider would reject outright —
   * a video in the role, or an image past the 8 MB ceiling C73 measured — refuses, because a
   * submission carrying it would fail at the wire. A role the provider *names* but the live probe has
   * not verified warns instead: it is stored, it is version-bound, and it does not go out, which is
   * a state the preview has to say out loud rather than imply by silence.
   */
  for (const role of PUBLISH_VARIANT_MEDIA_ROLES) {
    const media = content[PUBLISH_VARIANT_MEDIA_FIELD[role]];
    if (media === undefined) continue;
    // Already refused by the loop above where the platform has no such field at all.
    if (!publishVariantFieldSupported(PUBLISH_VARIANT_MEDIA_FIELD[role], capability)) continue;
    const issue = publishRoleMediaIssue(media, role);
    if (issue) refusals.push(`${label} ${PUBLISH_VARIANT_MEDIA_ROLE_LABEL[role]}: ${issue}`);
    else if (!publishRoleDelivers(capability, role))
      warnings.push(publishRoleWarning(capability, role));
  }
  if (content.discloseSyntheticMedia && capability.syntheticMediaDisclosure === 'IN_CAPTION')
    warnings.push(
      `${label} has no synthetic-media disclosure field from this provider, so the disclosure is written into the caption and counts against its limit.`,
    );

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
      `${label} media could not be classified from what is recorded about it, so these limits were checked without knowing whether it is an image or a video.`,
    );

  if (capability.stripsLinks && signalTextHasLink(caption))
    warnings.push(
      `${label} removes links from the post body; move the link to a reply before publishing.`,
    );
  // Only where none was given. A platform whose title is required and set no longer borrows the
  // caption, which is the first thing these overrides exist to fix.
  if (capability.title.supported && capability.title.required && content.title === undefined)
    warnings.push(
      `${label} takes a title separate from the description and none is set, so the caption is used as the title.`,
    );
  // The absence case, and only the absence case: a role that *is* set has already been answered
  // above, and saying both "you set one and it is not sent" and "the platform picks its own" about
  // one reel would be two sentences for one fact.
  if (kind === 'REEL' && !capability.thumbnail && content.thumbnail === undefined)
    warnings.push(`${label} chooses its own thumbnail; this provider sends none.`);
  if (kind === 'REEL' && !capability.coverImage && content.coverImage === undefined)
    warnings.push(`${label} chooses its own cover image; this provider sends none.`);

  return { refusals, warnings };
}

/**
 * The staleness token, over whatever a caller says the plan is made of.
 *
 * Exported because the provider reconciliation in `reconcile.ts` needs the same token over a wider
 * subject — the plan *and* the provider's own record — and two hashing rules for two things that
 * both mean "this is what you looked at" is how one of them ends up weaker than the other.
 */
export const planHash = (value: unknown) =>
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
  let resolved =
    platform === 'facebook'
      ? candidates.filter(
          (target) =>
            target.name === 'G.Holmes Designs' ||
            target.handle.toLowerCase().replace(/[^a-z0-9]/g, '') === 'gholmesdesigns',
        )
      : candidates;
  // When both providers list the same platform, keep Post Bridge for auto-resolve so Buffer's
  // read-only account refresh cannot steal a Post Bridge submission. Explicit target selection is
  // how a person chooses Buffer instead; this filter only applies to the §3.1 single-account path.
  const postBridgeOnly = resolved.filter(
    (target) => (target.provider ?? 'post-bridge') === 'post-bridge',
  );
  if (postBridgeOnly.length) resolved = postBridgeOnly;
  if (resolved.length === 1) {
    const target = resolved[0] as PublishTarget;
    if (target.unavailable)
      return {
        refusal: `${label} is connected to ${target.name || target.handle}, which is ${target.unavailable.toLowerCase()}.`,
      };
    return { target };
  }
  return {
    refusal:
      resolved.length === 0
        ? `${label} has no connected account${platform === 'facebook' ? ' for G.Holmes Designs' : ''}. Connect one in ${connectLabelForProvider(
            candidates.some((entry) => targetProvider(entry) === 'post-bridge')
              ? 'post-bridge'
              : candidates[0]
                ? targetProvider(candidates[0])
                : 'post-bridge',
          )}.`
        : `${label} resolved to ${resolved.length} connected accounts${platform === 'facebook' ? ' for G.Holmes Designs' : ''} and this app sends to exactly one. Disconnect the ones this campaign must not reach.`,
  };
}

const targetProvider = (target: PublishTarget): string => target.provider ?? 'post-bridge';
const targetAccountRef = (target: PublishTarget): string => target.accountRef ?? String(target.id);
const connectLabelForProvider = (provider: string): string =>
  provider === BUFFER_PROVIDER ? 'Buffer' : 'Post Bridge';

const capabilityForTarget = (
  platform: PublishPlatform,
  target: PublishTarget | undefined,
): PublishPlatformCapability | undefined =>
  publishCapabilityForProvider(
    target ? targetProvider(target) : undefined,
    platform,
    target?.schedulingType,
  ) ?? publishCapabilityFor(platform);

/**
 * The same resolution, as the list every later stage reads.
 *
 * Today it holds one account or none, because `resolveTarget` above is still the only thing that
 * decides — this is the seam and not the change. C77's next piece replaces what fills the list with
 * a person's explicit selection, and everything downstream already handles a list by then, so the
 * behaviour change lands in one place instead of being threaded through the planner in the same
 * commit that adds the feature.
 */
function resolveChannelTargets(
  platform: string,
  label: string,
  connected: PublishTarget[],
  selected: readonly number[],
): { targets: PublishTarget[]; refusal?: string; explicit: boolean } {
  // No selection is not a selection of nothing. It means nobody has chosen, so §3.1's rule still
  // decides and the channel plans exactly as it did before this card.
  if (!selected.length) {
    const { target, refusal } = resolveTarget(platform, label, connected);
    return { targets: target ? [target] : [], ...(refusal ? { refusal } : {}), explicit: false };
  }
  // An explicit selection replaces the rule rather than filtering its result: the whole point is
  // that a person said which accounts, so "resolved to several" is no longer a refusal and
  // G.Holmes Designs is no longer implied. What an id must still be is connected and on this
  // platform, because a selection saved yesterday can name an account disconnected since.
  const targets: PublishTarget[] = [];
  const missing: number[] = [];
  for (const id of selected) {
    const target = connected.find((entry) => entry.id === id && entry.platform === platform);
    if (target) targets.push(target);
    else missing.push(id);
  }
  const unavailable = targets.find((target) => target.unavailable);
  const unavailableRefusal = unavailable
    ? `${label} was told to publish to ${unavailable.name || unavailable.handle}, which is ${unavailable.unavailable?.toLowerCase()}.`
    : undefined;
  const refusal = missing.length
    ? `${label} was told to publish to ${missing.length === 1 ? 'an account' : 'accounts'} ${missing.join(', ')}, which this provider no longer lists for it. Choose its accounts again.`
    : unavailableRefusal;
  return { targets, ...(refusal ? { refusal } : {}), explicit: true };
}

/**
 * One account's resolved content and its own verdict.
 *
 * Per target rather than per channel, which is the distinction the whole card turns on: two
 * accounts on one platform can resolve different content and refuse for different reasons, and a
 * sentence about "the platform" cannot say which of them it meant. Nothing collapses these into a
 * platform-level answer here; `reportForChannel` decides how to present them.
 */
interface PublishTargetResolution {
  target?: PublishTarget;
  content: PublishChannelContent;
  refusals: string[];
  warnings: string[];
  bufferWire?: BufferWirePreview;
  bufferSchedulingType?: BufferSchedulingType;
  driveOverridable?: boolean;
}

function resolutionForTarget(
  base: PublishPlanBase,
  platform: PublishPlatform,
  variants: readonly PublishVariantRecord[],
  target: PublishTarget | undefined,
  driveOverride: boolean,
): PublishTargetResolution {
  const capability = capabilityForTarget(platform, target);
  if (!capability) throw new Error(`Missing capability for ${platform}`);
  const { content, warnings: resolveWarnings } = resolveForTarget(
    base,
    capability,
    variants,
    target?.id,
  );
  const warnings = [...resolveWarnings];
  const refusals: string[] = [];
  let bufferWire: BufferWirePreview | undefined;
  let bufferSchedulingType: BufferSchedulingType | undefined;
  let driveOverridable: boolean | undefined;

  if (target && isBufferProvider(targetProvider(target))) {
    bufferSchedulingType = target.schedulingType ?? DEFAULT_BUFFER_SCHEDULING_TYPE;
    const mediaPlan = bufferMediaPlan({
      capability,
      platform,
      schedulingType: bufferSchedulingType,
      content,
      media: base.media,
      driveOverride,
    });
    refusals.push(...mediaPlan.refusals);
    warnings.push(...mediaPlan.warnings);
    bufferWire = mediaPlan.bufferWire;
    driveOverridable = mediaPlan.driveOverridable;
  }

  const preflight = preflightPlatform({ capability, content, media: base.media });
  refusals.push(...preflight.refusals);
  warnings.push(...preflight.warnings);

  return {
    ...(target ? { target } : {}),
    content,
    refusals,
    warnings,
    ...(bufferWire ? { bufferWire } : {}),
    ...(bufferSchedulingType ? { bufferSchedulingType } : {}),
    ...(driveOverridable ? { driveOverridable } : {}),
  };
}

/**
 * One channel's resolved content, and what resolving it cost.
 *
 * A media selection is intersected with the post's own media, in the selection's order. A post can
 * lose a media reference after a platform was told to send it, and the two honest answers are to
 * refuse or to say out loud what was dropped; silently sending a URL the post no longer carries is
 * not among them.
 */
function resolveForTarget(
  base: PublishPlanBase,
  capability: PublishPlatformCapability,
  variants: readonly PublishVariantRecord[],
  accountId: number | undefined,
): { content: PublishChannelContent; warnings: string[] } {
  const warnings: string[] = [];
  const layers = publishVariantLayers(variants, capability.platform, accountId);
  const resolved = resolvePublishContent(base, layers);
  if (resolved.sources.mediaUrls !== 'BASE') {
    const kept = resolved.mediaUrls.filter((url) => base.mediaUrls.includes(url));
    const dropped = resolved.mediaUrls.length - kept.length;
    if (dropped > 0)
      warnings.push(
        `${capability.label} was given ${dropped} media item${dropped === 1 ? '' : 's'} the post no longer carries, and ${dropped === 1 ? 'it was' : 'they were'} left out. Choose its media again.`,
      );
    resolved.mediaUrls = kept;
  }
  // Any field from the account layer, not only the caption: the provider keys its overrides by
  // platform, so an account's title travels the same way an account's caption does.
  const fromAccount = PUBLISH_VARIANT_FIELDS.filter(
    (field) => resolved.sources[field] === 'ACCOUNT',
  );
  if (fromAccount.length > 0 && !capability.accountContentOverride)
    warnings.push(
      `${capability.label} carries one set of content per platform from this provider, so this account's ${fromAccount.map((field) => PUBLISH_VARIANT_FIELD_LABEL[field].toLowerCase()).join(' and ')} is sent as the platform's. That is unambiguous only because ${capability.label} resolved to a single account.`,
    );
  // A platform that carries per-account content still does not carry every field that way. C73
  // verified a per-account caption and per-account media and nothing else, so an account layer
  // setting a title, a first comment, a post shape, or a role travels as its platform's — and the
  // preview says which fields those were rather than letting them look account-level.
  if (capability.accountContentOverride) {
    const platformLevel = fromAccount.filter(
      (field) => !PUBLISH_ACCOUNT_DELIVERABLE_FIELDS.includes(field),
    );
    if (platformLevel.length > 0)
      warnings.push(
        `This provider carries a caption and media per account, but not ${platformLevel.map((field) => PUBLISH_VARIANT_FIELD_LABEL[field].toLowerCase()).join(' or ')}, so this account's ${platformLevel.length === 1 ? 'value' : 'values'} for ${platformLevel.length === 1 ? 'it' : 'those'} is sent as ${capability.label}'s and reaches every account on it.`,
      );
  }
  const content: PublishChannelContent = {
    ...resolved,
    // The effective caption from here on: what the limit is measured against and what is sent.
    caption: publishEffectiveCaption(resolved, capability),
    deliveryMode: deliveryModeForCapability(capability, resolved.postKind),
  };
  return { content, warnings };
}

/**
 * Preflights one channel: what it maps to, what it resolved to, and what it refuses.
 *
 * The account is resolved **before** the content, which is the only order that works: the account
 * layer is keyed by provider account id, so there is nothing to resolve against until the channel
 * has an account. A channel whose account did not resolve still reports its platform-layer content,
 * because the refusal is about the connection and the user should still see what would have gone.
 */
function reportForChannel(
  channel: SignalChannel,
  base: PublishPlanBase,
  connected: PublishTarget[],
  variants: readonly PublishVariantRecord[],
  selected: readonly number[] = [],
  driveOverride = false,
): PublishChannelReport {
  const channelLabel = SIGNAL_CHANNEL_LABEL[channel] ?? channel;
  const platform = publishPlatformFor(channel);
  if (platform === null)
    return {
      channel,
      platform: null,
      kind: base.postKind,
      mode: 'UNSUPPORTED',
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
      kind: base.postKind,
      mode: 'UNSUPPORTED',
      status: 'BLOCKED',
      refusals: [
        `${channelLabel} is not answered by the provider capability contract, so nothing can be sent to it. Record it in shared/publish-capabilities.ts before publishing to it.`,
      ],
      warnings: [],
    };
  const { targets, refusal, explicit } = resolveChannelTargets(
    capability.platform,
    capability.label,
    connected,
    selected,
  );
  // One resolution per account the channel resolved to, and one anyway when it resolved to none —
  // a channel whose account did not resolve still reports its platform-layer content, because the
  // refusal is about the connection and the user should still see what would have gone.
  //
  // The list is one entry long today. It is built as a list so that the piece which teaches this
  // planner about an explicit selection changes what fills it rather than how it is read.
  const resolutions = targets.length
    ? targets.map((target) =>
        resolutionForTarget(base, capability.platform, variants, target, driveOverride),
      )
    : [resolutionForTarget(base, capability.platform, variants, undefined, driveOverride)];
  const primary = resolutions[0] as PublishTargetResolution;
  // The channel-level fields describe the first target, so a reader written before per-account
  // reports existed still sees something true rather than nothing.
  const refusals = [...primary.refusals];
  if (refusal) refusals.push(refusal);
  // Every selected account's own verdict, and only where somebody selected. A channel resolving
  // by §3.1's rule carries no list, which is what keeps its report byte-identical to before.
  const targetReports = explicit
    ? resolutions
        .filter((resolution) => resolution.target)
        .map((resolution) => {
          const target = resolution.target as PublishTarget;
          return {
            accountId: target.id,
            provider: targetProvider(target),
            accountRef: targetAccountRef(target),
            handle: target.handle || target.name,
            content: resolution.content,
            status: (resolution.refusals.length ? 'BLOCKED' : 'READY') as PublishChannelStatus,
            refusals: resolution.refusals,
            warnings: resolution.warnings,
            ...(resolution.bufferWire ? { bufferWire: resolution.bufferWire } : {}),
            ...(resolution.bufferSchedulingType
              ? { bufferSchedulingType: resolution.bufferSchedulingType }
              : {}),
            ...(resolution.driveOverridable ? { driveOverridable: resolution.driveOverridable } : {}),
          };
        })
    : undefined;
  // A channel is blocked when any of its accounts is: sending to some of the accounts a person
  // chose and quietly dropping the rest is the one outcome nobody asked for.
  const anyTargetBlocked = (targetReports ?? []).some((entry) => entry.status === 'BLOCKED');
  // The same-platform rule, applied here because only this scope knows every account one platform
  // is about to receive. C73 verified the API accepts identical content and refuses nothing
  // (`docs/post-bridge-api-surface.md` §14, question 1), so both halves below are this app's own
  // judgement rather than a provider rule being relayed — `shared/publish-same-platform.ts` says
  // why, and why the refusal no longer claims otherwise.
  //
  // Identical content refuses; content that only reads as identical warns and leaves the decision
  // with the person, which is the one thing a rule here cannot do honestly.
  const samePlatform =
    targetReports && targetReports.length > 1
      ? targetReports.map((entry) => ({
          accountId: entry.accountId,
          handle: entry.handle,
          caption: entry.content?.caption ?? '',
          mediaUrls: entry.content?.mediaUrls ?? [],
        }))
      : undefined;
  const duplicate = samePlatform && samePlatformPolicyRefusal(capability.label, samePlatform);
  if (duplicate) refusals.push(duplicate);
  const nearDuplicate =
    samePlatform && samePlatformNearDuplicateWarning(capability.label, samePlatform);
  return {
    channel,
    platform: capability.platform,
    kind: primary.content.postKind,
    // The resolved kind, not the post's: a placement override changes what the shape is and can
    // change how it is delivered, so the route is read after the layers resolved.
    mode: primary.content.deliveryMode,
    status: refusals.length || anyTargetBlocked ? 'BLOCKED' : 'READY',
    ...(primary.target
      ? {
          accountId: primary.target.id,
          provider: targetProvider(primary.target),
          accountRef: targetAccountRef(primary.target),
          handle: primary.target.handle || primary.target.name,
        }
      : {}),
    content: primary.content,
    ...(primary.bufferWire ? { bufferWire: primary.bufferWire } : {}),
    ...(primary.bufferSchedulingType ? { bufferSchedulingType: primary.bufferSchedulingType } : {}),
    ...(primary.driveOverridable ? { driveOverridable: primary.driveOverridable } : {}),
    ...(targetReports ? { targets: targetReports } : {}),
    refusals,
    // The first target's warnings, plus the one warning that belongs to the channel rather than to
    // any single account: no account can see that another was given the same words. A channel
    // nobody selected accounts for has no second target and no near-duplicate to report, so its
    // warnings stay exactly the list they were before this existed.
    warnings: nearDuplicate ? [...primary.warnings, nearDuplicate] : primary.warnings,
  };
}

/**
 * The tailored content the provider is given, one entry per platform that has any.
 *
 * `platform_configurations` is keyed by platform and carries text alone (`caption`, `first_comment`,
 * a title, and a placement), so this is where an override becomes something the provider can act on
 * and where the ones it cannot carry stop. A configuration is emitted only when it differs from the
 * submission's own caption or adds a field, which is what keeps an untailored post sending exactly
 * the request it sent before any of this existed.
 */
/**
 * The per-account content the provider is given, one entry per selected account that differs.
 *
 * Only for a platform whose `accountContentOverride` is true, which is the one platform C73's
 * evidence covers. Only where the account's caption actually differs from the submission's own,
 * for the same reason `platformConfigurationsFor` is selective: an untailored account adds no key
 * and the request stays the one it would have been.
 *
 * The caption compared is the **effective** one — the disclosure sentence already appended — so
 * what is hashed, previewed, measured against the limit, and sent are all the same string.
 */
function accountConfigurationsFor(
  reports: PublishChannelReport[],
  baseCaption: string,
  perAccountMedia: readonly { accountId: number; mediaUrls: string[] }[] = [],
): PublishAccountConfiguration[] {
  const ownMediaAccounts = new Set(perAccountMedia.map((entry) => entry.accountId));
  const configurations: PublishAccountConfiguration[] = [];
  for (const report of reports) {
    if (report.status !== 'READY' || !report.platform || !report.targets) continue;
    const capability = publishCapabilityFor(report.platform);
    if (!capability?.accountContentOverride) continue;
    for (const entry of report.targets) {
      if (entry.status !== 'READY' || !entry.content) continue;
      const ownCaption = entry.content.caption !== baseCaption;
      const ownMedia = ownMediaAccounts.has(entry.accountId);
      if (!ownCaption && !ownMedia) continue;
      configurations.push({
        accountId: entry.accountId,
        ...(ownCaption ? { caption: entry.content.caption } : {}),
        // The ids do not exist yet. They are produced by uploading immediately before the request,
        // so the plan records only *that this account has its own media*; the publish service
        // fills the ids in. A plan never carries a provider media id — it is not a durable
        // reference and it is recreated on every submit, update, and restore-and-resubmit.
        ...(ownMedia ? { mediaIds: [] } : {}),
      });
    }
  }
  return configurations;
}

function platformConfigurationsFor(
  reports: PublishChannelReport[],
  baseCaption: string,
): PublishPlatformConfiguration[] {
  const configurations: PublishPlatformConfiguration[] = [];
  for (const report of reports) {
    const content = report.content;
    if (report.status !== 'READY' || !report.platform || !content) continue;
    const capability = publishCapabilityFor(report.platform);
    const configuration: PublishPlatformConfiguration = { platform: report.platform };
    if (content.caption !== baseCaption) configuration.caption = content.caption;
    if (content.title !== undefined) configuration.title = content.title;
    if (content.firstComment !== undefined) configuration.firstComment = content.firstComment;
    // A story is a real provider placement and exists only where the contract records one. A reel
    // is one video in the platform's ordinary post, so it changes what preflight accepts and sends
    // no placement — see `shared/publish-capabilities.ts` on why `REEL` is not a provider shape.
    if (content.postKind === 'STORY' && capability && publishKindSupported(capability.kinds.STORY))
      configuration.story = true;
    if (Object.keys(configuration).length > 1) configurations.push(configuration);
  }
  return configurations;
}

/**
 * The accounts that chose media of their own, and the refusals that shape makes possible.
 *
 * **Only an all-Drive post can do this.** The provider takes one media array for the submission and
 * a list of media ids per account, and a Drive file becomes an id only by being uploaded
 * immediately before the request (C75). A public URL never becomes an id, so an account override
 * naming one has nowhere to go — and the card is explicit that it must **refuse** rather than be
 * dropped or quietly replaced with the platform's media, which is exactly what would otherwise
 * happen: `agreedMedia` reads the channel's primary target and would never see the difference.
 *
 * Mixing is refused for the same reason C75 refuses it at the submission level. A post whose own
 * media is public URLs cannot give one account Drive files, because the request carries `media`
 * **or** `media_urls` and never both.
 */
function accountMediaFor(
  reports: PublishChannelReport[],
  postMedia: readonly SignalPostMedia[],
): {
  perAccount: { accountId: number; mediaUrls: string[]; items: SignalPostMedia[] }[];
  refusals: string[];
} {
  const perAccount: { accountId: number; mediaUrls: string[]; items: SignalPostMedia[] }[] = [];
  const refusals: string[] = [];
  const descriptorFor = (url: string) =>
    postMedia.find((item) => item.url === url) ?? ({ source: 'URL', url } as SignalPostMedia);
  for (const report of reports) {
    if (!report.platform || !report.targets) continue;
    const capability = publishCapabilityFor(report.platform);
    if (!capability?.accountContentOverride) continue;
    // The channel's own media is the first target's, which is what the submission would carry.
    const channelMedia = JSON.stringify(report.content?.mediaUrls ?? []);
    for (const entry of report.targets) {
      if (!entry.content) continue;
      const own = entry.content.mediaUrls;
      if (JSON.stringify(own) === channelMedia) continue;
      const items = own.map(descriptorFor);
      const publicUrls = items.filter((item) => item.source !== 'DRIVE');
      if (publicUrls.length) {
        refusals.push(
          `${entry.handle || entry.accountId} was given ${publicUrls.length === 1 ? 'a public address' : 'public addresses'} of its own on ${capability.label} (${publicUrls.map((item) => item.url).join(', ')}). This provider only carries media per account as files uploaded from Drive, so that selection cannot be sent — and it is not dropped or replaced with the platform's. Choose Drive files for it, or give it the same media as the rest of the channel.`,
        );
        continue;
      }
      perAccount.push({ accountId: entry.accountId, mediaUrls: own, items });
    }
  }
  return { perAccount, refusals };
}

/**
 * The media every target agrees on, or a refusal naming the ones that disagree.
 *
 * The provider takes one media array for the whole submission, so a per-platform selection is
 * delivered through that array and only while every target wants the same thing from it. Splitting
 * one post into several submissions to honour two selections is a different card; guessing which
 * selection wins is not an option at all.
 */
function agreedMedia(
  reports: PublishChannelReport[],
  baseMedia: string[],
): { mediaUrls: string[]; refusals: string[] } {
  const ready = reports.filter((report) => report.status === 'READY' && report.content);
  const distinct = new Map<string, PublishChannelReport[]>();
  for (const report of ready) {
    const key = JSON.stringify(report.content?.mediaUrls ?? []);
    distinct.set(key, [...(distinct.get(key) ?? []), report]);
  }
  if (distinct.size <= 1)
    return { mediaUrls: ready[0]?.content?.mediaUrls ?? baseMedia, refusals: [] };
  const described = [...distinct.values()]
    .map((group) => {
      const count = group[0]?.content?.mediaUrls.length ?? 0;
      const names = group
        .map((report) => SIGNAL_CHANNEL_LABEL[report.channel] ?? report.channel)
        .join(', ');
      return `${names} (${count} item${count === 1 ? '' : 's'})`;
    })
    .join('; ');
  return {
    mediaUrls: baseMedia,
    refusals: [
      `This provider sends one set of media per submission and these channels were given different media: ${described}. Give them the same media, or publish them separately.`,
    ],
  };
}

/**
 * The whole plan: the instant, every channel's resolved content and verdict, and the request that
 * would be sent if nothing refuses.
 *
 * `variants` defaults to none, so a post with no overrides plans exactly as it did before they
 * existed. Every channel resolves its own content from the same three layers, which is what lets one
 * preview answer for seven different targets without the caller assembling anything.
 */
export function buildPublishPlan(
  post: SignalPost,
  connected: PublishTarget[],
  zone: string,
  now = new Date(),
  variants: readonly PublishVariantRecord[] = [],
  selections: PublishTargetSelections = [],
  /**
   * Explicit, per-send permission to convert a Buffer target's Drive media to Drive's
   * direct-download address rather than refuse it. Defaults to false, so an unmodified caller
   * plans exactly as it did before this existed; see `shared/buffer-media.ts` for the risk this
   * accepts and why it is opt-in only.
   */
  driveOverride = false,
): PublishPreview & {
  request?: PublishRequest;
  mediaSources?: SignalPostMedia[];
  accountMediaSources?: { accountId: number; items: SignalPostMedia[] }[];
} {
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

  const base: PublishPlanBase = {
    caption,
    mediaUrls: post.mediaUrls,
    media: post.media,
    postKind: publishPostKindFor(post.format),
  };
  // Grouped once rather than filtered per channel, and kept in the order the service read them —
  // the ids ride into the plan hash through `targets`, so an order that wandered between two reads
  // of an unchanged post would invalidate a confirmation nobody had touched.
  const selectedByChannel = new Map<string, number[]>();
  for (const selection of selections)
    selectedByChannel.set(selection.channel, [
      ...(selectedByChannel.get(selection.channel) ?? []),
      selection.providerAccountId,
    ]);
  const channels = post.channels.map((channel) =>
    reportForChannel(
      channel,
      base,
      connected,
      variants,
      selectedByChannel.get(channel) ?? [],
      driveOverride,
    ),
  );
  // One entry per account that will actually be sent to. A channel with an explicit selection
  // contributes each of its ready accounts; a channel without one contributes the single account
  // §3.1 resolved, exactly as it always did.
  const targets: PublishPreview['targets'] = channels.flatMap((report) => {
    if (report.status !== 'READY' || !report.platform) return [];
    if (report.targets)
      return report.targets
        .filter((entry) => entry.status === 'READY')
        .map((entry) => ({
          channel: report.channel,
          platform: report.platform as string,
          accountId: entry.accountId,
          provider: entry.provider,
          accountRef: entry.accountRef,
          handle: entry.handle,
          mode: report.mode,
        }));
    return report.accountId
      ? [
          {
            channel: report.channel,
            platform: report.platform as string,
            accountId: report.accountId,
            provider: report.provider as string,
            accountRef: report.accountRef as string,
            handle: report.handle as string,
            mode: report.mode,
          },
        ]
      : [];
  });
  // Plan-level only when nothing resolved at all. A channel that resolved and is blocked has
  // already said why, and repeating it here as "nothing resolved" would contradict its own report.
  if (channels.every((report) => report.accountId === undefined))
    refusals.push('No publishable channel has a resolved provider target.');

  const submissionProviders = new Set(targets.map((target) => target.provider ?? 'post-bridge'));
  if (submissionProviders.has(BUFFER_PROVIDER) && submissionProviders.size > 1)
    refusals.push(
      'One submission cannot mix Post Bridge and Buffer targets. Choose accounts from one provider per send, or publish in separate steps.',
    );

  const hasPostBridgeTarget = targets.some(
    (target) => (target.provider ?? 'post-bridge') !== BUFFER_PROVIDER,
  );

  // Provider-wide rather than per platform, like the caption rule above: one submission carries one
  // media array, whatever each platform would have preferred.
  const media = agreedMedia(channels, post.mediaUrls);
  refusals.push(...media.refusals);
  const mediaSources = media.mediaUrls.map(
    (url) =>
      post.media.find((item) => item.url === url) ?? ({ source: 'URL', url } as SignalPostMedia),
  );
  const driveMedia = mediaSources.filter((item) => item.source === 'DRIVE');
  const urlMedia = mediaSources.filter((item) => item.source === 'URL');
  let accountMedia = accountMediaFor(channels, post.media);
  if (hasPostBridgeTarget) {
    if (driveMedia.length && urlMedia.length) {
      const driveNames = driveMedia.map((item) => item.driveName ?? item.url).join(', ');
      const urlNames = urlMedia.map((item) => item.url).join(', ');
      refusals.push(
        `This provider cannot mix Drive uploads (${driveNames}) with public URLs (${urlNames}) in one submission. Use only Drive files or only public URLs, or publish them separately.`,
      );
    }
    const uploadedImageCount = driveMedia.filter((item) =>
      item.mimeType?.startsWith('image/'),
    ).length;
    if (uploadedImageCount > SIGNAL_DRIVE_IMAGE_MAX_ITEMS)
      refusals.push(`Post Bridge accepts at most ${SIGNAL_DRIVE_IMAGE_MAX_ITEMS} uploaded images.`);
    const totalDriveBytes = driveMedia.reduce((total, item) => total + (item.sizeBytes ?? 0), 0);
    if (totalDriveBytes > SIGNAL_DRIVE_TOTAL_MAX_BYTES)
      refusals.push('The selected Drive files exceed Post Bridge’s 500 MB total upload limit.');
    accountMedia = accountMediaFor(channels, post.media);
    refusals.push(...accountMedia.refusals);
    // Per-account media only exists as provider ids, so the whole post has to be Drive-sourced. A
    // URL post that gave one account its own files would need `media` and `media_urls` in one
    // request, which C75 refuses at the submission level for exactly this reason.
    if (accountMedia.perAccount.length && urlMedia.length)
      refusals.push(
        `This post's own media is ${urlMedia.length === 1 ? 'a public address' : 'public addresses'}, and per-account media is only sent as files uploaded from Drive. Give the post Drive files, or give every account the same media.`,
      );
  } else refusals.push(...accountMedia.refusals);
  const platformConfigurations = platformConfigurationsFor(channels, caption);
  const accountConfigurations = accountConfigurationsFor(
    channels,
    caption,
    accountMedia.perAccount,
  );

  const stable = {
    postId: post.id,
    updatedAt: post.updatedAt,
    caption,
    // Not otherwise implied by anything else in this object where a Buffer target has no Drive
    // media selected — the flag itself still has to invalidate a confirmation taken before it
    // changed, even though it would leave `bufferWire` byte-identical in that case.
    driveOverride,
    // The media that would be sent rather than the post's own, so a selection changed between
    // preview and confirm invalidates the hash exactly as an edited caption does.
    mediaUrls: media.mediaUrls,
    /**
     * And the same references as whole descriptors, so the token covers what each one *is* and
     * not only where it points.
     *
     * A Drive file's viewer link does not change when its content does — Drive may replace the
     * bytes under the same id — so a hash over URLs alone would call a plan current after the
     * thing it planned to send had been swapped. The version fingerprint is what closes that, and
     * it is why an explicit recheck that finds a new version invalidates an open preview.
     */
    media: media.mediaUrls.map((url) => {
      const descriptor = post.media.find((item) => item.url === url);
      return descriptor ? signalMediaFingerprint(descriptor) : { source: 'URL', url };
    }),
    scheduledInstant,
    timezone: zone,
    targets,
    platformConfigurations,
    // Conditional for the same reason `accountContent` above is: an untouched post's hash must be
    // the number it has always been, and an empty array is not the same as an absent key.
    ...(accountConfigurations.length ? { accountConfigurations } : {}),
    // The per-account files as whole descriptors, for the reason the submission's media is hashed
    // that way: a Drive viewer link does not change when the bytes behind it do, so a hash over
    // urls alone would call a plan current after the thing it planned to send had been swapped.
    ...(accountMedia.perAccount.length
      ? {
          accountMedia: accountMedia.perAccount.map((entry) => ({
            accountId: entry.accountId,
            media: entry.items.map((item) => signalMediaFingerprint(item)),
          })),
        }
      : {}),
    /**
     * Every resolved media role, as a fingerprint, keyed by the channel it belongs to.
     *
     * A role is per platform and per account rather than per submission, so it cannot ride along in
     * `media` above; and it is a whole descriptor for the same reason post media is — a Drive
     * viewer link does not change when the bytes behind it do. This is what makes a role edit, and a
     * recheck that finds a new version, refuse a confirmation taken before it.
     */
    /**
     * What each explicitly selected account resolved to, present only where somebody selected.
     *
     * Conditional on purpose. `targets` above already carries the chosen ids, so this adds the
     * *content* those ids resolved to — editing one account's caption has to refuse a confirmation
     * taken before the edit. Omitting the key entirely when nothing is selected is what keeps an
     * untouched post's hash the number it has always been.
     */
    ...(selections.length
      ? {
          accountContent: channels.flatMap((report) =>
            (report.targets ?? []).map((entry) => ({
              channel: report.channel,
              accountId: entry.accountId,
              caption: entry.content?.caption,
              mediaUrls: entry.content?.mediaUrls,
              postKind: entry.content?.postKind,
              title: entry.content?.title,
              firstComment: entry.content?.firstComment,
            })),
          ),
        }
      : {}),
    roleMedia: channels.flatMap((report) =>
      PUBLISH_VARIANT_MEDIA_ROLES.flatMap((role) => {
        const media = report.content?.[PUBLISH_VARIANT_MEDIA_FIELD[role]];
        return media
          ? [{ channel: report.channel, role, media: signalMediaFingerprint(media) }]
          : [];
      }),
    ),
    ...(channels.some((report) => report.bufferWire)
      ? {
          bufferWire: channels.flatMap((report) => {
            const entries = report.targets?.length
              ? report.targets
              : report.accountId !== undefined
                ? [
                    {
                      accountId: report.accountId,
                      bufferWire: report.bufferWire,
                      bufferSchedulingType: report.bufferSchedulingType,
                    },
                  ]
                : [];
            return entries
              .filter((entry) => 'bufferWire' in entry && entry.bufferWire)
              .map((entry) => ({
                channel: report.channel,
                accountId: entry.accountId,
                schedulingType: entry.bufferSchedulingType ?? report.bufferSchedulingType,
                wire: entry.bufferWire,
              }));
          }),
        }
      : {}),
  };
  const preview: PublishPreview & { request?: PublishRequest; mediaSources?: SignalPostMedia[] } = {
    available: true,
    postId: post.id,
    planHash: planHash(stable),
    caption,
    scheduledInstant,
    timezone: zone,
    targets,
    channels,
    connectedAccounts: connected.map((account) => ({
      id: account.id,
      provider: targetProvider(account),
      accountRef: targetAccountRef(account),
      platform: account.platform,
      handle: account.handle,
      name: account.name,
      ...(account.unavailable ? { unavailable: account.unavailable } : {}),
    })),
    ...(selections.length ? { selectedTargets: [...selections] } : {}),
    warnings,
    refusals,
    mediaSources,
    ...(accountMedia.perAccount.length
      ? {
          accountMediaSources: accountMedia.perAccount.map((entry) => ({
            accountId: entry.accountId,
            items: entry.items,
          })),
        }
      : {}),
  };
  const bufferOnly =
    targets.length > 0 &&
    targets.every((target) => (target.provider ?? 'post-bridge') === BUFFER_PROVIDER);
  if (scheduledInstant && publishPreviewRefusals(preview).length === 0 && !bufferOnly)
    preview.request = {
      caption,
      ...(driveMedia.length ? { mediaIds: [] } : { mediaUrls: media.mediaUrls }),
      scheduledInstant,
      timezone: zone,
      targets: targets.map((target) => ({
        accountId: target.accountId,
        provider: target.provider,
        accountRef: target.accountRef,
        platform: target.platform,
      })),
      ...(accountConfigurations.length ? { accountConfigurations } : {}),
      // Omitted rather than empty, so the provider adapter sends no key at all for an untailored
      // post — the artifact's own rule for `platform_configurations`.
      ...(platformConfigurations.length ? { platformConfigurations } : {}),
    };
  return preview;
}
