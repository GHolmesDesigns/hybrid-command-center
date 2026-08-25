import { deliveryModeNeedsPerson, type SignalPublication } from './publish.ts';

/**
 * Card-level delivery status for Signal planner tiles.
 *
 * ## Derived, never stored
 *
 * Every answer here is a conclusion about publication and target rows that already exist. Nothing
 * is written when a card shows a status, and nothing on this path can change a post's planning
 * status — `SignalPost.status` stays the user's claim, and a provider result never writes it.
 *
 * ## One summary per post
 *
 * A post can carry a history of publications. The card shows the newest that was not cancelled:
 * cancelled-only history reads as not submitted again, because the delivery was withdrawn. PARTIAL
 * and UNCONFIRMED stay their own states rather than collapsing into failed or into the planning
 * word "scheduled".
 *
 * ## No provider call
 *
 * Callers gather local rows and hand them over. This module reads no database and no network, so
 * the planner can load every card's answer in one batch without spending a request per card and
 * without contacting a provider.
 */

export const CARD_DELIVERY_STATES = [
  'NONE',
  'IN_FLIGHT',
  'DELIVERED',
  'PARTIAL',
  'FAILED',
  'AMBIGUOUS',
  'MANUAL',
] as const;
export type CardDeliveryState = (typeof CARD_DELIVERY_STATES)[number];

/**
 * Words shown on the card. Never a raw `PublicationState`, and never the planning-status labels
 * (`Draft` / `Scheduled` / `Published`), so the two indicators stay separately named.
 */
export const CARD_DELIVERY_LABEL: Record<CardDeliveryState, string> = {
  NONE: 'Not submitted',
  IN_FLIGHT: 'In progress',
  DELIVERED: 'Delivered',
  PARTIAL: 'Partly delivered',
  FAILED: 'Not delivered',
  AMBIGUOUS: 'Unconfirmed',
  MANUAL: 'Finish by hand',
};

export interface CardDelivery {
  postId: string;
  state: CardDeliveryState;
  label: string;
}

/** The planner's one batch answer: every post in the range and queue, keyed by id in an array. */
export interface CardDeliverySnapshot {
  from: string;
  to: string;
  deliveries: CardDelivery[];
}

/** Newest first — created_at, then id — so two rows stamped the same second still order stably. */
const byNewest = (a: SignalPublication, b: SignalPublication) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/**
 * A target a person still has to finish in the native app.
 *
 * Matches the delivery panel's "waiting for you" reading: the provider has accepted the account
 * (`SUCCESS`) and the mode still needs a person. Before that outcome the card stays in flight.
 */
const awaitsManualFinish = (publication: SignalPublication): boolean =>
  publication.targets.some(
    (target) =>
      deliveryModeNeedsPerson(target.mode) &&
      target.outcome === 'SUCCESS' &&
      !target.manualCompletedAt,
  );

/**
 * Every manual-finish target that succeeded has been marked finished, and nothing failed.
 *
 * Used when the publication is still `SUBMITTED` — the provider accepted it, a person finished the
 * hand part, and the card should read delivered rather than keep asking for a finish.
 */
const manualFinishComplete = (publication: SignalPublication): boolean => {
  const needingPerson = publication.targets.filter((target) =>
    deliveryModeNeedsPerson(target.mode),
  );
  if (needingPerson.length === 0) return false;
  return (
    needingPerson.every((target) => target.manualCompletedAt) &&
    !publication.targets.some((target) => target.outcome === 'FAILURE')
  );
};

/**
 * One publication's card answer.
 *
 * PARTIAL, FAILED, and UNCONFIRMED win as themselves — the acceptance criterion that partial and
 * ambiguous stay visible. Manual finish waiting only outranks bare in-flight.
 */
export function cardDeliveryFromPublication(
  postId: string,
  publication: SignalPublication,
): CardDelivery {
  const labelled = (state: CardDeliveryState): CardDelivery => ({
    postId,
    state,
    label: CARD_DELIVERY_LABEL[state],
  });

  switch (publication.state) {
    case 'PARTIAL':
      return labelled('PARTIAL');
    case 'FAILED':
      return labelled('FAILED');
    case 'UNCONFIRMED':
      return labelled('AMBIGUOUS');
    case 'CONFIRMED':
      return labelled('DELIVERED');
    case 'CANCELLED':
      return labelled('NONE');
    case 'SUBMITTING':
    case 'SUBMITTED':
      if (awaitsManualFinish(publication)) return labelled('MANUAL');
      if (manualFinishComplete(publication)) return labelled('DELIVERED');
      return labelled('IN_FLIGHT');
  }
}

/**
 * One post's card answer from the publications it already has.
 *
 * Cancelled rows are skipped so a withdrawn delivery does not hide a later resubmit, and a post
 * whose only history is cancelled reads as not submitted.
 */
export function cardDeliveryFor(
  postId: string,
  publications: readonly SignalPublication[],
): CardDelivery {
  const latest = publications
    .filter((publication) => publication.postId === postId && publication.state !== 'CANCELLED')
    .sort(byNewest)[0];
  if (!latest) {
    return { postId, state: 'NONE', label: CARD_DELIVERY_LABEL.NONE };
  }
  return cardDeliveryFromPublication(postId, latest);
}

/** Every post id in the planner batch, each with its own delivery answer. */
export function deriveCardDeliveries(
  postIds: readonly string[],
  publications: readonly SignalPublication[],
): CardDelivery[] {
  return postIds.map((postId) => cardDeliveryFor(postId, publications));
}
