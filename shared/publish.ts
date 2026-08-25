import type { SignalChannel } from './signal.ts';
import {
  publishCapabilityFor,
  publishKindSupported,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
} from './publish-capabilities.ts';
import type { PublishResolvedContent } from './publish-variants.ts';
import type { BufferSchedulingType } from './buffer-capabilities.ts';
import type { BufferWirePreview } from './buffer-media.ts';
import type { PublishTiming } from './publish-now.ts';
export type { PublishTiming } from './publish-now.ts';
export {
  PUBLISH_NOW_WARNINGS,
  PUBLISH_TIMING_LABEL,
  publishNowPlanRefusals,
} from './publish-now.ts';

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
  provider?: string;
  accountRef?: string;
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

/**
 * How many accounts one channel's explicit selection may name.
 *
 * A bound on input rather than a statement about the provider: nothing here knows how many pages a
 * person can connect, and the number exists so a malformed request cannot ask this app to plan an
 * unbounded number of targets. Raise it when a real account list needs more.
 */
export const PUBLISH_TARGET_SELECTION_MAX = 10;

/**
 * One provider account a person explicitly chose to publish a Signal channel to (C77).
 *
 * A **selection**, not a provider record. It carries the channel and the account id and nothing
 * the provider owns: a handle or a name stored beside them would be a second copy of something
 * Post Bridge can rename underneath this app, and every screen that shows an account reads the
 * provider's own list instead.
 *
 * **An empty set for a channel is not a choice to send nowhere.** It means no explicit selection
 * exists, and the channel resolves the way it always has — one account, refusing zero or several
 * (`docs/publishing-integration.md` §3.1). That is what keeps this additive: a post nobody has
 * touched plans and submits byte for byte as it did before the table existed.
 */
export interface PublishTargetSelection {
  channel: SignalChannel;
  providerAccountId: number;
}

/**
 * Every explicit selection a post carries, grouped the way the preview shows it.
 *
 * Ordered by channel and then by account id, so two reads of an unchanged post produce the same
 * list — the plan hash covers these ids, and an order that wandered would invalidate a
 * confirmation nobody had touched.
 */
export type PublishTargetSelections = readonly PublishTargetSelection[];

/**
 * One selected account's own verdict inside a channel (C77).
 *
 * Present only where a person made an explicit selection. A channel resolving the way §3.1 has
 * always resolved it — one account, refusing zero or several — carries no `targets` list at all,
 * which is what keeps an untouched post planning byte for byte as it did before this existed.
 *
 * Every account gets its own refusals and its own warnings, and they are never merged into a
 * platform-level sentence: two accounts can fail for two different reasons, and "Facebook is
 * blocked" cannot say which of them a person has to fix.
 */
export interface PublishChannelTargetReport {
  accountId: number;
  provider?: string;
  accountRef?: string;
  handle: string;
  /** This account's resolved content, absent only where the account itself did not resolve. */
  content?: PublishChannelContent;
  status: PublishChannelStatus;
  refusals: string[];
  warnings: string[];
  bufferWire?: BufferWirePreview;
  bufferSchedulingType?: BufferSchedulingType;
  /** Whether this account has Drive-sourced media the Drive override would affect. */
  driveOverridable?: boolean;
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
  provider?: string;
  accountRef?: string;
  handle?: string;
  /**
   * The resolved content for this target. Absent only where no platform exists to resolve for —
   * `blog`, and a channel the capability contract does not answer — because there is nothing there
   * to tailor and an empty object would read as "tailored to nothing".
   */
  content?: PublishChannelContent;
  /**
   * Every explicitly selected account, in the order the selection is stored.
   *
   * **Absent, not empty, when nobody selected anything.** That distinction is the additive
   * guarantee: a post with no selection serializes exactly the report it always did, and the
   * channel-level `accountId`, `handle`, and `content` above remain the whole answer. Where the
   * list is present it names every account, and the channel-level fields describe the first of
   * them so that a reader which predates this list still sees something true.
   */
  targets?: PublishChannelTargetReport[];
  refusals: string[];
  warnings: string[];
  bufferWire?: BufferWirePreview;
  bufferSchedulingType?: BufferSchedulingType;
  /** Whether this channel's resolved account has Drive-sourced media the Drive override would affect. */
  driveOverridable?: boolean;
}

export interface PublishPreview {
  available: boolean;
  postId: string;
  planHash: string;
  caption: string;
  /** `scheduled` sends an explicit instant; `now` posts immediately with no scheduled instant. */
  timing?: PublishTiming;
  scheduledInstant?: string;
  timezone?: string;
  targets: PublishTargetPreview[];
  /** One entry per channel on the post, in the post's channel order. */
  channels: PublishChannelReport[];
  /**
   * Every account the provider listed when this preview was built (C77).
   *
   * The composer offers exactly this list, and `PUT /api/signal/posts/:id/publish-targets`
   * validates against exactly this list, so a person can never tick something the save will refuse.
   * Absent where the provider could not be read at all, which is different from an empty list.
   */
  connectedAccounts?: {
    id: number;
    provider?: string;
    accountRef?: string;
    platform: string;
    handle: string;
    name: string;
    /** Named when the provider lists the account but it cannot be used right now. */
    unavailable?: string;
  }[];
  /** The explicit selection this preview planned with, so the composer can show what is ticked. */
  selectedTargets?: PublishTargetSelection[];
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
  scheduledInstant: string | null;
  timezone: string;
  sentCaption: string;
  sentChannels: SignalChannel[];
  /**
   * The media that went out, snapshotted beside the caption and for the same reason: a provider
   * comparison has to weigh what the provider was handed, not what the post happens to hold now.
   *
   * Absent — not empty — on a publication written before it was recorded. An empty array is a
   * submission that deliberately carried no media; absent means nobody knows, and the comparison
   * refuses to turn that into a difference or into an agreement.
   */
  sentMedia?: string[];
  /** Versioned source descriptors for publications written after Drive uploads landed. */
  sentMediaSources?: {
    version: 1;
    items: import('./signal-media.ts').SignalPostMedia[];
  };
  /** Exact ephemeral provider ids used for this attempt, absent on URL-only and legacy rows. */
  sentProviderMediaIds?: string[];
  /**
   * What each account was handed, versioned separately from `sentConfigurations` (C77).
   *
   * **Absent is unknown.** A publication written before this existed, and one that tailored no
   * account at all, both arrive with nothing here — and they are different facts. Reconciliation
   * treats the absence as "cannot say" and reports no account-content drift, rather than reading it
   * as "nothing was tailored" and telling the user their plan has diverged from a record that never
   * described accounts in the first place.
   */
  sentAccountConfigurations?: {
    version: 1;
    items: { accountId: number; caption?: string; mediaIds?: string[] }[];
  };
  error?: string;
  /** One row per provider account, in the order the plan resolved them. */
  targets: SignalPublicationTarget[];
  /**
   * Which of Signal's fields have moved since this went out, derived rather than stored.
   *
   * Computed from local rows alone — the snapshot above against the post as it stands — so an edit
   * raises **Provider update required** without anything being asked of, or done to, the provider.
   * `accounts` is deliberately never reported here: resolving the account set needs the provider's
   * own target list, so it belongs to the reconciliation preview, which is allowed to read.
   * Absent on a publication the provider is no longer holding.
   */
  driftFields?: ProviderDiffField[];
  /** The last check of either kind, which is what "last checked" means on the planner. */
  checkedAt?: string;
  /**
   * What the most recent provider check concluded, and what this publication held before it.
   *
   * Two fields rather than one "it changed" flag, because a reader wants the move and not the fact
   * of a move: *accepted, then not delivered* is a different sentence from *accepted, then
   * delivered*. They are written by a check and by nothing else, which is what makes `checkedState`
   * a usable guard — anything the user does afterwards moves `state` away from it, and a rule
   * comparing the two stops reporting a change that has already been answered.
   *
   * Both are absent until the provider has been asked once, and `priorState` stays absent when a
   * check found nothing new.
   */
  checkedState?: PublicationState;
  priorState?: PublicationState;
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
      ? (publication.scheduledInstant ?? undefined)
      : minutesAfter(publication.checkedAt, gap);
  const due =
    publication.scheduledInstant === null && publication.checkAttempts === 0
      ? true
      : dueAt
        ? Date.parse(dueAt) <= now.getTime()
        : false;
  return { dueAt, due, exhausted: false };
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
  /** Provider-qualified identity as it stood when this target was resolved. */
  provider?: string;
  accountRef?: string;
  /** The handle as it was at submit time, snapshotted like the caption and the channel set. */
  handle: string;
  mode: DeliveryMode;
  outcome?: 'SUCCESS' | 'FAILURE';
  /**
   * The provider's own identity for this delivery — its `post-results` row id.
   *
   * Captured by reconciliation, because that is the only call that reads `post-results` at all, and
   * kept here rather than derived because it is the only handle the analytics endpoints accept: a
   * post id and an account id together will not answer a question about figures
   * (`shared/publish-analytics.ts`). Absent until the provider has been asked what became of this
   * submission, which is a state the figures panel reports by name rather than as a zero.
   */
  resultId?: string;
  /** Provider post identity for this one target. Buffer has one of these per channel. */
  remotePostId?: string;
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
  if (target.outcome === 'SUCCESS' && publication.state === 'SUBMITTED')
    return {
      label: PUBLICATION_STATE_LABEL.SUBMITTED,
      group: PUBLICATION_STATE_GROUP.SUBMITTED,
    };
  if (target.outcome === 'SUCCESS') return { label: 'Delivered', group: 'DELIVERED' };
  return {
    label: PUBLICATION_STATE_LABEL[publication.state],
    group: PUBLICATION_STATE_GROUP[publication.state],
  };
}

/** Whether a person may record this target as finished. Nothing else is theirs to finish. */
export const deliveryTargetAwaitsPerson = (target: SignalPublicationTarget): boolean =>
  deliveryModeNeedsPerson(target.mode) && !target.manualCompletedAt;

/**
 * ## The provider record, and the four things that can be done to it
 *
 * Post Bridge has an update path: `PATCH /v1/posts/{id}` takes a caption, a `scheduled_at`, media,
 * social accounts, and `platform_configurations` (`docs/publishing-integration.md` §7.2). That is
 * what makes an *update* an action here rather than a cancel-and-resubmit, and it is why a
 * publication keeps its `provider_post_id` and its permalinks across one.
 *
 * The vendor's own status vocabulary is `posted | scheduled | processing | failed` beside an
 * `is_draft` flag, which is five facts in two fields. They are normalized to one union on the way
 * in, because every rule below turns on exactly one question — *is it already out?* — and a rule
 * that has to read two fields to answer it is a rule someone will one day read half of.
 */
export const PROVIDER_POST_STATES = [
  'DRAFT',
  'SCHEDULED',
  'PROCESSING',
  'PUBLISHED',
  'FAILED',
] as const;
export type ProviderPostState = (typeof PROVIDER_POST_STATES)[number];

export const PROVIDER_POST_STATE_LABEL: Record<ProviderPostState, string> = {
  DRAFT: 'Held as a draft',
  SCHEDULED: 'Scheduled with the provider',
  PROCESSING: 'Going out now',
  PUBLISHED: 'Already published',
  FAILED: 'Failed at the provider',
};

/**
 * What the provider says it is holding, read and never inferred.
 *
 * This is the *remote* half of every comparison below. It is read fresh for each preview and never
 * stored: a cached copy of somebody else's record is the thing that makes a diff lie.
 */
export interface ProviderPostRecord {
  providerPostId: string;
  state: ProviderPostState;
  caption: string;
  /** Null is the provider's "post instantly", which this app never sends. */
  scheduledInstant: string | null;
  mediaUrls: string[];
  /** Uploaded-media identities where the provider still exposes them. */
  mediaIds?: string[];
  accountIds: number[];
  /**
   * What the provider says each account was given, where it reports it at all (C77).
   *
   * **Absent is "not reported", never "nothing".** §14's listed rows carry
   * `account_configurations: null` for posts that have none, and a provider that stops returning
   * the field would otherwise read as every account having been reset. Reconciliation says it
   * cannot compare rather than inventing a difference.
   */
  accountConfigurations?: { accountId: number; caption?: string }[];
  /** The provider's own last-modified stamp, where it gives one. Part of the staleness token. */
  updatedAt?: string;
}

/**
 * The two states in which the provider still owns a decision.
 *
 * `PROCESSING` is deliberately not one of them. The post is being sent as the question is asked, so
 * an update racing it would land on either side of the send and there is no way to know which —
 * exactly the ambiguity §8 exists to refuse rather than gamble on.
 */
export const providerRecordIsMutable = (state: ProviderPostState): boolean =>
  state === 'DRAFT' || state === 'SCHEDULED';

/** Whether the provider has already put this in front of readers. */
export const providerRecordIsPublished = (state: ProviderPostState): boolean =>
  state === 'PUBLISHED';

export const PROVIDER_ACTIONS = [
  'UPDATE_CONTENT',
  'UPDATE_SCHEDULE',
  'CANCEL',
  'RESTORE_AND_RESUBMIT',
] as const;
export type ProviderAction = (typeof PROVIDER_ACTIONS)[number];

export const PROVIDER_ACTION_LABEL: Record<ProviderAction, string> = {
  UPDATE_CONTENT: 'Update provider content',
  UPDATE_SCHEDULE: 'Update provider schedule',
  CANCEL: 'Cancel provider post',
  RESTORE_AND_RESUBMIT: 'Restore from Signal and resubmit',
};

export const PROVIDER_ACTION_DESCRIPTION: Record<ProviderAction, string> = {
  UPDATE_CONTENT:
    'Sends the caption, media, and per-platform tailoring Signal now holds, and leaves the provider on the instant it already has.',
  UPDATE_SCHEDULE:
    'Moves the provider to the date and time Signal now holds, and leaves the content it is already holding alone.',
  CANCEL: 'Withdraws the post from the provider. Signal keeps the plan; nothing is deleted here.',
  RESTORE_AND_RESUBMIT:
    'Withdraws what the provider holds and sends this post again from Signal as a new submission.',
};

/**
 * The fields a provider record and a Signal plan can disagree about.
 *
 * Four rather than one flat "changed" flag, because the two update actions split along them: a
 * caption edit and a reschedule are different requests carrying different risk, and someone who
 * moved a post by a day should not be offered a button that also rewrites its text.
 */
export const PROVIDER_DIFF_FIELDS = [
  'caption',
  'schedule',
  'media',
  'accounts',
  'accountContent',
] as const;
export type ProviderDiffField = (typeof PROVIDER_DIFF_FIELDS)[number];

export const PROVIDER_DIFF_FIELD_LABEL: Record<ProviderDiffField, string> = {
  caption: 'Caption',
  schedule: 'Scheduled for',
  media: 'Media',
  accounts: 'Accounts',
  accountContent: 'Per-account content',
};

/** Which action carries which field. `accounts` rides with content, as one `PATCH` body does. */
export const PROVIDER_DIFF_FIELD_ACTION: Record<ProviderDiffField, ProviderAction> = {
  caption: 'UPDATE_CONTENT',
  media: 'UPDATE_CONTENT',
  accounts: 'UPDATE_CONTENT',
  accountContent: 'UPDATE_CONTENT',
  schedule: 'UPDATE_SCHEDULE',
};

/** One field, said twice — what Signal holds and what the provider holds. */
export interface ProviderFieldDiff {
  field: ProviderDiffField;
  changed: boolean;
  /** False when the provider no longer exposes evidence that can be compared. */
  comparisonAvailable?: false;
  /** Signal's value, rendered for a reader. */
  local: string;
  /** The provider's value, rendered the same way so the two lines compare. */
  remote: string;
}

/**
 * Whether a Signal edit has left the provider holding something else.
 *
 * Answered from stored columns alone — the snapshot on the publication against the plan the post
 * would produce now — so the planner can say **Provider update required** the moment an edit is
 * saved, with no provider call and therefore no remote mutation. That is the acceptance criterion
 * this function is: an edit raises the flag and stops there.
 */
export function publicationDriftFields(
  publication: Pick<
    SignalPublication,
    'sentCaption' | 'sentMedia' | 'scheduledInstant' | 'targets'
  > &
    Partial<Pick<SignalPublication, 'sentAccountConfigurations'>>,
  plan: Pick<PublishPreview, 'caption' | 'scheduledInstant' | 'targets'> & {
    mediaUrls: readonly string[];
    accountConfigurations?: readonly { accountId: number; caption?: string; mediaIds?: string[] }[];
  },
): ProviderDiffField[] {
  const fields: ProviderDiffField[] = [];
  if (publication.sentCaption !== plan.caption) fields.push('caption');
  if (plan.scheduledInstant && publication.scheduledInstant !== plan.scheduledInstant)
    fields.push('schedule');
  // Only where the snapshot says what went out. An unrecorded one is not evidence of a difference,
  // and reporting one would send the user to reconcile something nobody can show them.
  if (
    publication.sentMedia &&
    JSON.stringify(publication.sentMedia) !== JSON.stringify([...plan.mediaUrls])
  )
    fields.push('media');
  const identity = (target: { accountId: number; provider?: string; accountRef?: string }) =>
    `${target.provider ?? 'post-bridge'}\u0000${target.accountRef ?? String(target.accountId)}`;
  const sent = publication.targets.map(identity).sort();
  const planned = plan.targets.map(identity).sort();
  if (JSON.stringify(sent) !== JSON.stringify(planned)) fields.push('accounts');
  // Only where the snapshot says what each account was handed. A migrated row carries nothing here
  // and **unknown is not a difference** — reporting one would send someone to reconcile against a
  // record that never described accounts. Compared sorted, because the provider promises no order
  // and an ordering difference is not something anybody should be asked to fix.
  if (publication.sentAccountConfigurations) {
    const key = (
      entries: readonly { accountId: number; caption?: string; mediaIds?: string[] }[],
    ) =>
      JSON.stringify(
        [...entries]
          .sort((a, b) => a.accountId - b.accountId)
          .map((entry) => [entry.accountId, entry.caption ?? null, entry.mediaIds ?? null]),
      );
    if (key(publication.sentAccountConfigurations.items) !== key(plan.accountConfigurations ?? []))
      fields.push('accountContent');
  }
  return fields;
}

/**
 * The states in which drift is worth reporting.
 *
 * A cancelled, confirmed, or failed publication is not "out of date with the provider" — there is
 * nothing at the provider left to be out of date with, or nothing that can still be changed. Only a
 * submission the provider is still holding can be.
 */
export const publicationTracksProvider = (state: PublicationState): boolean =>
  state === 'SUBMITTING' || state === 'SUBMITTED' || state === 'UNCONFIRMED';

/** One action, offered with the reasons it would be turned down already attached. */
export interface ProviderActionOffer {
  action: ProviderAction;
  /** True only when nothing refuses it and it would change something. */
  available: boolean;
  refusals: string[];
}

/**
 * A no-write comparison of one publication against the provider and against Signal.
 *
 * Every action is offered with its refusals attached, so the panel never shows a button whose press
 * would be turned down. `reconcileHash` covers both sides of the comparison — the plan and the
 * provider record — which is what lets the commit reject a preview taken before either of them
 * moved.
 */
export interface ProviderReconcilePreview {
  publicationId: string;
  postId: string;
  /** Absent when the provider could not be read; `refusals` then says why. */
  record?: ProviderPostRecord;
  /** Empty string when there is nothing safe to commit against. */
  reconcileHash: string;
  /** One entry per field, in `PROVIDER_DIFF_FIELDS` order, changed or not. */
  diffs: ProviderFieldDiff[];
  /** The fields that actually differ, in the same order. */
  changed: ProviderDiffField[];
  /** One entry per action, in `PROVIDER_ACTIONS` order. */
  actions: ProviderActionOffer[];
  warnings: string[];
  /** Reasons that stop every action, rather than one of them. */
  refusals: string[];
}

/** The offer for one action, or undefined when the preview carries none. */
export const providerActionOffer = (
  preview: ProviderReconcilePreview,
  action: ProviderAction,
): ProviderActionOffer | undefined => preview.actions.find((offer) => offer.action === action);
