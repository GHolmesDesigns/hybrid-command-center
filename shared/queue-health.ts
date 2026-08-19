import {
  SIGNAL_CHANNEL_LABEL,
  signalPostName,
  signalSlotMinutesBetween,
  type SignalChannel,
  type SignalPost,
  type SignalSlot,
} from './signal.ts';
import {
  deliveryTargetAwaitsPerson,
  isReconcilableState,
  PUBLICATION_STATE_DESCRIPTION,
  PUBLICATION_STATE_LABEL,
  type PublicationState,
  type SignalPublication,
  type SignalPublicationTarget,
} from './publish.ts';

/**
 * Queue health: the alerts a Signal workspace derives about itself.
 *
 * ## Derived, never stored
 *
 * Every alert in here is a conclusion about rows that already exist — posts, publications, targets,
 * and the record of the last provider synchronisation. Nothing is written when an alert appears and
 * nothing is written when it goes away, which is what makes the summary safe to recompute on every
 * read and impossible to leave stale. There is no alerts table, and adding one would introduce the
 * two states a derived summary cannot have: an alert for a fact that has since changed, and a fact
 * with no alert because a write was missed.
 *
 * ## Acknowledgement does not change anything it reports
 *
 * The one thing a person can do to an alert is say *I have seen this*, and that is deliberately not
 * a change to the plan or to the delivery. An acknowledgement is `(id, fingerprint)` and lives in
 * its own table; the derivation reads it here and marks the alert. Because the fingerprint covers
 * the facts that made the alert, a situation that moves on produces a fingerprint the
 * acknowledgement no longer matches, and the alert comes back live rather than staying dismissed
 * for a problem that is now a different problem.
 *
 * ## Dates
 *
 * Every comparison against a post's slot is label arithmetic through
 * `signalSlotMinutesBetween` — no instant is derived from a post's date and time, which is the cell
 * rule in `shared/signal.ts`. Staleness of a *synchronisation* is instant arithmetic, because a
 * synchronisation happened at a moment and is stamped as one.
 *
 * Nothing here reads a clock, a database, or a network. `now` arrives as both an instant and a pair
 * of local labels, so a caller states the moment once and the rules cannot disagree about it.
 */

/** The one moment a summary is taken at, said both ways it has to be compared. */
export interface QueueHealthNow {
  /** UTC ISO, for the age of a synchronisation. */
  instant: string;
  /** The same moment as local calendar labels, for the distance to a post's slot. */
  slot: SignalSlot;
}

/**
 * What the summary is allowed to conclude about, and nothing beyond it.
 *
 * One kind per bullet of the card that asked for them, so a kind is a question rather than a
 * severity: *did a delivery go wrong*, *is a slot about to pass unfilled*, *is someone waiting on
 * me*, *did the provider tell us something new*, *is a channel empty*, *is our copy of the
 * provider's answers behind*.
 */
export const QUEUE_ALERT_KINDS = [
  'DELIVERY_ATTENTION',
  'MANUAL_FINISH_WAITING',
  'SLOT_APPROACHING',
  'PROVIDER_STATE_CHANGED',
  'CHANNEL_UNCOVERED',
  'SYNC_BEHIND',
] as const;
export type QueueAlertKind = (typeof QUEUE_ALERT_KINDS)[number];

export const QUEUE_ALERT_KIND_LABEL: Record<QueueAlertKind, string> = {
  DELIVERY_ATTENTION: 'Delivery',
  MANUAL_FINISH_WAITING: 'Waiting on you',
  SLOT_APPROACHING: 'Scheduled slot',
  PROVIDER_STATE_CHANGED: 'Provider answer',
  CHANNEL_UNCOVERED: 'Channel coverage',
  SYNC_BEHIND: 'Provider synchronisation',
};

/**
 * Two levels, not five.
 *
 * `ACTION` is something nobody else is going to do; `WATCH` is something to know about that may
 * resolve itself. A third middle level would be a judgement the rules cannot make from local rows,
 * and every extra level is one more colour a reader has to learn. The level is always shown as its
 * own words beside its own icon, never as a colour alone (`AGENTS.md`).
 */
export const QUEUE_ALERT_SEVERITIES = ['ACTION', 'WATCH'] as const;
export type QueueAlertSeverity = (typeof QUEUE_ALERT_SEVERITIES)[number];

export const QUEUE_ALERT_SEVERITY_LABEL: Record<QueueAlertSeverity, string> = {
  ACTION: 'Needs action',
  WATCH: 'Worth watching',
};

export const QUEUE_ALERT_KIND_SEVERITY: Record<QueueAlertKind, QueueAlertSeverity> = {
  DELIVERY_ATTENTION: 'ACTION',
  MANUAL_FINISH_WAITING: 'ACTION',
  SLOT_APPROACHING: 'ACTION',
  PROVIDER_STATE_CHANGED: 'WATCH',
  CHANNEL_UNCOVERED: 'WATCH',
  SYNC_BEHIND: 'WATCH',
};

/**
 * The windows the rules measure against.
 *
 * Configurable because the right numbers belong to a workspace rather than to this code: someone
 * posting twice a week wants a fortnight of coverage and someone posting daily wants three days,
 * and neither is a default the app can pick for them. Defaults are the conservative reading — a day
 * of warning before a slot, a fortnight of coverage, half a day before a synchronisation is behind.
 */
export interface QueueHealthConfig {
  /** How close a scheduled post may come to its slot before an unsent post is reported. */
  approachingHours: number;
  /** How far ahead a channel must have something planned. */
  coverageDays: number;
  /** How old the last provider synchronisation may be while an answer is still outstanding. */
  syncStaleHours: number;
  /**
   * The channels coverage is expected on. Empty means every channel the workspace has used, which
   * is the answer that needs no maintenance: a channel nobody posts to is not a gap.
   */
  coverageChannels: SignalChannel[];
}

export const DEFAULT_QUEUE_HEALTH_CONFIG: QueueHealthConfig = {
  approachingHours: 24,
  coverageDays: 14,
  syncStaleHours: 12,
  coverageChannels: [],
};

/**
 * The bounds each window is validated against, by the API and by the form, from one place.
 *
 * A floor of one is what stops a window of zero from making every alert fire or none of them; the
 * ceilings are the point past which a window stops being a window.
 */
export const QUEUE_HEALTH_LIMITS = {
  approachingHours: { min: 1, max: 336 },
  coverageDays: { min: 1, max: 180 },
  syncStaleHours: { min: 1, max: 336 },
} as const;

/**
 * How far back the summary looks for a plan that never went out.
 *
 * A scheduled post whose slot has passed with nothing submitted is worth reporting, and it stays
 * worth reporting for a while — but not for ever, because a plan a month stale is a plan nobody is
 * going to deliver and a list that never lets go of one stops being read. This bounds the posts a
 * caller needs to gather as well as the alerts derived from them.
 */
export const QUEUE_HEALTH_LOOKBACK_DAYS = 30;

/** One person's *I have seen this*, and the shape of the facts they saw. */
export interface QueueAlertAcknowledgement {
  alertId: string;
  fingerprint: string;
  acknowledgedAt: string;
}

/**
 * What the app knows about its last synchronisation with the provider.
 *
 * Deliberately about *a* synchronisation rather than about reconciliation specifically: the app
 * synchronises provider answers today and would synchronise analytics if it ever read any
 * (`docs/publishing-integration.md` §14 leaves that undecided), and both are the same question to a
 * reader — *is what we are showing current, and is the provider still talking to us*. Absent when
 * the app has never synchronised anything, which is not the same as a synchronisation being behind.
 */
export interface QueueSyncFacts {
  /** UTC ISO of the last successful synchronisation. */
  lastSyncedAt?: string;
  /** UTC ISO the provider's own rate limit runs until, while one is in force. */
  rateLimitedUntil?: string;
}

/**
 * Everything the rules read. A caller gathers it; the rules do not go looking.
 *
 * `posts` is the window a caller decided to look at — `QUEUE_HEALTH_LOOKBACK_DAYS` behind through
 * the coverage window ahead — and `usedChannels` is a separate fact because coverage asks about
 * channels the workspace uses rather than channels that happen to appear in one window.
 */
export interface QueueHealthFacts {
  posts: readonly SignalPost[];
  publications: readonly SignalPublication[];
  usedChannels: readonly SignalChannel[];
  sync?: QueueSyncFacts;
  acknowledgements: readonly QueueAlertAcknowledgement[];
}

export interface QueueHealthAlert {
  /**
   * Stable across recomputations for the same subject, so an acknowledgement has something to
   * attach to. `kind` plus the thing it is about, and nothing that moves.
   */
  id: string;
  kind: QueueAlertKind;
  severity: QueueAlertSeverity;
  /** What this is about, in words a reader can find on the planner. */
  subject: string;
  /** The fact, in one line. */
  title: string;
  /** What it means and what to do about it. */
  detail: string;
  /** The post this is about, when it is about one. */
  postId?: string;
  publicationId?: string;
  channel?: SignalChannel;
  /**
   * Where in the app this is resolved, as an in-app path. Post alerts open the post itself, which
   * is the acceptance criterion this field is; the two that are not about one post open the planner.
   */
  href: string;
  /**
   * The facts that make this alert what it is. An acknowledgement carries the fingerprint it was
   * given, so a changed situation is a new situation rather than a dismissed one.
   */
  fingerprint: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
}

export interface QueueHealthSummary {
  generatedAt: string;
  config: QueueHealthConfig;
  /** Live alerts first, then acknowledged ones, each group most severe first. */
  alerts: QueueHealthAlert[];
  counts: QueueHealthCounts;
}

export interface QueueHealthCounts {
  /** Live only. An acknowledged alert is counted once, under `acknowledged`. */
  action: number;
  watch: number;
  acknowledged: number;
}

/** The planner, and the planner with one post open on it. */
const PLANNER_PATH = '/signal';
const postHref = (postId: string) => `${PLANNER_PATH}?post=${encodeURIComponent(postId)}`;

/**
 * The states that mean this app has a submission with the provider.
 *
 * `CANCELLED` and `FAILED` are not among them, which is the point: a post whose only submission was
 * withdrawn or refused has nothing with the provider, and a slot approaching on one is exactly the
 * case the alert exists for. `UNCONFIRMED` is also excluded — *we do not know* is not *it is with
 * them* — and it raises its own alert, so a post never carries both silences at once.
 */
const isSubmittedState = (state: PublicationState): boolean =>
  state === 'SUBMITTING' || state === 'SUBMITTED' || state === 'CONFIRMED' || state === 'PARTIAL';

/** The three answers that call for someone to look — the `ATTENTION` group, stated as a rule. */
const needsAttention = (state: PublicationState): boolean =>
  state === 'FAILED' || state === 'PARTIAL' || state === 'UNCONFIRMED';

const hoursBetweenInstants = (from: string, to: string): number =>
  (Date.parse(to) - Date.parse(from)) / 3_600_000;

/** Rounded to whole hours, floored at one, so a sentence never says "in 0 hours". */
const hoursAway = (minutes: number): number => Math.max(1, Math.round(minutes / 60));

const whenSlotIsDue = (minutes: number, slot: SignalSlot): string =>
  minutes < 0
    ? `Its slot on ${slot.date} at ${slot.time} has already passed.`
    : `Its slot is ${slot.date} at ${slot.time}, about ${hoursAway(minutes)} ${hoursAway(minutes) === 1 ? 'hour' : 'hours'} away.`;

const channelName = (channel: SignalChannel) => SIGNAL_CHANNEL_LABEL[channel];

const targetName = (target: SignalPublicationTarget) =>
  target.handle || channelName(target.channel);

/**
 * The channels coverage is measured on.
 *
 * Configured set when there is one, and otherwise every channel the workspace has used. Sorted, so
 * two runs over the same workspace produce the same alerts in the same order.
 */
export function queueCoverageChannels(
  config: Pick<QueueHealthConfig, 'coverageChannels'>,
  usedChannels: readonly SignalChannel[],
): SignalChannel[] {
  const chosen = config.coverageChannels.length ? config.coverageChannels : usedChannels;
  return [...new Set(chosen)].sort();
}

/**
 * Whether one post counts as content planned for a channel inside the coverage window.
 *
 * A draft counts. The question the alert answers is *is there anything queued here*, and a dated
 * draft on the planner is something queued — treating only `SCHEDULED` posts as coverage would
 * report a full week as empty. A post already `PUBLISHED` does not count: it has gone out, so it is
 * not future content, whatever its date says.
 */
const coversWindow = (post: SignalPost, now: QueueHealthNow, days: number): boolean => {
  if (!post.date || post.status === 'PUBLISHED') return false;
  const minutes = signalSlotMinutesBetween(now.slot, { date: post.date, time: post.time });
  return minutes > 0 && minutes <= days * 1440;
};

interface Candidate {
  kind: QueueAlertKind;
  subject: string;
  title: string;
  detail: string;
  href: string;
  /** The part of the id after the kind. */
  key: string;
  fingerprint: string;
  postId?: string;
  publicationId?: string;
  channel?: SignalChannel;
}

const deliveryCandidates = (
  publication: SignalPublication,
  subject: string,
  href: string,
): Candidate[] => {
  const candidates: Candidate[] = [];
  if (needsAttention(publication.state)) {
    const failed = publication.targets.filter((target) => target.outcome === 'FAILURE');
    candidates.push({
      kind: 'DELIVERY_ATTENTION',
      subject,
      title: PUBLICATION_STATE_LABEL[publication.state],
      detail: failed.length
        ? `${PUBLICATION_STATE_DESCRIPTION[publication.state]} ${failed
            .map(targetName)
            .join(', ')} did not go out.`
        : PUBLICATION_STATE_DESCRIPTION[publication.state],
      href,
      key: publication.id,
      // The failed accounts ride along: two of four failing and then three of four failing is a
      // worse situation than the one that was acknowledged, so it asks again.
      fingerprint: `${publication.state}|${failed.map((target) => target.accountId).join(',')}`,
      postId: publication.postId,
      publicationId: publication.id,
    });
  }
  if (
    publication.priorState &&
    publication.checkedState &&
    publication.priorState !== publication.checkedState &&
    publication.state === publication.checkedState
  )
    candidates.push({
      kind: 'PROVIDER_STATE_CHANGED',
      subject,
      title: `${PUBLICATION_STATE_LABEL[publication.priorState]} → ${PUBLICATION_STATE_LABEL[publication.checkedState]}`,
      detail: `The last provider check moved this delivery. ${PUBLICATION_STATE_DESCRIPTION[publication.checkedState]}`,
      href,
      key: publication.id,
      fingerprint: `${publication.priorState}->${publication.checkedState}|${publication.checkedAt ?? ''}`,
      postId: publication.postId,
      publicationId: publication.id,
    });
  for (const target of publication.targets) {
    if (!deliveryTargetAwaitsPerson(target) || target.outcome !== 'SUCCESS') continue;
    candidates.push({
      kind: 'MANUAL_FINISH_WAITING',
      subject,
      title: `${targetName(target)} is waiting for you to finish it`,
      detail: `The provider accepted this delivery and cannot complete it. Finish it on ${channelName(
        target.channel,
      )} and record it here; nothing reaches a reader until you do.`,
      href,
      key: `${publication.id}:${target.accountId}`,
      fingerprint: `${publication.id}|${target.accountId}`,
      postId: publication.postId,
      publicationId: publication.id,
    });
  }
  return candidates;
};

/**
 * Whether our copy of the provider's answers is behind, and why.
 *
 * A rate limit is reported on its own account: the provider has told us to wait, so every answer we
 * are showing is as old as the limit is, whether or not anything is outstanding. Staleness is only
 * claimed while a submission is actually waiting on an answer, and only when there is a
 * synchronisation to call old — never having synchronised is not the same as being behind, and
 * saying so would put an alert on a workspace that has published nothing.
 */
const syncCandidate = (facts: QueueHealthFacts, config: QueueHealthConfig, now: QueueHealthNow) => {
  const sync = facts.sync;
  if (!sync) return undefined;
  const href = PLANNER_PATH;
  const subject = 'Provider synchronisation';
  if (sync.rateLimitedUntil && Date.parse(sync.rateLimitedUntil) > Date.parse(now.instant))
    return {
      kind: 'SYNC_BEHIND' as const,
      subject,
      title: 'The provider is rate-limiting us',
      detail: `The provider asked this app to wait until ${sync.rateLimitedUntil}. Delivery answers and any figures read from it are as old as that, and nothing is retried before then.`,
      href,
      key: 'provider',
      fingerprint: `RATE_LIMITED|${sync.rateLimitedUntil}`,
    };
  const awaiting = facts.publications.filter(
    (publication) => isReconcilableState(publication.state) && publication.providerPostId,
  );
  if (!awaiting.length || !sync.lastSyncedAt) return undefined;
  const age = hoursBetweenInstants(sync.lastSyncedAt, now.instant);
  if (age < config.syncStaleHours) return undefined;
  return {
    kind: 'SYNC_BEHIND' as const,
    subject,
    title: 'Delivery answers are out of date',
    detail: `${awaiting.length} ${awaiting.length === 1 ? 'submission is' : 'submissions are'} waiting on the provider and the last successful check was ${Math.floor(age)} hours ago. Open a post and refresh its delivery to ask again.`,
    href,
    key: 'provider',
    fingerprint: `STALE|${sync.lastSyncedAt}`,
  };
};

const KIND_ORDER = new Map(QUEUE_ALERT_KINDS.map((kind, index) => [kind, index]));
const SEVERITY_ORDER = new Map(QUEUE_ALERT_SEVERITIES.map((severity, index) => [severity, index]));

/**
 * Every alert this workspace's own rows support, in a fixed order.
 *
 * Pure: the same facts, config, and moment produce the same summary, which is what lets the rules be
 * tested against fixtures instead of against a rendered page. Nothing here writes, and nothing here
 * reads anything it was not handed.
 */
export function deriveQueueHealth(
  facts: QueueHealthFacts,
  config: QueueHealthConfig,
  now: QueueHealthNow,
): QueueHealthSummary {
  const posts = new Map(facts.posts.map((post) => [post.id, post]));
  const candidates: Candidate[] = [];

  for (const publication of facts.publications) {
    const post = posts.get(publication.postId);
    const subject = signalPostName(post?.text ?? publication.sentCaption);
    candidates.push(...deliveryCandidates(publication, subject, postHref(publication.postId)));
  }

  /** Posts with something at the provider, so an approaching slot knows what is already sent. */
  const submitted = new Set(
    facts.publications
      .filter((publication) => isSubmittedState(publication.state))
      .map((publication) => publication.postId),
  );
  for (const post of facts.posts) {
    if (!post.date || post.status !== 'SCHEDULED' || submitted.has(post.id)) continue;
    const slot: SignalSlot = { date: post.date, time: post.time };
    const minutes = signalSlotMinutesBetween(now.slot, slot);
    if (minutes > config.approachingHours * 60) continue;
    if (minutes < -QUEUE_HEALTH_LOOKBACK_DAYS * 1440) continue;
    candidates.push({
      kind: 'SLOT_APPROACHING',
      subject: signalPostName(post.text),
      title: minutes < 0 ? 'Its slot passed with nothing submitted' : 'Nothing submitted yet',
      detail: `${whenSlotIsDue(minutes, slot)} This post is marked Scheduled and no submission is with the provider. Publish it from the post, or set its status to match what you actually intend.`,
      href: postHref(post.id),
      key: post.id,
      // Whether the slot has gone is part of the fact. Acknowledging *this is coming up and
      // nothing is sent* is not acknowledging *it went by unsent*, so the alert asks again once
      // the moment passes.
      fingerprint: `${post.date}T${post.time}|${post.status}|${minutes < 0 ? 'PASSED' : 'SOON'}`,
      postId: post.id,
    });
  }

  for (const channel of queueCoverageChannels(config, facts.usedChannels)) {
    const covered = facts.posts.some(
      (post) => post.channels.includes(channel) && coversWindow(post, now, config.coverageDays),
    );
    if (covered) continue;
    candidates.push({
      kind: 'CHANNEL_UNCOVERED',
      subject: channelName(channel),
      title: `Nothing planned for the next ${config.coverageDays} ${config.coverageDays === 1 ? 'day' : 'days'}`,
      detail: `No post dated inside the window goes out on ${channelName(
        channel,
      )}. Schedule something, or drop the channel from the coverage list if it is not one you post to.`,
      href: PLANNER_PATH,
      key: channel,
      // The window is part of the fact: shortening it can only make a gap wider, so an
      // acknowledgement taken against a fortnight does not carry over to a month.
      fingerprint: `${config.coverageDays}`,
      channel,
    });
  }

  const sync = syncCandidate(facts, config, now);
  if (sync) candidates.push(sync);

  const acknowledged = new Map(
    facts.acknowledgements.map((record) => [record.alertId, record] as const),
  );
  const alerts = candidates.map((candidate): QueueHealthAlert => {
    const id = `${candidate.kind}:${candidate.key}`;
    const record = acknowledged.get(id);
    const matched = record?.fingerprint === candidate.fingerprint;
    return {
      id,
      kind: candidate.kind,
      severity: QUEUE_ALERT_KIND_SEVERITY[candidate.kind],
      subject: candidate.subject,
      title: candidate.title,
      detail: candidate.detail,
      ...(candidate.postId ? { postId: candidate.postId } : {}),
      ...(candidate.publicationId ? { publicationId: candidate.publicationId } : {}),
      ...(candidate.channel ? { channel: candidate.channel } : {}),
      href: candidate.href,
      fingerprint: candidate.fingerprint,
      acknowledged: matched,
      ...(matched && record ? { acknowledgedAt: record.acknowledgedAt } : {}),
    };
  });

  alerts.sort(
    (a, b) =>
      Number(a.acknowledged) - Number(b.acknowledged) ||
      (SEVERITY_ORDER.get(a.severity) as number) - (SEVERITY_ORDER.get(b.severity) as number) ||
      (KIND_ORDER.get(a.kind) as number) - (KIND_ORDER.get(b.kind) as number) ||
      a.subject.localeCompare(b.subject) ||
      a.id.localeCompare(b.id),
  );

  return {
    generatedAt: now.instant,
    config,
    alerts,
    counts: {
      action: alerts.filter((alert) => !alert.acknowledged && alert.severity === 'ACTION').length,
      watch: alerts.filter((alert) => !alert.acknowledged && alert.severity === 'WATCH').length,
      acknowledged: alerts.filter((alert) => alert.acknowledged).length,
    },
  };
}

/** Whether anything is live. An all-clear is a claim worth making explicitly. */
export const queueHealthIsClear = (summary: QueueHealthSummary): boolean =>
  summary.counts.action === 0 && summary.counts.watch === 0;

/**
 * The summary's headline, in one sentence.
 *
 * Shared rather than written in the component, for the reason every rule in here is shared: the
 * sentence is a reading of the counts and it should read the same wherever the counts are shown.
 */
export function queueHealthHeadline(summary: QueueHealthSummary): string {
  const { action, watch, acknowledged } = summary.counts;
  if (queueHealthIsClear(summary))
    return acknowledged
      ? `Nothing needs attention. ${acknowledged} acknowledged.`
      : 'Nothing needs attention.';
  const parts = [
    ...(action ? [`${action} ${action === 1 ? 'needs' : 'need'} action`] : []),
    ...(watch ? [`${watch} worth watching`] : []),
  ];
  return `${parts.join(', ')}.`;
}
