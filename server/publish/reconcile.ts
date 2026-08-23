/**
 * The difference between what Signal holds and what the provider holds, and what may be done about
 * it. Pure: no database, no network, no clock.
 *
 * Split from the service for the reason `plan.ts` is: the rules that decide whether a post the
 * provider has already accepted may be rewritten, moved, or withdrawn are the part worth being able
 * to exercise directly, against records no live account would produce on demand — a post caught
 * mid-send, a draft the vendor also calls scheduled, a remote whose account set has drifted.
 *
 * Signal stays authoritative throughout (`docs/publishing-integration.md` §7). Nothing here ever
 * proposes copying the provider's value back into the post: every action moves the provider towards
 * Signal, or withdraws it, and a disagreement is reported rather than resolved by whoever is louder.
 */
import {
  PROVIDER_ACTIONS,
  PROVIDER_DIFF_FIELDS,
  providerRecordIsMutable,
  providerRecordIsPublished,
  publicationTracksProvider,
  PROVIDER_POST_STATE_LABEL,
  PUBLICATION_STATE_LABEL,
  type ProviderAction,
  type ProviderActionOffer,
  type ProviderDiffField,
  type ProviderFieldDiff,
  type ProviderPostRecord,
  type ProviderReconcilePreview,
  type PublishPreview,
  type SignalPublication,
} from '../../shared/publish.ts';
import { planHash } from './plan.ts';
import type { PublishRequest } from './provider.ts';
import type { SignalPostMedia } from '../../shared/signal-media.ts';

/**
 * Whether a fresh submission may replace what the provider is holding.
 *
 * Wider than `providerRecordIsMutable` by exactly one state. A post the provider has already failed
 * is not going out — there is nothing left to withdraw, and the vendor refuses `DELETE` on it — but
 * sending the post again is precisely the recovery someone wants. `PROCESSING` and `PUBLISHED` are
 * refused: one is a race and the other is a duplicate in front of readers.
 */
export const providerRecordCanRestore = (record: ProviderPostRecord): boolean =>
  providerRecordIsMutable(record.state) || record.state === 'FAILED';

/** Whether withdrawing this record needs a provider call at all. A failed post has nothing out. */
export const providerRecordNeedsWithdrawal = (record: ProviderPostRecord): boolean =>
  providerRecordIsMutable(record.state);

const renderList = (values: readonly string[]) => (values.length ? values.join(', ') : 'None');

const renderInstant = (instant: string | null | undefined) => instant ?? 'Not scheduled';

/** One field rendered from both sides, and whether the two sides differ. */
function diffFor(
  field: ProviderDiffField,
  request: PublishRequest,
  record: ProviderPostRecord,
  publication: SignalPublication,
  plannedSources: readonly SignalPostMedia[] = [],
): ProviderFieldDiff {
  switch (field) {
    case 'caption':
      return {
        field,
        changed: request.caption !== record.caption,
        local: request.caption,
        remote: record.caption,
      };
    case 'schedule':
      return {
        field,
        changed: request.scheduledInstant !== record.scheduledInstant,
        local: renderInstant(request.scheduledInstant),
        remote: renderInstant(record.scheduledInstant),
      };
    case 'media':
      if (request.mediaIds !== undefined) {
        const sourceChanged =
          publication.sentMediaSources !== undefined &&
          JSON.stringify(plannedSources) !== JSON.stringify(publication.sentMediaSources.items);
        if (sourceChanged)
          return {
            field,
            changed: true,
            local: 'Signal’s current Drive files',
            remote: 'The Drive files used for this provider post',
          };
        if (record.mediaIds === undefined)
          return {
            field,
            changed: false,
            comparisonAvailable: false,
            local: 'Uploaded provider media',
            remote: 'Media comparison unavailable',
          };
        return {
          field,
          changed:
            JSON.stringify(publication.sentProviderMediaIds ?? []) !==
            JSON.stringify(record.mediaIds),
          local: renderList(publication.sentProviderMediaIds ?? []),
          remote: renderList(record.mediaIds),
        };
      }
      return {
        field,
        changed: JSON.stringify(request.mediaUrls ?? []) !== JSON.stringify(record.mediaUrls),
        local: renderList(request.mediaUrls ?? []),
        remote: renderList(record.mediaUrls),
      };
    case 'accounts': {
      // Sorted on both sides: the provider does not promise an order, and an ordering difference is
      // not a difference anybody wants to be asked to reconcile.
      const local = request.targets.map((target) => target.accountId).sort((a, b) => a - b);
      const remote = [...record.accountIds].sort((a, b) => a - b);
      return {
        field,
        changed: JSON.stringify(local) !== JSON.stringify(remote),
        local: renderList(local.map(String)),
        remote: renderList(remote.map(String)),
      };
    }
    case 'accountContent': {
      const describe = (entries: readonly { accountId: number; caption?: string }[]) =>
        renderList(
          [...entries]
            .sort((a, b) => a.accountId - b.accountId)
            .map((entry) => `${entry.accountId}: ${entry.caption ?? 'unchanged'}`),
        );
      const local = request.accountConfigurations ?? [];
      // Absent means the provider did not report it, which is not the same as reporting none. A
      // comparison against something nobody returned would manufacture a difference, so this says
      // it cannot compare and reports no change.
      if (!record.accountConfigurations)
        return {
          field,
          changed: false,
          local: describe(local),
          remote: 'Not reported by the provider',
        };
      const remote = record.accountConfigurations;
      return {
        field,
        changed: describe(local) !== describe(remote),
        local: describe(local),
        remote: describe(remote),
      };
    }
  }
}

export interface ProviderReconcileInput {
  publication: SignalPublication;
  /** The plan the post produces now. `request` is absent whenever the plan refuses anything. */
  plan: PublishPreview & { request?: PublishRequest; mediaSources?: SignalPostMedia[] };
  /** What the provider says it holds. Absent when the read failed. */
  record?: ProviderPostRecord;
  /** Why the record could not be read, already redacted. Present only when `record` is absent. */
  recordError?: string;
}

/**
 * Everything the confirmation screen needs, and everything the commit re-derives.
 *
 * One function for both sides on purpose, the way the importer plans twice from one planner: the
 * preview the user reads and the gate the commit passes are the same computation over the same
 * inputs, so an action cannot be shown as available and then permitted on a different basis.
 */
export function buildProviderReconcile(input: ProviderReconcileInput): ProviderReconcilePreview {
  const { publication, plan, record, recordError } = input;
  const refusals: string[] = [];
  const warnings: string[] = [];

  if (!publication.providerPostId)
    refusals.push(
      'This publication has no provider id, so there is nothing to compare it against. Look at it in Post Bridge before acting on it.',
    );
  if (!publicationTracksProvider(publication.state))
    refusals.push(
      `This submission is ${PUBLICATION_STATE_LABEL[publication.state].toLowerCase()}, so the provider is no longer holding it for this app to change.`,
    );
  if (!record)
    refusals.push(recordError ?? 'The provider could not be read, so no difference can be shown.');

  const empty: ProviderReconcilePreview = {
    publicationId: publication.id,
    postId: publication.postId,
    reconcileHash: '',
    diffs: [],
    changed: [],
    actions: PROVIDER_ACTIONS.map((action) => ({ action, available: false, refusals })),
    warnings,
    refusals,
  };
  if (refusals.length || !record) return empty;

  // The plan's own refusals are the reason an update cannot be assembled, and they are worth
  // repeating here rather than collapsing to "no request": a caption over X's limit should say so
  // on this panel too, not only on the publishing preview the user is not looking at.
  const planRefusals = plan.request
    ? []
    : [...plan.refusals, ...plan.channels.flatMap((report) => report.refusals)];
  const request = plan.request;
  const diffs = request
    ? PROVIDER_DIFF_FIELDS.map((field) =>
        diffFor(field, request, record, publication, plan.mediaSources),
      )
    : [];
  const changed = diffs.filter((diff) => diff.changed).map((diff) => diff.field);
  const contentChanged = changed.some((field) => field !== 'schedule');
  const scheduleChanged = changed.includes('schedule');

  /**
   * Whether the provider is holding content this app did not send.
   *
   * The snapshot on the publication is what went out; the record is what is out there now. When
   * they disagree, somebody edited the post in Post Bridge itself, and that matters to exactly one
   * action: **Update provider schedule** sends the snapshot as the content it is "already holding",
   * which would silently overwrite their edit. So the disagreement is reported, and rescheduling
   * fails closed until the user chooses which side wins.
   */
  const mediaComparisonUnavailable =
    publication.sentProviderMediaIds !== undefined && record.mediaIds === undefined;
  const remoteMediaEdited = publication.sentProviderMediaIds
    ? record.mediaIds !== undefined &&
      JSON.stringify(record.mediaIds) !== JSON.stringify(publication.sentProviderMediaIds)
    : publication.sentMedia !== undefined &&
      JSON.stringify(record.mediaUrls) !== JSON.stringify(publication.sentMedia);
  const remoteEdited =
    record.caption !== publication.sentCaption ||
    remoteMediaEdited ||
    JSON.stringify([...record.accountIds].sort((a, b) => a - b)) !==
      JSON.stringify(publication.targets.map((target) => target.accountId).sort((a, b) => a - b));
  if (remoteEdited)
    warnings.push(
      'The provider is holding content this app did not send, so it was changed in Post Bridge directly. Updating the content replaces theirs with Signal.',
    );
  if (mediaComparisonUnavailable)
    warnings.push(
      'Media comparison unavailable: the provider no longer exposes ids for the uploaded assets this app sent.',
    );
  /**
   * A publication from before the media snapshot existed.
   *
   * Rescheduling has to leave the provider's content alone, and proving that it does means knowing
   * what this app sent. An unrecorded snapshot cannot prove it either way, so the one action that
   * depends on the proof is refused and the two that do not are unaffected.
   */
  const snapshotIncomplete = publication.sentMedia === undefined;
  if (snapshotIncomplete)
    warnings.push(
      'This submission predates the media snapshot, so this app cannot show what media went out. The provider row above is what is actually there.',
    );

  if (providerRecordIsPublished(record.state))
    warnings.push(
      'The provider has already published this. Nothing here can unpublish it — remove it on the platform itself.',
    );
  if (record.state === 'PROCESSING')
    warnings.push(
      'The provider is sending this right now, so it is between states. Refresh in a minute and act on what it says then.',
    );

  /** Reasons no write to this record may happen at all, whatever the action wants to change. */
  const mutability = (action: ProviderAction): string[] => {
    const reasons: string[] = [];
    if (providerRecordIsPublished(record.state))
      reasons.push(
        action === 'CANCEL'
          ? 'This is already published. A published post cannot be cancelled through the scheduled-or-draft path, and this app will not try.'
          : 'This is already published, so the provider will not take a change to it.',
      );
    else if (record.state === 'PROCESSING')
      reasons.push(
        'This is being sent right now. Changing it mid-send could land on either side of the send, so it is refused rather than guessed at.',
      );
    return reasons;
  };

  const offers: ProviderActionOffer[] = PROVIDER_ACTIONS.map((action) => {
    const reasons = mutability(action);
    switch (action) {
      case 'UPDATE_CONTENT':
      case 'UPDATE_SCHEDULE': {
        if (!providerRecordIsMutable(record.state) && !reasons.length)
          reasons.push(
            `The provider reports this as ${PROVIDER_POST_STATE_LABEL[record.state].toLowerCase()}, which it does not accept changes to.`,
          );
        if (!request) reasons.push(...planRefusals);
        if (action === 'UPDATE_CONTENT' && request && !contentChanged)
          reasons.push('The provider already has this caption, media, and account set.');
        if (action === 'UPDATE_SCHEDULE' && request && !scheduleChanged)
          reasons.push('The provider is already on this instant.');
        if (action === 'UPDATE_SCHEDULE' && remoteEdited)
          reasons.push(
            'The provider is holding content this app did not send, and moving the instant would send this app’s copy over it. Update the content from Signal, or cancel and resubmit, before rescheduling.',
          );
        if (action === 'UPDATE_SCHEDULE' && snapshotIncomplete)
          reasons.push(
            'This submission predates the media snapshot, so this app cannot tell whether the provider still holds what it sent. Update the content from Signal, or cancel and resubmit, instead of moving the instant alone.',
          );
        if (action === 'UPDATE_SCHEDULE' && mediaComparisonUnavailable)
          reasons.push(
            'Media comparison unavailable, so this app cannot prove a schedule-only update would preserve the provider content. Update the content from Signal, or cancel and resubmit instead.',
          );
        break;
      }
      case 'CANCEL': {
        if (!providerRecordIsMutable(record.state) && !reasons.length)
          reasons.push(
            `The provider reports this as ${PROVIDER_POST_STATE_LABEL[record.state].toLowerCase()}, and it withdraws only a scheduled or draft post.`,
          );
        break;
      }
      case 'RESTORE_AND_RESUBMIT': {
        // The only states this excludes are `PUBLISHED` and `PROCESSING`, and `mutability` has
        // already refused both by name — so today this pushes nothing and the sentence never
        // appears. It stays as the authority rather than as a duplicate: a state added to the
        // union later is refused here even if `mutability` has nothing to say about it, which is
        // the fail-closed direction to be wrong in.
        if (!providerRecordCanRestore(record) && !reasons.length)
          reasons.push(
            `The provider reports this as ${PROVIDER_POST_STATE_LABEL[record.state].toLowerCase()}, so it cannot be replaced by a fresh submission.`,
          );
        if (!request) reasons.push(...planRefusals);
        break;
      }
    }
    return { action, available: reasons.length === 0, refusals: reasons };
  });

  return {
    publicationId: publication.id,
    postId: publication.postId,
    record,
    /**
     * The token both sides of the comparison are folded into.
     *
     * The plan hash alone would miss a provider that moved under an open panel — someone else
     * rescheduling it, or the post going out — and the record alone would miss a Signal edit. A
     * commit is only allowed against a preview taken when *both* were as they are now, which is
     * what makes "commit rejects a stale preview" true of a two-sided comparison rather than a
     * one-sided one.
     */
    reconcileHash: planHash({
      publicationId: publication.id,
      publicationState: publication.state,
      publicationProvider: publication.provider,
      publicationTargets: publication.targets.map((target) => ({
        provider: target.provider ?? publication.provider,
        accountRef: target.accountRef ?? String(target.accountId),
        remotePostId: target.remotePostId ?? null,
      })),
      planHash: plan.planHash,
      record,
    }),
    diffs,
    changed,
    actions: offers,
    warnings,
    refusals,
  };
}
