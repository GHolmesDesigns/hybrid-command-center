import type { SignalChannel } from './signal.ts';
import type {
  PublishDeliveryMode,
  PublishPlatform,
  PublishPostKind,
} from './publish-capabilities.ts';
import type { PublishResolvedContent } from './publish-variants.ts';

export const PUBLICATION_STATES = [
  'SUBMITTING',
  'SUBMITTED',
  'CONFIRMED',
  'PARTIAL',
  'FAILED',
  'UNCONFIRMED',
  'CANCELLED',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export interface PublishTargetPreview {
  channel: SignalChannel;
  platform: string;
  accountId: number;
  handle: string;
}

/**
 * What preflight concluded about one channel.
 *
 * `READY` is the only one that sends. The other two are different claims and are kept apart on
 * purpose: `NOT_AVAILABLE` is the contract answering "no provider reaches this" — `blog`, and
 * permanently — while `BLOCKED` is something the user can act on, or a channel the contract has no
 * answer for at all, which fails closed.
 */
export const PUBLISH_CHANNEL_STATUSES = ['READY', 'BLOCKED', 'NOT_AVAILABLE'] as const;
export type PublishChannelStatus = (typeof PUBLISH_CHANNEL_STATUSES)[number];

export const PUBLISH_CHANNEL_STATUS_LABEL: Record<PublishChannelStatus, string> = {
  READY: 'Ready to send',
  BLOCKED: 'Blocked',
  NOT_AVAILABLE: 'Not available from this provider',
};

/**
 * Preflight's verdict for one channel, and for the one account it resolved to.
 *
 * Per channel rather than one flat list, because "the caption is too long" is not true of a post —
 * it is true of X at 280 and untrue of LinkedIn at 3000, and a single list of reasons makes the
 * user work out which target each one belongs to. A blocked channel names its account when one
 * resolved, so a refusal points at the thing that must change.
 */
/**
 * What one target will actually receive, after base -> platform -> account resolved.
 *
 * `caption` is the **effective** caption: the resolved text plus any synthetic-media disclosure the
 * platform has no field to carry, which is the string the limit was measured against and the string
 * that will be sent. `sources` still names where the text itself came from, so a preview can say
 * both what goes out and which layer decided it.
 */
export interface PublishChannelContent extends PublishResolvedContent {
  /** Which route this shape takes on this platform. */
  deliveryMode: PublishDeliveryMode;
}

export interface PublishChannelReport {
  channel: SignalChannel;
  /** `null` where no provider platform exists for the channel. */
  platform: PublishPlatform | null;
  /** The shape this submission takes: the post's format, or the placement an override chose. */
  kind: PublishPostKind;
  status: PublishChannelStatus;
  /** The resolved provider account, present only once one was resolved. */
  accountId?: number;
  handle?: string;
  /**
   * The resolved content for this target. Absent only where no platform exists to resolve for —
   * `blog`, and a channel the capability contract does not answer — because there is nothing there
   * to tailor and an empty object would read as "tailored to nothing".
   */
  content?: PublishChannelContent;
  refusals: string[];
  warnings: string[];
}

export interface PublishPreview {
  available: boolean;
  postId: string;
  planHash: string;
  caption: string;
  scheduledInstant?: string;
  timezone?: string;
  targets: PublishTargetPreview[];
  /** One entry per channel on the post, in the post's channel order. */
  channels: PublishChannelReport[];
  /** Reasons that belong to the whole plan rather than to any one channel. */
  warnings: string[];
  /** Refusals that belong to the whole plan. A channel's own refusals live on its report. */
  refusals: string[];
}

/**
 * Every refusal in the plan, plan-level first and then per channel.
 *
 * The gate on sending is this function and not `preview.refusals`, so a channel-level refusal can
 * never be reported to the user and then quietly stepped over at commit.
 */
export const publishPreviewRefusals = (preview: PublishPreview): string[] => [
  ...preview.refusals,
  ...preview.channels.flatMap((report) => report.refusals),
];

/** Every warning in the plan, in the same order. */
export const publishPreviewWarnings = (preview: PublishPreview): string[] => [
  ...preview.warnings,
  ...preview.channels.flatMap((report) => report.warnings),
];

export interface SignalPublication {
  id: string;
  postId: string;
  state: PublicationState;
  provider: string;
  providerPostId?: string;
  scheduledInstant: string;
  timezone: string;
  sentCaption: string;
  sentChannels: SignalChannel[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
