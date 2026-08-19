import { publishPlatformFor, type PublishPlatform } from '../../../shared/publish-capabilities';
import type { PublishVariantRecord } from '../../../shared/publish-variants';
import type { SignalChannel, SignalPost } from '../../../shared/signal';

/**
 * The bookkeeping the variants form needs, beside the components that render it.
 *
 * Separate from `SignalVariants.tsx` because these are not components: a module mixing the two
 * defeats fast refresh, which is the same reason `ui-shared.ts` sits beside its views.
 */

/** The platforms a post's channels reach, in the post's channel order, without repeats. */
export function previewPlatforms(
  post: SignalPost,
): { channel: SignalChannel; platform: PublishPlatform }[] {
  const seen = new Set<PublishPlatform>();
  const rows: { channel: SignalChannel; platform: PublishPlatform }[] = [];
  for (const channel of post.channels) {
    const platform = publishPlatformFor(channel);
    if (!platform || seen.has(platform)) continue;
    seen.add(platform);
    rows.push({ channel, platform });
  }
  return rows;
}

/**
 * One layer's key in the form's map: the platform, and the account when the layer is an account's.
 *
 * A string key rather than a nested map, so the platform layer and every account layer live in one
 * flat structure and the whole set is one `PUT` — the shape the API replaces.
 */
export const variantKey = (platform: string, accountId: number | null) =>
  `${platform}:${accountId ?? 'platform'}`;

/** The stored layers as a map the form can address one layer at a time. */
export const variantMap = (variants: readonly PublishVariantRecord[]) =>
  new Map(variants.map((variant) => [variantKey(variant.platform, variant.accountId), variant]));

/** The map back as the array the API replaces the whole set with. */
export const variantList = (layers: Map<string, PublishVariantRecord>): PublishVariantRecord[] => [
  ...layers.values(),
];

/** How many fields a stored layer actually overrides, for a summary that says so. */
export const variantFieldCount = (variant: PublishVariantRecord | undefined): number =>
  variant
    ? Object.keys(variant).filter(
        (key) => key !== 'platform' && key !== 'accountId' && key !== 'updatedAt',
      ).length
    : 0;
