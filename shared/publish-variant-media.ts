import {
  SIGNAL_DRIVE_IMAGE_MAX_BYTES,
  signalMediaKindForMime,
  signalPostMediaIssue,
  type SignalPostMedia,
} from './signal-media.ts';
import { signalMediaKind } from './signal.ts';
import { formatFileSize } from './drive.ts';
import type { PublishPlatform, PublishPlatformCapability } from './publish-capabilities.ts';

/**
 * A media **role** on one variant layer: a cover image or a thumbnail, and the state of the
 * provider field that would carry it.
 *
 * Until C76 a cover and a thumbnail were URL strings on `signal_post_variants`, reaching no
 * provider field at all. A role is now the same discriminated reference post media has been since
 * C74 — a public `https:` URL or a version-bound Drive file — stored in
 * `signal_post_variant_media`, keyed by `(post_id, platform, account_id, role)`, and validated by
 * the same one function, `signalPostMediaIssue`. The legacy columns stay on the table and are
 * frozen: `backfillSignalVariantRoleMedia` moves each value into a `URL` role row exactly once and
 * nothing writes them again, so there is one writable source of truth rather than two.
 *
 * ## Storing a role is not delivering one
 *
 * These are two different questions and this module keeps them apart, the way
 * `shared/publish-variants.ts` already keeps a media *selection* apart from whether the provider
 * can carry two different ones:
 *
 * - **Composable** — the provider names a field for this role on this platform, so the composer
 *   offers it and the HTTP boundary stores it. `publishRoleComposable`.
 * - **Delivered** — the live probe has verified that the provider accepts the field and reads it
 *   back, so a request may carry it. `publishRoleDelivers`, which reads
 *   `PublishPlatformCapability.coverImage` / `.thumbnail` and nothing else.
 *
 * Today nothing is delivered. `docs/post-bridge-api-surface.md` §14, question 3, records both
 * roles as **still unverified** after the 20 August 2026 live session: no video asset was uploaded,
 * and each role needs a video as the post's own media. Current Post Bridge support material
 * separately says custom external YouTube thumbnails are not available, so the YouTube conflict is
 * unresolved rather than resolved positively — which C76 records as will-not-build, leaving
 * `thumbnail: false`. A role that is composable but not delivered warns everywhere it is set; it is
 * never silently dropped and never invented onto the wire from OpenAPI alone.
 */

export const PUBLISH_VARIANT_MEDIA_ROLES = ['COVER_IMAGE', 'THUMBNAIL'] as const;
export type PublishVariantMediaRole = (typeof PUBLISH_VARIANT_MEDIA_ROLES)[number];

/** What a role is called in a sentence. Lower case: it appears mid-sentence in every warning. */
export const PUBLISH_VARIANT_MEDIA_ROLE_LABEL: Record<PublishVariantMediaRole, string> = {
  COVER_IMAGE: 'cover image',
  THUMBNAIL: 'thumbnail',
};

/**
 * Three states, and no fourth.
 *
 * `ABSENT` is *the provider has no such field for this platform*, which is a different claim from
 * `UNVERIFIED` — *the provider names the field and the live probe has not established that it
 * works*. `VERIFIED` is the only state that may reach a request, and reaching it means a dated
 * result matrix in `docs/post-bridge-api-surface.md` §14 says so.
 */
export const PUBLISH_ROLE_STATES = ['ABSENT', 'UNVERIFIED', 'VERIFIED'] as const;
export type PublishRoleState = (typeof PUBLISH_ROLE_STATES)[number];

/**
 * Where the provider names a role field at all, and what the live evidence says about it.
 *
 * Read out of the API surface note rather than guessed: `cover_image` appears on Instagram's
 * platform configuration and `thumbnail` on YouTube's (§8), and §14 leaves both unverified. Every
 * other platform and role pair is `ABSENT` — the provider defines no such field, so there is
 * nothing to store and nothing to warn about beyond saying the platform picks its own.
 */
const ROLE_STATES: Partial<
  Record<PublishPlatform, Partial<Record<PublishVariantMediaRole, PublishRoleState>>>
> = {
  instagram: { COVER_IMAGE: 'UNVERIFIED' },
  youtube: { THUMBNAIL: 'UNVERIFIED' },
};

/** The state of one role on one platform. `ABSENT` for every pair the provider does not name. */
export const publishRoleState = (
  platform: PublishPlatform,
  role: PublishVariantMediaRole,
): PublishRoleState => ROLE_STATES[platform]?.[role] ?? 'ABSENT';

/**
 * Whether a role can be stored and composed for this platform.
 *
 * True where the provider names the field, verified or not, because a role a person can choose is
 * how a verified role arrives ready rather than half built — and false where it does not, so the
 * composer offers nothing and the boundary refuses a value a `curl` would otherwise leave stored
 * against a platform that has no room for it.
 */
export const publishRoleComposable = (
  platform: PublishPlatform,
  role: PublishVariantMediaRole,
): boolean => publishRoleState(platform, role) !== 'ABSENT';

/**
 * Whether a role may reach the provider request. The capability flag, and nothing else.
 *
 * `shared/publish-capabilities.ts` is the one table the whole app reads for what the provider
 * accepts, so the delivery question is answered there rather than here; what this module adds is
 * *why* a flag is false, which is what a warning has to say. `publish-variant-media.test.ts`
 * asserts the two agree: a flag is true only where the state is `VERIFIED`.
 */
export const publishRoleDelivers = (
  capability: PublishPlatformCapability,
  role: PublishVariantMediaRole,
): boolean => (role === 'COVER_IMAGE' ? capability.coverImage : capability.thumbnail);

/**
 * The sentence a stored-but-undelivered role becomes in the preview.
 *
 * It names the state rather than saying "unsupported", because the two reasons a role does not go
 * out are different facts and only one of them might change: a field the provider does not define,
 * and a field it defines that nobody has watched work.
 */
export function publishRoleWarning(
  capability: PublishPlatformCapability,
  role: PublishVariantMediaRole,
): string {
  const label = capability.label;
  const word = PUBLISH_VARIANT_MEDIA_ROLE_LABEL[role];
  if (publishRoleState(capability.platform, role) === 'UNVERIFIED')
    return `Post Bridge names a ${word} field for ${label}, but the live probe has not verified that it is accepted, so this ${word} is stored and not sent. It will go out once the role is verified.`;
  return `${label} takes no ${word} from this provider, so this one is stored and not sent.`;
}

/**
 * Whether a descriptor is usable as a role, beyond the cross-field rule every reference obeys.
 *
 * A cover and a thumbnail are single still images: a video or a PDF in the role would be refused by
 * the provider rather than resized by it, and the 8 MB image ceiling C73 recorded applies here for
 * the same reason it applies to post media — the refusal belongs before a byte is read. A Drive row
 * is classified from the MIME type Drive reported; a public URL is classified from its pathname,
 * which is all a URL can say, so an extensionless one is accepted rather than refused on a guess.
 */
export function publishRoleMediaIssue(
  media: SignalPostMedia,
  role: PublishVariantMediaRole,
): string | null {
  const issue = signalPostMediaIssue(media);
  if (issue) return issue;
  const word = PUBLISH_VARIANT_MEDIA_ROLE_LABEL[role];
  if (media.source === 'DRIVE') {
    if (signalMediaKindForMime(media.mimeType) !== 'image')
      return `A ${word} has to be an image, and ${media.driveName ?? 'that file'} is ${media.mimeType}.`;
    if ((media.sizeBytes ?? 0) > SIGNAL_DRIVE_IMAGE_MAX_BYTES)
      return `${media.driveName ?? 'That file'} is ${formatFileSize(media.sizeBytes)}; a ${word} may be up to ${formatFileSize(SIGNAL_DRIVE_IMAGE_MAX_BYTES)}.`;
    return null;
  }
  const kind = signalMediaKind(media.url);
  if (kind !== 'image' && kind !== 'unknown')
    return `A ${word} has to be an image, and that address is a ${kind}.`;
  return null;
}
