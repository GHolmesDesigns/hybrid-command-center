import {
  publishKindSupported,
  PUBLISH_POST_KINDS,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
} from './publish-capabilities.ts';

/**
 * Platform and account content variants: the one place the inheritance is defined.
 *
 * One caption used to go to every channel, which meant a post that read well on LinkedIn was the
 * wrong length for X and carried no title for YouTube, with nowhere to say so. A post now has
 * three layers and they resolve in one order:
 *
 * ```text
 * base content
 *   -> platform override
 *     -> account override
 * ```
 *
 * `resolvePublishContent` is that order and nothing else. It has no database, no network, no React
 * and no capability contract in it: given a base and up to two override layers it says what the
 * effective value of every field is and which layer it came from. That is why it is here rather
 * than in `server/publish/plan.ts` — the preflight resolves content before checking it and the
 * composer resolves the same content to show it, and a second copy of the order in React is exactly
 * the drift `shared/publish-capabilities.ts` was moved here to prevent.
 *
 * ## What a layer may say, and what "unset" means
 *
 * Every field on `PublishContentVariant` is optional and absent means **inherit**. The two cases
 * where that needs stating:
 *
 * - **An empty string is not an override.** `normalizePublishVariant` trims and drops it, so
 *   clearing a caption field restores the post's caption rather than sending nothing. Post Bridge
 *   requires a caption on every submission, so an empty override could only ever be a refusal.
 * - **An empty media array is.** `mediaUrls: undefined` inherits the post's media; `mediaUrls: []`
 *   is a deliberate "no media on this platform", which is a real thing to want — the PDF goes to
 *   LinkedIn and X gets the text alone. Those two are different answers and the type keeps them
 *   apart.
 *
 * ## What this file does not decide
 *
 * Whether a platform will *accept* an override is the capability contract's answer, not this
 * file's: `publishVariantFieldSupported` asks it, the composer offers only the fields it says yes
 * to, and the preflight refuses a stored value it says no to. And whether an override can be
 * *delivered* is the plan's answer — the provider takes one media array and one set of content per
 * platform, so conflicting selections refuse in `plan.ts` where the rest of the refusal prose lives.
 */

/** Which layer an effective value came from. */
export const PUBLISH_VARIANT_SCOPES = ['BASE', 'PLATFORM', 'ACCOUNT'] as const;
export type PublishVariantScope = (typeof PUBLISH_VARIANT_SCOPES)[number];

/** What a scope is called in a sentence shown beside a resolved value. */
export const PUBLISH_VARIANT_SCOPE_LABEL: Record<PublishVariantScope, string> = {
  BASE: 'the post',
  PLATFORM: 'the platform override',
  ACCOUNT: 'the account override',
};

/**
 * Every field a layer can override.
 *
 * A list rather than only a type, so the composer and the preview can walk the fields in one
 * agreed order and a field added here is one a caller cannot silently forget.
 */
export const PUBLISH_VARIANT_FIELDS = [
  'caption',
  'mediaUrls',
  'postKind',
  'title',
  'firstComment',
  'discloseSyntheticMedia',
  'coverImageUrl',
  'thumbnailUrl',
] as const;
export type PublishVariantField = (typeof PUBLISH_VARIANT_FIELDS)[number];

export const PUBLISH_VARIANT_FIELD_LABEL: Record<PublishVariantField, string> = {
  caption: 'Caption',
  mediaUrls: 'Media',
  postKind: 'Placement',
  title: 'Title',
  firstComment: 'First comment',
  discloseSyntheticMedia: 'Synthetic-media disclosure',
  coverImageUrl: 'Cover image',
  thumbnailUrl: 'Thumbnail',
};

/** One override layer. Absent field means inherit; see the note on empty values above. */
export interface PublishContentVariant {
  caption?: string;
  /** A selection from the post's own media, in the order this platform should receive it. */
  mediaUrls?: string[];
  /** The shape this platform submits as, overriding the one the post's format implies. */
  postKind?: PublishPostKind;
  title?: string;
  firstComment?: string;
  discloseSyntheticMedia?: boolean;
  coverImageUrl?: string;
  thumbnailUrl?: string;
}

/**
 * A stored layer, and which layer it is.
 *
 * `accountId: null` is the platform layer and a provider account id is the account layer, so both
 * are one shape and the resolution reads one list. A record is keyed by provider platform rather
 * than by Signal channel: two channels never share a platform, and an override belongs to what the
 * provider will accept it for.
 */
export interface PublishVariantRecord extends PublishContentVariant {
  platform: PublishPlatform;
  accountId: number | null;
  /** When the layer was last written. Absent on a layer that has not been stored yet. */
  updatedAt?: string;
}

/** The content a post itself carries, before any layer touches it. */
export interface PublishVariantBase {
  caption: string;
  mediaUrls: string[];
  postKind: PublishPostKind;
}

/** The two layers that may sit over a base, either or both absent. */
export interface PublishVariantLayers {
  platform?: PublishContentVariant;
  account?: PublishContentVariant;
}

/**
 * The effective content, and where each field came from.
 *
 * `sources` is total: a field no layer touched reads `BASE`, including a field that ends up absent
 * altogether. A partial record would make "nothing overrode the title" and "there is no title"
 * indistinguishable, and the preview shows one of those and not the other.
 */
export interface PublishResolvedContent {
  caption: string;
  mediaUrls: string[];
  postKind: PublishPostKind;
  title?: string;
  firstComment?: string;
  discloseSyntheticMedia: boolean;
  coverImageUrl?: string;
  thumbnailUrl?: string;
  sources: Record<PublishVariantField, PublishVariantScope>;
}

const trimmed = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
};

/**
 * A layer with its blank text fields dropped, so "cleared" and "never set" are the same thing.
 *
 * Applied at the HTTP boundary before a layer is stored and again before one is resolved, because
 * a database written by an older release is external input like any other.
 */
export function normalizePublishVariant(variant: PublishContentVariant): PublishContentVariant {
  const normalized: PublishContentVariant = {};
  const caption = trimmed(variant.caption);
  if (caption !== undefined) normalized.caption = caption;
  // Not trimmed away when empty: an empty selection is a deliberate "no media here".
  if (variant.mediaUrls !== undefined) normalized.mediaUrls = [...variant.mediaUrls];
  if (variant.postKind !== undefined) normalized.postKind = variant.postKind;
  const title = trimmed(variant.title);
  if (title !== undefined) normalized.title = title;
  const firstComment = trimmed(variant.firstComment);
  if (firstComment !== undefined) normalized.firstComment = firstComment;
  if (variant.discloseSyntheticMedia !== undefined)
    normalized.discloseSyntheticMedia = variant.discloseSyntheticMedia;
  const coverImageUrl = trimmed(variant.coverImageUrl);
  if (coverImageUrl !== undefined) normalized.coverImageUrl = coverImageUrl;
  const thumbnailUrl = trimmed(variant.thumbnailUrl);
  if (thumbnailUrl !== undefined) normalized.thumbnailUrl = thumbnailUrl;
  return normalized;
}

/**
 * Whether a normalized layer says anything at all.
 *
 * An empty layer is not stored: a row that overrides nothing is indistinguishable from no row, and
 * keeping it would make "this platform is tailored" true of a platform that is not.
 */
export const publishVariantIsEmpty = (variant: PublishContentVariant): boolean =>
  PUBLISH_VARIANT_FIELDS.every((field) => variant[field] === undefined);

/** The layers stored for one platform, and for one of its accounts when an id is given. */
export function publishVariantLayers(
  variants: readonly PublishVariantRecord[],
  platform: PublishPlatform,
  accountId?: number,
): PublishVariantLayers {
  const layers: PublishVariantLayers = {};
  const platformLayer = variants.find(
    (variant) => variant.platform === platform && variant.accountId === null,
  );
  if (platformLayer) layers.platform = normalizePublishVariant(platformLayer);
  if (accountId !== undefined) {
    const accountLayer = variants.find(
      (variant) => variant.platform === platform && variant.accountId === accountId,
    );
    if (accountLayer) layers.account = normalizePublishVariant(accountLayer);
  }
  return layers;
}

/** The nearest layer that answers for a field, and the value it answers with. */
function pick<Field extends PublishVariantField>(
  field: Field,
  base: PublishContentVariant[Field],
  layers: PublishVariantLayers,
): { value: PublishContentVariant[Field]; scope: PublishVariantScope } {
  const account = layers.account?.[field];
  if (account !== undefined) return { value: account, scope: 'ACCOUNT' };
  const platform = layers.platform?.[field];
  if (platform !== undefined) return { value: platform, scope: 'PLATFORM' };
  return { value: base, scope: 'BASE' };
}

/**
 * base -> platform -> account, for every field, in that order and no other.
 *
 * The account layer wins where it speaks and is silent everywhere else, which is what makes the
 * layers composable: an account can shorten a caption without restating the platform's title, and
 * a platform can pick media without the account losing its own caption.
 */
export function resolvePublishContent(
  base: PublishVariantBase,
  layers: PublishVariantLayers = {},
): PublishResolvedContent {
  const caption = pick('caption', base.caption, layers);
  const mediaUrls = pick('mediaUrls', base.mediaUrls, layers);
  const postKind = pick('postKind', base.postKind, layers);
  const title = pick('title', undefined, layers);
  const firstComment = pick('firstComment', undefined, layers);
  const disclose = pick('discloseSyntheticMedia', false, layers);
  const coverImageUrl = pick('coverImageUrl', undefined, layers);
  const thumbnailUrl = pick('thumbnailUrl', undefined, layers);
  return {
    caption: caption.value as string,
    mediaUrls: [...(mediaUrls.value as string[])],
    postKind: postKind.value as PublishPostKind,
    ...(title.value !== undefined ? { title: title.value } : {}),
    ...(firstComment.value !== undefined ? { firstComment: firstComment.value } : {}),
    discloseSyntheticMedia: disclose.value as boolean,
    ...(coverImageUrl.value !== undefined ? { coverImageUrl: coverImageUrl.value } : {}),
    ...(thumbnailUrl.value !== undefined ? { thumbnailUrl: thumbnailUrl.value } : {}),
    sources: {
      caption: caption.scope,
      mediaUrls: mediaUrls.scope,
      postKind: postKind.scope,
      title: title.scope,
      firstComment: firstComment.scope,
      discloseSyntheticMedia: disclose.scope,
      coverImageUrl: coverImageUrl.scope,
      thumbnailUrl: thumbnailUrl.scope,
    },
  };
}

/** The fields a layer actually overrode, in `PUBLISH_VARIANT_FIELDS` order. */
export const publishOverriddenFields = (content: PublishResolvedContent): PublishVariantField[] =>
  PUBLISH_VARIANT_FIELDS.filter((field) => content.sources[field] !== 'BASE');

/**
 * The sentence a disclosure becomes when no provider flag exists to carry it.
 *
 * Written into the caption because that is what `syntheticMediaDisclosure: 'IN_CAPTION'` means, and
 * it is `IN_CAPTION` on every platform the contract answers for. The preview shows the caption with
 * this already in it, and the caption limit is measured against that text rather than the one that
 * was typed — a disclosure that pushes X past 280 has to refuse before the send, not after.
 */
export const PUBLISH_SYNTHETIC_MEDIA_DISCLOSURE =
  'Contains AI-generated or synthetically altered content.';

/**
 * The caption a platform will actually receive.
 *
 * Identical to the resolved caption unless a disclosure was asked for and the platform has no field
 * to put one in, in which case the sentence is appended once — appending it twice to a caption that
 * already says so would be its own kind of wrong.
 */
export function publishEffectiveCaption(
  content: Pick<PublishResolvedContent, 'caption' | 'discloseSyntheticMedia'>,
  capability: PublishPlatformCapability,
): string {
  if (!content.discloseSyntheticMedia) return content.caption;
  if (capability.syntheticMediaDisclosure !== 'IN_CAPTION') return content.caption;
  if (content.caption.includes(PUBLISH_SYNTHETIC_MEDIA_DISCLOSURE)) return content.caption;
  return content.caption
    ? `${content.caption}\n\n${PUBLISH_SYNTHETIC_MEDIA_DISCLOSURE}`
    : PUBLISH_SYNTHETIC_MEDIA_DISCLOSURE;
}

/**
 * The shapes a platform can be told to submit as.
 *
 * Only the supported ones, so a placement control offers a story exactly where the provider has a
 * story to offer. A platform with one shape has no placement to choose, which is what
 * `publishVariantFieldSupported` reports for `postKind`.
 */
export const publishVariantPlacements = (
  capability: PublishPlatformCapability,
): PublishPostKind[] =>
  PUBLISH_POST_KINDS.filter((kind) => publishKindSupported(capability.kinds[kind]));

/**
 * Whether a platform accepts an override of this field at all.
 *
 * One function, read three times: the composer renders a control only where this is true, the HTTP
 * boundary refuses a value where it is false, and the preflight refuses a value already stored
 * against a platform the contract has since stopped answering yes for. A limit enforced on one
 * side only is a limit the user meets after pressing send.
 *
 * `mediaUrls` and `discloseSyntheticMedia` are true everywhere and that is not an oversight. A
 * media selection is a local choice about which of the post's own references to send, and a
 * disclosure always has somewhere to go — a provider field where one exists and the caption where
 * one does not. What neither of them is is unconditionally *deliverable*: the provider takes one
 * media array per submission, so targets that disagree refuse in `plan.ts`.
 */
export function publishVariantFieldSupported(
  field: PublishVariantField,
  capability: PublishPlatformCapability,
): boolean {
  switch (field) {
    case 'caption':
      return capability.platformContentOverride;
    case 'mediaUrls':
    case 'discloseSyntheticMedia':
      return true;
    case 'postKind':
      return publishVariantPlacements(capability).length > 1;
    case 'title':
      return capability.title.supported;
    case 'firstComment':
      return capability.firstComment.supported;
    case 'coverImageUrl':
      return capability.coverImage;
    case 'thumbnailUrl':
      return capability.thumbnail;
  }
}

/** Every field this platform can be tailored on, in one list for a form to walk. */
export const publishVariantFieldsFor = (
  capability: PublishPlatformCapability,
): PublishVariantField[] =>
  PUBLISH_VARIANT_FIELDS.filter((field) => publishVariantFieldSupported(field, capability));
