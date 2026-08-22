import { format } from 'date-fns';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { readSyncHealth } from '../publish/sync-health.ts';
import {
  DEFAULT_QUEUE_HEALTH_CONFIG,
  deriveQueueHealth,
  QUEUE_HEALTH_LIMITS,
  QUEUE_HEALTH_LOOKBACK_DAYS,
  type QueueAlertAcknowledgement,
  type QueueHealthConfig,
  type QueueHealthNow,
  type QueueHealthSummary,
} from '../../shared/queue-health.ts';
import { isSignalChannel, type SignalChannel } from '../../shared/signal.ts';
import { toSignalPosts, type SignalPostRow } from './rows.ts';
import { publicationsForHealth } from '../publish/read.ts';
import { knownProviderPostIds, readProviderInventoryPosts } from '../publish/inventory-rows.ts';

/**
 * The queue-health summary, gathered here and concluded in `shared/queue-health.ts`.
 *
 * This module is the half that touches the database, and it is deliberately thin: it reads the rows
 * the rules need, hands them over, and returns what comes back. Every rule about what counts as an
 * alert lives in the shared module, which is why the rules can be tested against fixtures with no
 * database and no React in the way.
 *
 * The only write in here is an acknowledgement, and it lands in `signal_alert_acks` and nowhere else.
 * Nothing in this file can change a post, a publication, a target, or a planning status — there is no
 * statement here that touches one, which is how the card's "acknowledging alters no planning or
 * delivery state" is kept rather than remembered.
 */

export const QUEUE_HEALTH_SETTING_KEY = 'signal_queue_health';

/** How many acknowledgements are kept. The newest survive; older rows are pruned as new ones land. */
export const QUEUE_ALERT_ACK_LIMIT = 200;

const bounded = (limit: { min: number; max: number }) =>
  z.coerce.number().int().min(limit.min).max(limit.max);

/**
 * The shape a caller may send, bounded by the same limits the form offers.
 *
 * Partial, so a request may move one window without restating the others; every absent key falls
 * back to what is stored, and then to the defaults.
 */
export const queueHealthConfigInput = z
  .object({
    approachingHours: bounded(QUEUE_HEALTH_LIMITS.approachingHours),
    coverageDays: bounded(QUEUE_HEALTH_LIMITS.coverageDays),
    syncStaleHours: bounded(QUEUE_HEALTH_LIMITS.syncStaleHours),
    // A channel this build does not know is refused rather than stored: a coverage list is read
    // back as a set of channels, and one that cannot be resolved would report a gap for ever.
    coverageChannels: z.array(z.string().refine(isSignalChannel)).max(32),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide a queue-health window to update.',
  });

export type QueueHealthConfigInput = z.infer<typeof queueHealthConfigInput>;

/**
 * The stored configuration, completed from the defaults one key at a time.
 *
 * Per key rather than all-or-nothing, so a row written by an earlier build — or one carrying a window
 * this build has since bounded differently — keeps every value that still validates instead of
 * reverting the lot. A row that cannot be parsed at all falls back to the defaults, which are known
 * to be sensible.
 */
export function readQueueHealthConfig(db: Db): QueueHealthConfig {
  const raw = getSetting(db, QUEUE_HEALTH_SETTING_KEY);
  if (!raw) return { ...DEFAULT_QUEUE_HEALTH_CONFIG };
  try {
    const stored = queueHealthConfigInput.safeParse(JSON.parse(raw));
    return stored.success
      ? { ...DEFAULT_QUEUE_HEALTH_CONFIG, ...stored.data }
      : { ...DEFAULT_QUEUE_HEALTH_CONFIG };
  } catch {
    return { ...DEFAULT_QUEUE_HEALTH_CONFIG };
  }
}

/** Merges one change into the stored configuration and returns the whole of it. */
export function writeQueueHealthConfig(db: Db, input: QueueHealthConfigInput): QueueHealthConfig {
  const next: QueueHealthConfig = { ...readQueueHealthConfig(db), ...input };
  setSetting(db, QUEUE_HEALTH_SETTING_KEY, JSON.stringify(next));
  return next;
}

/** A local calendar day label, the same way every other date in this app is read. */
const dayLabel = (moment: Date) => format(moment, 'yyyy-MM-dd');

/**
 * The moment a summary is taken, said as an instant and as local labels.
 *
 * Both come from one `Date`, so the two cannot describe different moments. The labels are local
 * because a post's date and time are local labels (`shared/signal.ts`); the instant is UTC because a
 * synchronisation happened at a moment.
 */
export const queueHealthNow = (moment: Date): QueueHealthNow => ({
  instant: moment.toISOString(),
  slot: { date: dayLabel(moment), time: format(moment, 'HH:mm') },
});

const shiftDays = (label: string, days: number) => {
  const [year, month, day] = label.split('-').map(Number) as [number, number, number];
  return dayLabel(new Date(year, month - 1, day + days));
};

/**
 * Every dated post the rules may look at: the lookback behind, the coverage window ahead.
 *
 * Unbounded on purpose, where the planner's range read is capped at 500. The cap there exists
 * because a month of posts is drawn into a grid a person reads; here the rows are counted and thrown
 * away, and a cap would turn a coverage gap the workspace does have into an alert it never sees —
 * a silent under-report is worse than a slower query over a local file.
 */
const postsInWindow = (db: Db, from: string, to: string) => {
  const rows = db
    .prepare(
      `SELECT * FROM signal_posts
       WHERE date IS NOT NULL AND date >= ? AND date <= ?
       ORDER BY date, time, created_at, id`,
    )
    .all(from, to) as unknown as SignalPostRow[];
  return toSignalPosts(db, rows);
};

const postsByIds = (db: Db, ids: readonly string[]) => {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM signal_posts WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as SignalPostRow[];
  return toSignalPosts(db, rows);
};

/** Every channel the workspace has ever used, which is what coverage defaults to asking about. */
const usedChannels = (db: Db): SignalChannel[] =>
  (db.prepare('SELECT DISTINCT channel FROM signal_post_channels').all() as { channel: string }[])
    .map((row) => row.channel)
    .filter(isSignalChannel);

export function readAcknowledgements(db: Db): QueueAlertAcknowledgement[] {
  return (
    db.prepare('SELECT alert_id, fingerprint, acknowledged_at FROM signal_alert_acks').all() as {
      alert_id: string;
      fingerprint: string;
      acknowledged_at: string;
    }[]
  ).map((row) => ({
    alertId: row.alert_id,
    fingerprint: row.fingerprint,
    acknowledgedAt: row.acknowledged_at,
  }));
}

/**
 * The summary as it stands, derived from rows and written nowhere.
 *
 * Recomputed on every call rather than cached, which is what makes it impossible for the list to
 * disagree with the posts and deliveries it is a reading of.
 */
export function readQueueHealth(db: Db, now: Date): QueueHealthSummary {
  const config = readQueueHealthConfig(db);
  const today = dayLabel(now);
  const windowed = postsInWindow(
    db,
    shiftDays(today, -QUEUE_HEALTH_LOOKBACK_DAYS),
    shiftDays(today, config.coverageDays),
  );
  const publications = publicationsForHealth(db, shiftDays(today, -QUEUE_HEALTH_LOOKBACK_DAYS));
  // A publication whose post has been moved out of the window is still a delivery that happened, so
  // its post is fetched by id rather than left unnamed. An alert that cannot say which post it is
  // about is an alert nobody can act on.
  const known = new Set(windowed.map((post) => post.id));
  const missing = [
    ...new Set(
      publications.map((publication) => publication.postId).filter((id) => !known.has(id)),
    ),
  ];
  const sync = readSyncHealth(db);
  return deriveQueueHealth(
    {
      posts: [...windowed, ...postsByIds(db, missing)],
      publications,
      usedChannels: usedChannels(db),
      ...(sync ? { sync } : {}),
      // What the provider was holding when somebody last pressed refresh, and every provider id this
      // app's own publications claim. Both are local reads through the read-only inventory module —
      // no provider call happens here, which is what keeps loading the planner free of one.
      providerPosts: readProviderInventoryPosts(db),
      knownProviderPostIds: knownProviderPostIds(db),
      acknowledgements: readAcknowledgements(db),
    },
    config,
    queueHealthNow(now),
  );
}

export class QueueAlertNotFoundError extends Error {
  constructor(message = 'That alert is not in the current summary.') {
    super(message);
    this.name = 'QueueAlertNotFoundError';
  }
}

/**
 * Records that a person has seen one alert, and returns the summary again.
 *
 * The alert has to be in the summary as it stands. Acknowledging one that is not there would write a
 * row for a fact nobody can see, and the fingerprint it would carry is the whole point of the
 * record — so an id with no live alert behind it is refused rather than stored.
 *
 * `signal_alert_acks` is the only table this touches. Nothing about the post, the publication, or
 * any target moves, which is why the summary looks exactly the same afterwards apart from the one
 * alert now marked as seen.
 */
export function acknowledgeQueueAlert(db: Db, alertId: string, now: Date): QueueHealthSummary {
  const summary = readQueueHealth(db, now);
  const alert = summary.alerts.find((candidate) => candidate.id === alertId);
  if (!alert) throw new QueueAlertNotFoundError();
  transaction(db, () => {
    db.prepare(
      `INSERT INTO signal_alert_acks(alert_id,fingerprint,acknowledged_at) VALUES(?,?,?)
       ON CONFLICT(alert_id) DO UPDATE SET fingerprint=excluded.fingerprint, acknowledged_at=excluded.acknowledged_at`,
    ).run(alertId, alert.fingerprint, now.toISOString());
    // Retention, the same bound the integration log keeps and for the same reason: a workspace that
    // acknowledges an alert a day should not grow a table without one.
    db.prepare(
      `DELETE FROM signal_alert_acks WHERE alert_id NOT IN (
         SELECT alert_id FROM signal_alert_acks ORDER BY acknowledged_at DESC, alert_id DESC LIMIT ?
       )`,
    ).run(QUEUE_ALERT_ACK_LIMIT);
  });
  return readQueueHealth(db, now);
}

/** Undoes one acknowledgement. Absent is already the state asked for, so this is idempotent. */
export function restoreQueueAlert(db: Db, alertId: string, now: Date): QueueHealthSummary {
  db.prepare('DELETE FROM signal_alert_acks WHERE alert_id=?').run(alertId);
  return readQueueHealth(db, now);
}
