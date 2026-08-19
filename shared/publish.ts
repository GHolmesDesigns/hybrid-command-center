import type { SignalChannel } from './signal.ts';
import {
  publishCapabilityFor,
  publishKindSupported,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
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
  /** The route this delivery will take, decided before anything is sent. */
  mode: DeliveryMode;
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
  /**
   * Which route this shape takes on this platform — the same `DeliveryMode` the report and the
   * publication targets carry, so the tailoring panel and the delivery rows can never name the
   * route two different ways for one channel.
   */
  deliveryMode: DeliveryMode;
}

export interface PublishChannelReport {
  channel: SignalChannel;
  /** `null` where no provider platform exists for the channel. */
  platform: PublishPlatform | null;
  /** The shape this submission takes: the post's format, or the placement an override chose. */
  kind: PublishPostKind;
  /**
   * The delivery route this channel would take. Present on every report, blocked ones included,
   * so the preview can say *manual finish required* before a person commits to sending rather
   * than only afterwards.
   */
  mode: DeliveryMode;
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
  /** One row per provider account, in the order the plan resolved them. */
  targets: SignalPublicationTarget[];
  /** The last check of either kind, which is what "last checked" means on the planner. */
  checkedAt?: string;
  /** Automatic checks only. A manual refresh never spends one — see `reconcileSchedule`. */
  checkAttempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * ## Delivery, which is not planning status
 *
 * `SignalStatus` is the user's claim about their own plan and keeps meaning what it means
 * (`docs/publishing-integration.md` §6). Everything below is the other fact — what this app and a
 * provider actually did — and it is deliberately two axes rather than one word, because they vary
 * independently:
 *
 * - **Mode** is the route a delivery takes: whether it completes on its own, stops at a draft,
 *   needs a person to finish it somewhere else, or has no route at all. It is decided before
 *   anything is sent, from the capability contract, and it does not change afterwards.
 * - **State** is how far the one submission got, and it is `PUBLICATION_STATES` unchanged — this
 *   card adds no value to that union. What it adds is which of those seven the UI groups together
 *   and what each is called in a sentence.
 *
 * Collapsing them would lose real cases: a manual-finish target the provider accepted is
 * `SUBMITTED` and still not out, while an automatic target that is `SUBMITTED` needs nothing from
 * anybody. One word cannot say both.
 */
export const DELIVERY_MODES = [
  'AUTOMATIC',
  'PROVIDER_DRAFT',
  'MANUAL_FINISH',
  'UNSUPPORTED',
] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  AUTOMATIC: 'Automatic publishing',
  PROVIDER_DRAFT: 'Provider draft',
  MANUAL_FINISH: 'Manual finish required',
  UNSUPPORTED: 'Unsupported',
};

/** The two modes that stop short of the reader until a person does something. */
export const deliveryModeNeedsPerson = (mode: DeliveryMode): boolean =>
  mode === 'PROVIDER_DRAFT' || mode === 'MANUAL_FINISH';

/**
 * What a person still has to do, named where they have to do it.
 *
 * A mode that needs a person is useless as a label alone — "manual finish required" does not say
 * which application to open or what is waiting in it — so every mode carries its sentence and the
 * planner shows it beside the delivery rather than hiding it in a tooltip.
 */
export function deliveryModeInstruction(mode: DeliveryMode, platformLabel: string): string {
  switch (mode) {
    case 'AUTOMATIC':
      return `The provider publishes this to ${platformLabel} on its own. Nothing is left for you to do.`;
    case 'PROVIDER_DRAFT':
      return `The provider holds this as a draft. Open it in Post Bridge and submit it there — nothing reaches ${platformLabel} until you do.`;
    case 'MANUAL_FINISH':
      return `${platformLabel} finishes this in its own application. Open ${platformLabel} on that account, find the pending post, and publish it there — nothing goes out until you do.`;
    case 'UNSUPPORTED':
      return `No provider reaches ${platformLabel}, so nothing was sent. Publish it yourself, then set the planning status to Published.`;
  }
}

/**
 * The route one channel's delivery takes, decided from the capability contract alone.
 *
 * Derived rather than chosen: nothing in this app picks between two available routes today, so a
 * platform that can publish automatically does, and the other modes are what is left when it
 * cannot. `PROVIDER_DRAFT` sits above `MANUAL_FINISH` because a draft the provider holds is one
 * application to open rather than two. Per-target provider options, which would make this a
 * choice, are C62 (#189) and are deliberately not read here.
 *
 * Anything the contract has no answer for is `UNSUPPORTED`, which is the same fail-closed rule
 * preflight uses: an unknown platform is not quietly treated as an automatic one.
 */
export function deliveryModeForCapability(
  capability: PublishPlatformCapability | undefined,
  kind: PublishPostKind,
): DeliveryMode {
  if (!capability) return 'UNSUPPORTED';
  const support = capability.kinds[kind];
  if (!publishKindSupported(support)) return 'UNSUPPORTED';
  if (support.automatic) return 'AUTOMATIC';
  if (capability.providerDraft) return 'PROVIDER_DRAFT';
  return 'MANUAL_FINISH';
}

/**
 * The same answer for a platform key, resolving the capability first.
 *
 * Split from `deliveryModeForCapability` for the reason `preflightPlatform` takes a capability: the
 * rules have to be exercisable against contract entries no connected platform has today, and a
 * function that only ever reads the shipped table cannot be.
 */
export const deliveryModeFor = (
  platform: PublishPlatform | null | undefined,
  kind: PublishPostKind,
): DeliveryMode =>
  deliveryModeForCapability(platform ? publishCapabilityFor(platform) : undefined, kind);

/**
 * How the seven states are grouped for a reader.
 *
 * The grouping is the whole of what this adds: `PARTIAL`, `FAILED`, and `UNCONFIRMED` are three
 * different facts that call for the same response — someone looks — while `SUBMITTING` and
 * `SUBMITTED` call for nothing but time. A group never replaces its state; both are shown, so
 * "needs attention" can be acted on and "partly delivered" can still be read.
 */
export const DELIVERY_GROUPS = ['IN_FLIGHT', 'DELIVERED', 'ATTENTION', 'STOPPED'] as const;
export type DeliveryGroup = (typeof DELIVERY_GROUPS)[number];

export const DELIVERY_GROUP_LABEL: Record<DeliveryGroup, string> = {
  IN_FLIGHT: 'In progress',
  DELIVERED: 'Delivered',
  ATTENTION: 'Needs attention',
  STOPPED: 'Stopped',
};

export const PUBLICATION_STATE_GROUP: Record<PublicationState, DeliveryGroup> = {
  SUBMITTING: 'IN_FLIGHT',
  SUBMITTED: 'IN_FLIGHT',
  CONFIRMED: 'DELIVERED',
  PARTIAL: 'ATTENTION',
  FAILED: 'ATTENTION',
  UNCONFIRMED: 'ATTENTION',
  CANCELLED: 'STOPPED',
};

/** What each state is called in a sentence shown to a person. Never the stored word. */
export const PUBLICATION_STATE_LABEL: Record<PublicationState, string> = {
  SUBMITTING: 'Sending',
  SUBMITTED: 'Accepted, not out yet',
  CONFIRMED: 'Delivered',
  PARTIAL: 'Partly delivered',
  FAILED: 'Not delivered',
  UNCONFIRMED: 'Unconfirmed',
  CANCELLED: 'Cancelled',
};

export const PUBLICATION_STATE_DESCRIPTION: Record<PublicationState, string> = {
  SUBMITTING: 'The request is with the provider and has not been answered.',
  SUBMITTED: 'The provider accepted it and holds it for its scheduled instant.',
  CONFIRMED: 'Every target reported success.',
  PARTIAL: 'Some targets succeeded and some failed. The rows below say which.',
  FAILED: 'Nothing went out.',
  UNCONFIRMED:
    'The provider never gave an answer this app could trust. Check Post Bridge yourself before resending — a blind retry is how a post goes out twice.',
  CANCELLED: 'Withdrawn before it went out.',
};

/**
 * ## Bounded reconciliation
 *
 * Neither provider offers a webhook, so polling is the only mechanism there is and it should be as
 * quiet as that allows (`docs/publishing-integration.md` §9). The first check waits for the
 * publishing instant to pass — asking before then can only be told what is already known — and
 * each one after it waits longer than the last. The budget is finite: when it runs out the
 * publication gives up into `UNCONFIRMED` rather than polling for ever, because "asked six times,
 * still do not know" is a fact to hand a person, not one to keep re-checking.
 *
 * Manual refresh sits outside this budget entirely. It always runs and it never spends an attempt,
 * so asking by hand can never exhaust the automatic schedule on the publication's behalf.
 */
export const RECONCILE_INTERVALS_MINUTES = [2, 5, 15, 45, 120] as const;

/** The check at the publishing instant, plus one for each widening interval after it. */
export const RECONCILE_MAX_ATTEMPTS = RECONCILE_INTERVALS_MINUTES.length + 1;

/** The states a provider can still be asked about. The other four are answers already. */
export const isReconcilableState = (state: PublicationState): boolean =>
  state === 'SUBMITTING' || state === 'SUBMITTED';

export interface ReconcileSchedule {
  /** When the next automatic check may run. Absent when there will not be one. */
  dueAt?: string;
  /** Whether that moment has arrived. */
  due: boolean;
  /** The automatic budget is spent; only a manual refresh is left. */
  exhausted: boolean;
}

const minutesAfter = (instant: string, minutes: number) =>
  new Date(Date.parse(instant) + minutes * 60_000).toISOString();

/**
 * When this publication may next be checked automatically, from what it already carries.
 *
 * Pure and shared, so the planner's timer and the server's gate answer from one rule. The server
 * refuses an automatic check that is not due, which is what stops a loose client from turning a
 * widening schedule back into a spin.
 */
export function reconcileSchedule(
  publication: Pick<
    SignalPublication,
    'state' | 'providerPostId' | 'scheduledInstant' | 'checkedAt' | 'checkAttempts'
  >,
  now: Date,
): ReconcileSchedule {
  if (!isReconcilableState(publication.state) || !publication.providerPostId)
    return { due: false, exhausted: false };
  if (publication.checkAttempts >= RECONCILE_MAX_ATTEMPTS) return { due: false, exhausted: true };
  const gap = RECONCILE_INTERVALS_MINUTES[
    Math.min(publication.checkAttempts - 1, RECONCILE_INTERVALS_MINUTES.length - 1)
  ] as number;
  const dueAt =
    publication.checkAttempts === 0 || !publication.checkedAt
      ? publication.scheduledInstant
      : minutesAfter(publication.checkedAt, gap);
  return { dueAt, due: Date.parse(dueAt) <= now.getTime(), exhausted: false };
}

/**
 * One provider account this publication went to, and what became of it.
 *
 * Per target rather than per publication because Post Bridge answers per account: two of four
 * succeeding is the case `PARTIAL` exists to preserve, and it survives only if each row keeps its
 * own outcome, its own permalink, and its own error.
 */
export interface SignalPublicationTarget {
  channel: SignalChannel;
  platform: PublishPlatform | null;
  accountId: number;
  /** The handle as it was at submit time, snapshotted like the caption and the channel set. */
  handle: string;
  mode: DeliveryMode;
  outcome?: 'SUCCESS' | 'FAILURE';
  permalink?: string;
  error?: string;
  /** When a person recorded that they finished this delivery where it had to be finished. */
  manualCompletedAt?: string;
}

/**
 * What one target's delivery says, which is not always what its publication says.
 *
 * A publication reports the submission; a target reports one account. They part company in the two
 * cases that matter: a `PARTIAL` publication where this account was the half that succeeded, and a
 * manual-finish target the provider accepted — `SUBMITTED`, and still nowhere near a reader until
 * someone opens the application and finishes it.
 */
export function deliveryTargetSummary(
  publication: Pick<SignalPublication, 'state'>,
  target: SignalPublicationTarget,
): { label: string; group: DeliveryGroup } {
  if (target.outcome === 'FAILURE') return { label: 'Not delivered', group: 'ATTENTION' };
  if (target.manualCompletedAt) return { label: 'Finished by hand', group: 'DELIVERED' };
  if (deliveryModeNeedsPerson(target.mode) && target.outcome === 'SUCCESS')
    return { label: 'Waiting for you to finish', group: 'ATTENTION' };
  if (target.outcome === 'SUCCESS') return { label: 'Delivered', group: 'DELIVERED' };
  return {
    label: PUBLICATION_STATE_LABEL[publication.state],
    group: PUBLICATION_STATE_GROUP[publication.state],
  };
}

/** Whether a person may record this target as finished. Nothing else is theirs to finish. */
export const deliveryTargetAwaitsPerson = (target: SignalPublicationTarget): boolean =>
  deliveryModeNeedsPerson(target.mode) && !target.manualCompletedAt;
