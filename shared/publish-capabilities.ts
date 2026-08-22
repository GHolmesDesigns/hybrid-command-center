import { type SignalChannel, type SignalFormat } from './signal.ts';

/**
 * The one provider capability contract.
 *
 * Every rule about what a platform will accept lives here and nowhere else: the preflight in
 * `server/publish/plan.ts` reads it, and the composer reads the same table rather than keeping a
 * second copy of the rules in React. That is the whole reason this file is in `shared/` — a limit
 * the server refuses on and the form does not show is a limit the user meets only after pressing
 * send.
 *
 * ## Where the values come from
 *
 * `docs/social-media-publisher-artifact.md` §3 and §6, extracted from the working integration, are
 * the source for caption limits, media bounds, the media-combination flags, and the per-platform
 * extras. `docs/publishing-integration.md` §3.2 records the contract this file implements.
 * **Nothing here is guessed.** Where the source records no answer, the entry says so by refusing:
 * an unsupported post kind, a forbidden media kind, an unsupported field. That is the fail-closed
 * rule, and it is why every field on `PublishPlatformCapability` is required — a new platform
 * cannot be added while leaving a question unanswered, because the type will not let it.
 *
 * ## What this file is not
 *
 * It is not a provider client and it makes no network call. Preflight answers from this table
 * alone, which is what lets a preview be honest without touching Post Bridge. The limits it
 * cannot know — a corrupt video, a URL that will 404 when the provider fetches it — are named in
 * `docs/publishing-integration.md` §3.2 rather than pretended away.
 *
 * Post Bridge requires a caption on **every** submission, including the kinds that show none. That
 * is a provider-wide rule rather than a platform one, so it is a plan-level refusal in `plan.ts`
 * and not a field here.
 */

/** Every platform this contract answers for. Post Bridge reaches all ten; Signal plans for eight. */
export const PUBLISH_PLATFORMS = [
  'twitter',
  'facebook',
  'linkedin',
  'bluesky',
  'instagram',
  'tiktok',
  'youtube',
  'pinterest',
  'threads',
  'google_business',
] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

/** What a platform is called in a sentence shown to a person. Never the provider's key. */
export const PUBLISH_PLATFORM_LABEL: Record<PublishPlatform, string> = {
  twitter: 'X',
  facebook: 'Facebook',
  linkedin: 'LinkedIn',
  bluesky: 'Bluesky',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  pinterest: 'Pinterest',
  threads: 'Threads',
  google_business: 'Google Business',
};

/**
 * Which provider platform a Signal channel goes to.
 *
 * `blog` maps to `null` deliberately and permanently: no provider publishes to a blog, and a null
 * here is a recorded answer rather than a gap. It is what separates **not available from this
 * provider** from a channel the contract simply fails to cover, which refuses instead
 * (`docs/publishing-integration.md` §10).
 *
 * Post Bridge also reaches `pinterest` and `google_business`. Signal has no channel for them and
 * none is invented — a channel exists because content is planned for it.
 */
export const SIGNAL_CHANNEL_PLATFORM: Record<SignalChannel, PublishPlatform | null> = {
  blog: null,
  bsky: 'bluesky',
  fb: 'facebook',
  ig: 'instagram',
  li: 'linkedin',
  th: 'threads',
  tt: 'tiktok',
  x: 'twitter',
  yt: 'youtube',
};

/**
 * The four shapes a submission can take. A platform answers for each of them separately, because
 * "Instagram accepts this" is not one question: a carousel, a reel, and a story have different
 * media bounds and one of them shows no caption at all.
 */
export const PUBLISH_POST_KINDS = ['POST', 'CAROUSEL', 'REEL', 'STORY'] as const;
export type PublishPostKind = (typeof PUBLISH_POST_KINDS)[number];

export const PUBLISH_POST_KIND_LABEL: Record<PublishPostKind, string> = {
  POST: 'standard post',
  CAROUSEL: 'carousel',
  REEL: 'reel or short',
  STORY: 'story',
};

/**
 * Which shape a planned format submits as.
 *
 * A total record rather than a switch, so adding a `SignalFormat` fails to compile until someone
 * decides what it submits as. Most formats are ordinary posts — a whiteboard video is a video in a
 * standard post, not a distinct provider shape — and only the three formats that name a provider
 * shape map to one.
 */
const FORMAT_POST_KIND: Record<SignalFormat, PublishPostKind> = {
  BLOG_POST: 'POST',
  WHITEBOARD_VIDEO: 'POST',
  INFOGRAPHIC: 'POST',
  VIDEO: 'POST',
  IMAGE: 'POST',
  CAROUSEL: 'CAROUSEL',
  REEL: 'REEL',
  ARTICLE: 'POST',
  QUOTE_CARD: 'POST',
  TEXT: 'POST',
  STORY: 'STORY',
};

export const publishPostKindFor = (format: SignalFormat): PublishPostKind =>
  FORMAT_POST_KIND[format];

/** How a video may sit beside other media. */
export type PublishVideoRule =
  /** Video and images may share one submission. */
  | 'WITH_OTHERS'
  /** A video is accepted only when it is the only item. */
  | 'ALONE_ONLY'
  /** Exactly one video and nothing else. */
  | 'REQUIRED_ALONE'
  /** No video at all. */
  | 'FORBIDDEN';

/** What becomes of a PDF. */
export type PublishDocumentRule =
  /** Accepted, alone, as a document post. */
  | 'DOCUMENT_POST'
  /** Accepted by the provider and silently discarded by the platform. */
  | 'DROPPED'
  /** Not accepted. */
  | 'FORBIDDEN';

/** How a synthetic-media disclosure reaches the platform. */
export type PublishDisclosure =
  /** The provider carries a disclosure flag. */
  | 'PROVIDER_FIELD'
  /** No flag exists, so a disclosure has to be written into the caption. */
  | 'IN_CAPTION';

export interface PublishMediaRule {
  /** Fewest items accepted. `0` means text alone is fine. */
  min: number;
  /** Most items accepted, or `null` where the source records no ceiling. */
  max: number | null;
  video: PublishVideoRule;
  pdf: PublishDocumentRule;
}

/** A field that carries text beside the caption. */
export interface PublishTextField {
  supported: boolean;
  /**
   * Whether the platform uses this field on every submission of a supported kind. LinkedIn's
   * document title applies only to a PDF, so it is supported and not required; YouTube's title is
   * on every video, so it is both, and preflight says out loud that the caption will be used.
   */
  required: boolean;
  /** The recorded limit, or `null` where the source records none. */
  maxLength: number | null;
}

/** What a platform will do with one shape of submission. */
export interface PublishKindSupport {
  /** The provider can complete this without a person. */
  automatic: boolean;
  /** The provider delivers it to the platform's own app for a person to finish. */
  manualFinish: boolean;
  media: PublishMediaRule;
  /** Whether the caption reaches the reader. A story shows none, and the text is lost. */
  captionReachesReader: boolean;
}

export interface PublishPlatformCapability {
  platform: PublishPlatform;
  label: string;
  captionMax: number;
  /**
   * Whether an over-limit caption refuses rather than warns. True where the platform hard-rejects
   * the submission, so sending it would waste the send; elsewhere the platform truncates and the
   * user should hear about it before rather than after.
   */
  captionOverLimitRefuses: boolean;
  /** The platform removes links from the body — full URLs and bare domains alike. */
  stripsLinks: boolean;
  /** One answer per shape. Every shape is answered; there is no "unspecified". */
  kinds: Record<PublishPostKind, PublishKindSupport>;
  /** The provider accepts a per-platform content override in `platform_configurations`. */
  platformContentOverride: boolean;
  /**
   * The provider accepts a per-account override. False everywhere: tailoring is per platform, a
   * stated limitation of the working integration, so two accounts on one platform receive the same
   * text.
   *
   * C62 (#189) builds the overrides themselves against this field and reads it exactly as written.
   * An account override is stored and resolved locally either way; what this flag decides is
   * whether it can be *delivered*. False means one set of content per platform, so an account
   * override arrives only while that platform resolves to a single account, and two accounts on one
   * platform whose resolved content differs is a refusal rather than a coin toss over whose text
   * goes out.
   */
  accountContentOverride: boolean;
  firstComment: PublishTextField;
  title: PublishTextField;
  description: PublishTextField;
  /**
   * A cover image chosen for the submission rather than taken from the media, and a video
   * thumbnail chosen for it. **Whether the provider will carry one**, which is not the same
   * question as whether this app can store one.
   *
   * False on every platform, and each false has a reason recorded rather than assumed. Post
   * Bridge's OpenAPI names `cover_image` on Instagram's platform configuration and `thumbnail` on
   * YouTube's (`docs/post-bridge-api-surface.md` §8), and the 20 August 2026 live probe left both
   * **still unverified** — no video asset was uploaded and each role needs a video as the post's own
   * media (§14, question 3). Current provider support material separately states that custom
   * external YouTube thumbnails are not available, so that conflict is unresolved rather than
   * resolved positively: C76 records it as will-not-build and leaves this flag false.
   *
   * A role may still be *chosen and stored* where the provider names the field —
   * `publishRoleComposable` in `shared/publish-variant-media.ts` — and every stored role that
   * cannot be delivered warns, by platform and by role, in the preview. Flipping one of these to
   * true is what makes a role reach a request, and it takes a dated §14 result saying the provider
   * accepted the field and read it back.
   */
  coverImage: boolean;
  thumbnail: boolean;
  syntheticMediaDisclosure: PublishDisclosure;
  /**
   * Whether a provider draft can be held and submitted later. False everywhere: submitting an
   * existing Post Bridge draft is broken upstream with no supported route around it, so a provider
   * draft is not a staging boundary (`docs/publishing-integration.md` §4).
   */
  providerDraft: boolean;
}

/** Whether a shape can be submitted at all, by either route. */
export const publishKindSupported = (support: PublishKindSupport): boolean =>
  support.automatic || support.manualFinish;

/** The answer for a shape the platform does not take. Nothing about it is accepted. */
const NO_KIND: PublishKindSupport = {
  automatic: false,
  manualFinish: false,
  media: { min: 0, max: 0, video: 'FORBIDDEN', pdf: 'FORBIDDEN' },
  captionReachesReader: false,
};

const kind = (
  media: PublishMediaRule,
  options: { manualFinish?: boolean; captionReachesReader?: boolean } = {},
): PublishKindSupport => ({
  automatic: true,
  manualFinish: options.manualFinish ?? false,
  media,
  captionReachesReader: options.captionReachesReader ?? true,
});

const NO_FIELD: PublishTextField = { supported: false, required: false, maxLength: null };

/**
 * The table.
 *
 * Read it beside `docs/social-media-publisher-artifact.md` §3: every caption limit, media bound and
 * flag below is that table's, and every entry that refuses is a question that source does not
 * answer. A reel is one video in the platform's ordinary post rather than a separate provider
 * shape, which is why `REEL` is available exactly where a lone video is and refused elsewhere; a
 * story is a real provider placement and exists only where the source records one.
 */
export const PUBLISH_CAPABILITIES: Record<PublishPlatform, PublishPlatformCapability> = {
  twitter: {
    platform: 'twitter',
    label: PUBLISH_PLATFORM_LABEL.twitter,
    captionMax: 280,
    captionOverLimitRefuses: true,
    stripsLinks: true,
    kinds: {
      POST: kind({ min: 0, max: 4, video: 'ALONE_ONLY', pdf: 'FORBIDDEN' }),
      CAROUSEL: kind({ min: 2, max: 4, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
      REEL: NO_KIND,
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: { supported: true, required: false, maxLength: 280 },
    title: NO_FIELD,
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  facebook: {
    platform: 'facebook',
    label: PUBLISH_PLATFORM_LABEL.facebook,
    captionMax: 63206,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 0, max: null, video: 'WITH_OTHERS', pdf: 'FORBIDDEN' }),
      CAROUSEL: kind({ min: 2, max: null, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
      REEL: NO_KIND,
      STORY: kind(
        { min: 1, max: 1, video: 'WITH_OTHERS', pdf: 'FORBIDDEN' },
        { captionReachesReader: false },
      ),
    },
    platformContentOverride: true,
    // True for Facebook alone, and only since C73's live probe verified it: `account_configurations`
    // was accepted for two Facebook accounts in one request, its encoding established, and the
    // per-account caption read back after create and after `PATCH`
    // (`docs/post-bridge-api-surface.md` §14, question 1). Every other platform stays false because
    // no other platform had two accounts to ask the question with -- unverified is not the same as
    // unsupported, and only a dated §14 result moves one of them.
    accountContentOverride: true,
    firstComment: NO_FIELD,
    title: NO_FIELD,
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  linkedin: {
    platform: 'linkedin',
    label: PUBLISH_PLATFORM_LABEL.linkedin,
    captionMax: 3000,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 0, max: 20, video: 'ALONE_ONLY', pdf: 'DOCUMENT_POST' }),
      CAROUSEL: kind({ min: 2, max: 20, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
      REEL: NO_KIND,
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    // `document_title`, which labels a PDF document post and nothing else.
    title: { supported: true, required: false, maxLength: null },
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  bluesky: {
    platform: 'bluesky',
    label: PUBLISH_PLATFORM_LABEL.bluesky,
    captionMax: 300,
    captionOverLimitRefuses: true,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 0, max: 4, video: 'ALONE_ONLY', pdf: 'FORBIDDEN' }),
      CAROUSEL: kind({ min: 2, max: 4, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
      REEL: NO_KIND,
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: NO_FIELD,
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  instagram: {
    platform: 'instagram',
    label: PUBLISH_PLATFORM_LABEL.instagram,
    captionMax: 2200,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 1, max: 10, video: 'WITH_OTHERS', pdf: 'DROPPED' }),
      CAROUSEL: kind({ min: 2, max: 10, video: 'WITH_OTHERS', pdf: 'DROPPED' }),
      REEL: kind({ min: 1, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' }),
      STORY: kind(
        { min: 1, max: 1, video: 'WITH_OTHERS', pdf: 'DROPPED' },
        { captionReachesReader: false },
      ),
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: NO_FIELD,
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  tiktok: {
    platform: 'tiktok',
    label: PUBLISH_PLATFORM_LABEL.tiktok,
    captionMax: 2200,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    // TikTok's `draft` extra is the manual-finish route: the submission lands in the TikTok app
    // for the account holder to complete. It is a second way to arrive, not a replacement, so
    // every supported shape here is both automatic and finishable by hand.
    kinds: {
      POST: kind(
        { min: 1, max: null, video: 'ALONE_ONLY', pdf: 'FORBIDDEN' },
        { manualFinish: true },
      ),
      CAROUSEL: kind(
        { min: 2, max: null, video: 'FORBIDDEN', pdf: 'FORBIDDEN' },
        { manualFinish: true },
      ),
      REEL: kind(
        { min: 1, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' },
        { manualFinish: true },
      ),
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: { supported: true, required: false, maxLength: null },
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  youtube: {
    platform: 'youtube',
    label: PUBLISH_PLATFORM_LABEL.youtube,
    captionMax: 5000,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 1, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' }),
      CAROUSEL: NO_KIND,
      REEL: kind({ min: 1, max: 1, video: 'REQUIRED_ALONE', pdf: 'FORBIDDEN' }),
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: { supported: true, required: true, maxLength: 100 },
    description: { supported: true, required: false, maxLength: 5000 },
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  pinterest: {
    platform: 'pinterest',
    label: PUBLISH_PLATFORM_LABEL.pinterest,
    captionMax: 800,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 1, max: 1, video: 'WITH_OTHERS', pdf: 'FORBIDDEN' }),
      CAROUSEL: NO_KIND,
      REEL: NO_KIND,
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: { supported: true, required: true, maxLength: null },
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  threads: {
    platform: 'threads',
    label: PUBLISH_PLATFORM_LABEL.threads,
    captionMax: 500,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 0, max: 4, video: 'WITH_OTHERS', pdf: 'FORBIDDEN' }),
      CAROUSEL: kind({ min: 2, max: 4, video: 'WITH_OTHERS', pdf: 'FORBIDDEN' }),
      REEL: NO_KIND,
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: NO_FIELD,
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
  google_business: {
    platform: 'google_business',
    label: PUBLISH_PLATFORM_LABEL.google_business,
    captionMax: 1500,
    captionOverLimitRefuses: false,
    stripsLinks: false,
    kinds: {
      POST: kind({ min: 0, max: 1, video: 'FORBIDDEN', pdf: 'FORBIDDEN' }),
      CAROUSEL: NO_KIND,
      REEL: NO_KIND,
      STORY: NO_KIND,
    },
    platformContentOverride: true,
    accountContentOverride: false,
    firstComment: NO_FIELD,
    title: NO_FIELD,
    description: NO_FIELD,
    coverImage: false,
    thumbnail: false,
    syntheticMediaDisclosure: 'IN_CAPTION',
    providerDraft: false,
  },
};

/**
 * The capability for a platform key, or `undefined` when the contract has no answer.
 *
 * `undefined` is the fail-closed case and callers refuse on it. It takes a `string` rather than a
 * `PublishPlatform` on purpose: the values reaching this function come from a channel map and, one
 * day, from a provider's own account list, and a cast at the call site would turn an unknown
 * platform into a confident lookup of nothing.
 */
export const publishCapabilityFor = (platform: string): PublishPlatformCapability | undefined =>
  PUBLISH_CAPABILITIES[platform as PublishPlatform];

/** The platform a channel publishes to: `null` for `blog`, `undefined` for anything unrecognised. */
export const publishPlatformFor = (channel: string): PublishPlatform | null | undefined =>
  SIGNAL_CHANNEL_PLATFORM[channel as SignalChannel];
