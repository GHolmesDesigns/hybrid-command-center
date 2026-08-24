import type { Db } from '../db.ts';
import { preflightPlatform } from '../publish/plan.ts';
import type { PublishTarget } from '../publish/provider.ts';
import {
  publishCapabilityFor,
  publishPlatformFor,
  publishPostKindFor,
  type PublishPlatform,
} from '../../shared/publish-capabilities.ts';
import { deliveryModeForCapability } from '../../shared/publish.ts';
import {
  publishEffectiveCaption,
  publishVariantLayers,
  resolvePublishContent,
  PUBLISH_VARIANT_MEDIA_FIELD,
  type PublishContentVariant,
  type PublishVariantRecord,
} from '../../shared/publish-variants.ts';
import {
  SIGNAL_CHANNEL_LABEL,
  type SignalChannel,
  type SignalFormat,
} from '../../shared/signal.ts';
import {
  emptySignalImportCapabilitySummary,
  type SignalImportCapabilitySummary,
  type SignalImportCapabilityVerdict,
} from '../../shared/signal-import.ts';
import type { SignalPostMedia } from '../../shared/signal-media.ts';
import { type PublishVariantMediaRole } from '../../shared/publish-variant-media.ts';

/**
 * Capability verdicts for a Signal import dry run.
 *
 * Uses the same contract the composer and publish preflight use (`preflightPlatform` and
 * `shared/publish-capabilities.ts`). Findings inform; they never refuse the import. Connected
 * accounts are read from the local table only — this module never calls a publishing provider.
 */

export interface ImportCapabilityPost {
  key: string;
  row: number;
  text: string;
  channels: string[];
  format: string;
  media: { url: string; media?: SignalPostMedia }[];
  variants: {
    platform: string;
    accountId: number | null;
    text: PublishContentVariant;
    roles: Partial<Record<PublishVariantMediaRole, SignalPostMedia>>;
  }[];
}

/** Every provider account already stored locally — the same identities a prior preview resolved. */
export function connectedPublishTargetsFromDb(db: Db): PublishTarget[] {
  const rows = db
    .prepare(
      `SELECT id,provider,provider_account_ref,platform,display_name,handle
         FROM signal_provider_accounts
        ORDER BY id`,
    )
    .all() as {
    id: number;
    provider: string;
    provider_account_ref: string;
    platform: string;
    display_name: string;
    handle: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    accountRef: row.provider_account_ref,
    platform: row.platform,
    handle: row.handle,
    name: row.display_name,
  }));
}

/**
 * Account resolution for import preflight, mirroring `resolveTarget` in `server/publish/plan.ts`
 * without contacting a provider. Facebook still requires the G.Holmes Designs page when that rule
 * is what publish uses.
 */
function accountConnectivityMessage(
  platform: string,
  label: string,
  connected: readonly PublishTarget[],
): string | undefined {
  const candidates = connected.filter((target) => target.platform === platform);
  let resolved =
    platform === 'facebook'
      ? candidates.filter(
          (target) =>
            target.name === 'G.Holmes Designs' ||
            target.handle.toLowerCase().replace(/[^a-z0-9]/g, '') === 'gholmesdesigns',
        )
      : [...candidates];
  const postBridgeOnly = resolved.filter(
    (target) => (target.provider ?? 'post-bridge') === 'post-bridge',
  );
  if (postBridgeOnly.length) resolved = postBridgeOnly;
  if (resolved.length === 1) {
    const target = resolved[0]!;
    if (target.unavailable)
      return `${label} is connected to ${target.name || target.handle}, which is ${target.unavailable.toLowerCase()}.`;
    return undefined;
  }
  if (resolved.length === 0)
    return `${label} has no connected account${platform === 'facebook' ? ' for G.Holmes Designs' : ''}. Connect one in Post Bridge.`;
  return `${label} resolved to ${resolved.length} connected accounts${platform === 'facebook' ? ' for G.Holmes Designs' : ''} and this app sends to exactly one. Disconnect the ones this campaign must not reach.`;
}

function variantRecords(post: ImportCapabilityPost): PublishVariantRecord[] {
  return post.variants.map((variant) => {
    const record: PublishVariantRecord = {
      platform: variant.platform as PublishPlatform,
      accountId: variant.accountId,
      ...variant.text,
    };
    for (const role of Object.keys(variant.roles) as PublishVariantMediaRole[]) {
      const media = variant.roles[role];
      if (media) record[PUBLISH_VARIANT_MEDIA_FIELD[role]] = media;
    }
    return record;
  });
}

function verdictsForChannel(
  post: ImportCapabilityPost,
  channel: string,
  connected: readonly PublishTarget[],
  media: readonly SignalPostMedia[],
  mediaUrls: string[],
  variants: readonly PublishVariantRecord[],
  postKind: ReturnType<typeof publishPostKindFor>,
): SignalImportCapabilityVerdict[] {
  const found: SignalImportCapabilityVerdict[] = [];
  const push = (
    durability: SignalImportCapabilityVerdict['durability'],
    message: string,
    publishWouldRefuse: boolean,
  ) => {
    found.push({
      postKey: post.key,
      row: post.row,
      channel,
      durability,
      message,
      publishWouldRefuse,
    });
  };

  const channelLabel = SIGNAL_CHANNEL_LABEL[channel as SignalChannel] ?? channel;
  const platform = publishPlatformFor(channel);
  if (platform === null) {
    push(
      'DURABLE',
      `${channelLabel} is not available from this provider. Publish it yourself and mark the post published.`,
      false,
    );
    return found;
  }
  const capability = platform === undefined ? undefined : publishCapabilityFor(platform);
  if (!capability) {
    push(
      'DURABLE',
      `${channelLabel} is not answered by the provider capability contract, so nothing can be sent to it. Record it in shared/publish-capabilities.ts before publishing to it.`,
      true,
    );
    return found;
  }

  const layers = publishVariantLayers(variants, capability.platform, undefined);
  const resolved = resolvePublishContent(
    { caption: post.text.trim(), mediaUrls, postKind },
    layers,
  );
  const content = {
    ...resolved,
    caption: publishEffectiveCaption(resolved, capability),
    deliveryMode: deliveryModeForCapability(capability, resolved.postKind),
  };
  const preflight = preflightPlatform({ capability, content, media });
  for (const message of preflight.refusals) push('DURABLE', message, true);
  for (const message of preflight.warnings) push('DURABLE', message, false);

  const connectivity = accountConnectivityMessage(capability.platform, capability.label, connected);
  if (connectivity) push('MOMENTARY', connectivity, true);

  return found;
}

/** Run the capability contract over every planned post. Never refuses; never contacts a provider. */
export function evaluateImportCapabilities(
  posts: readonly ImportCapabilityPost[],
  connected: readonly PublishTarget[],
): {
  summary: SignalImportCapabilitySummary;
  verdicts: SignalImportCapabilityVerdict[];
} {
  const verdicts: SignalImportCapabilityVerdict[] = [];
  let postsWithWarnings = 0;
  for (const post of posts) {
    if (post.channels.length === 0) continue;
    const media = post.media.flatMap((item) => (item.media ? [item.media] : []));
    const mediaUrls = post.media.map((item) => item.media?.url ?? item.url);
    const variants = variantRecords(post);
    const postKind = publishPostKindFor(post.format as SignalFormat);
    const before = verdicts.length;
    for (const channel of post.channels) {
      verdicts.push(
        ...verdictsForChannel(post, channel, connected, media, mediaUrls, variants, postKind),
      );
    }
    if (verdicts.length > before) postsWithWarnings += 1;
  }
  const postsEvaluated = posts.filter((post) => post.channels.length > 0).length;
  const summary: SignalImportCapabilitySummary = {
    postsEvaluated,
    postsClean: postsEvaluated - postsWithWarnings,
    postsWithWarnings,
    durableCount: verdicts.filter((v) => v.durability === 'DURABLE').length,
    momentaryCount: verdicts.filter((v) => v.durability === 'MOMENTARY').length,
  };
  return { summary, verdicts };
}

export { emptySignalImportCapabilitySummary };
