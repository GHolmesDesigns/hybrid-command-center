import type { Db } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import type { QueueSyncFacts } from '../../shared/queue-health.ts';

/**
 * When the provider was last reached, and whether it has told us to wait.
 *
 * Two facts about the *connection* rather than about any one publication, which is why they live in
 * one row instead of on each publication: a rate limit applies to every call the app would make, and
 * "when did we last get a straight answer" is one question however many submissions are outstanding.
 * Both are read by the queue-health summary and by nothing else.
 *
 * Written by the reconciliation check alone. That is deliberate rather than an omission: the alert
 * this feeds asks whether the *delivery answers on screen* are current, and a preview reading the
 * account list reaches the provider without refreshing a single answer. Stamping that as a
 * synchronisation would keep the record permanently fresh and the alert permanently silent.
 *
 * A settings row rather than a table because there is exactly one of it, for ever — the same reason
 * branding is a settings row. Nothing here is a credential, and nothing written here comes from a
 * provider response body: it is one timestamp and one deadline.
 */
export const PUBLISH_SYNC_HEALTH_KEY = 'publish_sync_health';

interface StoredSyncHealth {
  lastSyncedAt?: string;
  rateLimitedUntil?: string;
}

/**
 * The stored record, or nothing.
 *
 * Nothing is the honest answer for a workspace that has never reached the provider, and it is not
 * the same answer as "the last synchronisation was long ago" — the derivation treats the two
 * differently on purpose, so a workspace that has published nothing carries no staleness alert.
 * A row this build cannot parse is treated as absent rather than guessed at.
 */
export function readSyncHealth(db: Db): QueueSyncFacts | undefined {
  const raw = getSetting(db, PUBLISH_SYNC_HEALTH_KEY);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as StoredSyncHealth;
    const facts: QueueSyncFacts = {
      ...(typeof stored.lastSyncedAt === 'string' ? { lastSyncedAt: stored.lastSyncedAt } : {}),
      ...(typeof stored.rateLimitedUntil === 'string'
        ? { rateLimitedUntil: stored.rateLimitedUntil }
        : {}),
    };
    return facts.lastSyncedAt || facts.rateLimitedUntil ? facts : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merges one observation into the record.
 *
 * Merged rather than replaced because the two facts are observed by different events: a successful
 * check stamps `lastSyncedAt` and says nothing about a limit, and a refusal names a limit and says
 * nothing about a successful sync. A successful call does clear a limit, because reaching the
 * provider is proof the limit has passed.
 */
export function recordSyncHealth(db: Db, observation: QueueSyncFacts): void {
  const current = readSyncHealth(db) ?? {};
  const next: StoredSyncHealth = {
    ...current,
    ...observation,
    ...(observation.lastSyncedAt ? { rateLimitedUntil: undefined } : {}),
  };
  setSetting(
    db,
    PUBLISH_SYNC_HEALTH_KEY,
    JSON.stringify({
      ...(next.lastSyncedAt ? { lastSyncedAt: next.lastSyncedAt } : {}),
      ...(next.rateLimitedUntil ? { rateLimitedUntil: next.rateLimitedUntil } : {}),
    }),
  );
}
