import type { Db } from '../db.ts';
import { deriveCardDeliveries, type CardDeliverySnapshot } from '../../shared/card-delivery.ts';
import { listPostsInRange } from './read.ts';
import { listQueue } from './service.ts';
import { publicationsForPosts } from '../publish/read.ts';

/**
 * Card delivery for the Signal planner, gathered here and concluded in `shared/card-delivery.ts`.
 *
 * Thin on purpose: this module picks the same posts the planner draws (the bounded date range plus
 * the unscheduled queue), loads their publication/target rows in one local batch, and returns the
 * derived answers. There is no statement here that writes a post, a publication, a target, or a
 * planning status, and nothing contacts a provider — opening the planner must not spend a provider
 * request and must not open one HTTP call per card.
 */

/**
 * Every planner card's delivery answer for the range the grid is showing.
 *
 * Uses `listPostsInRange` rather than a second date query so the card batch and the post grid
 * cannot disagree about truncation: a post the range dropped is not given a delivery chip either.
 */
export function readCardDeliveries(db: Db, from: string, to: string): CardDeliverySnapshot {
  const range = listPostsInRange(db, from, to);
  const queue = listQueue(db);
  const postIds = [...range.posts, ...queue].map((post) => post.id);
  const publications = publicationsForPosts(db, postIds);
  return {
    from,
    to,
    deliveries: deriveCardDeliveries(postIds, publications),
  };
}
