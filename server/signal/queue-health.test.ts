import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { MockPublishProvider } from '../publish/mock-provider.ts';
import { PublishProviderError } from '../publish/provider.ts';
import { PublishService } from '../publish/service.ts';
import { readSyncHealth, recordSyncHealth } from '../publish/sync-health.ts';
import { publicationsForHealth } from '../publish/read.ts';
import { LocalSignalProvider } from './read.ts';
import { seedSignalPost } from './test-fixture.ts';
import {
  QUEUE_ALERT_ACK_LIMIT,
  QUEUE_HEALTH_SETTING_KEY,
  QueueAlertNotFoundError,
  acknowledgeQueueAlert,
  queueHealthNow,
  readAcknowledgements,
  readQueueHealth,
  readQueueHealthConfig,
  restoreQueueAlert,
  writeQueueHealthConfig,
} from './queue-health.ts';
import {
  DEFAULT_QUEUE_HEALTH_CONFIG,
  QUEUE_HEALTH_LOOKBACK_DAYS,
  type QueueHealthSummary,
} from '../../shared/queue-health.ts';
import type { PublicationState } from '../../shared/publish.ts';

/**
 * The gathering half, and the acknowledgement write.
 *
 * The rules themselves are exercised against fixtures in `shared/queue-health.test.ts`; what is
 * checked here is what this workspace hands them, and the one thing the card is strict about — that
 * saying *I have seen this* changes nothing about the plan or the delivery.
 */

let db: Db;
/** A local noon, so a day label is the same one whatever zone the run is in. */
const NOW = new Date(2026, 7, 19, 12, 0, 0);

beforeEach(() => {
  db = createDb(':memory:');
});

const dayLabel = (offset: number) => {
  const moment = new Date(2026, 7, 19 + offset);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
};

let publicationSequence = 0;
const seedPublication = (
  postId: string,
  overrides: {
    state?: PublicationState;
    createdAt?: string;
    providerPostId?: string | null;
    checkedState?: PublicationState;
    priorState?: PublicationState;
    targets?: {
      channel: string;
      accountId: number;
      mode?: string;
      outcome?: 'SUCCESS' | 'FAILURE';
      handle?: string;
    }[];
  } = {},
) => {
  const id = `pub-${++publicationSequence}`;
  const createdAt = overrides.createdAt ?? '2026-08-18T00:00:00.000Z';
  db.prepare(
    `INSERT INTO signal_publications(
       id,post_id,state,provider,provider_post_id,idempotency_key,scheduled_instant,timezone,
       sent_caption,sent_channels,sent_media,checked_at,checked_state,prior_state,check_attempts,
       created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    postId,
    overrides.state ?? 'SUBMITTED',
    'post-bridge',
    overrides.providerPostId === null ? null : (overrides.providerPostId ?? 'remote-1'),
    `key-${id}`,
    '2026-08-19T22:00:00.000Z',
    'America/New_York',
    'A clear campaign post',
    JSON.stringify(['x']),
    '[]',
    overrides.checkedState ? '2026-08-19T11:00:00.000Z' : null,
    overrides.checkedState ?? null,
    overrides.priorState ?? null,
    0,
    createdAt,
    createdAt,
  );
  for (const target of overrides.targets ?? [{ channel: 'x', accountId: 1 }])
    db.prepare(
      `INSERT INTO signal_publication_targets(publication_id,channel,provider_account_id,outcome,handle,mode)
       VALUES(?,?,?,?,?,?)`,
    ).run(
      id,
      target.channel,
      target.accountId,
      target.outcome ?? null,
      target.handle ?? '@studio',
      target.mode ?? 'AUTOMATIC',
    );
  return id;
};

const kindsOf = (summary: QueueHealthSummary) => summary.alerts.map((alert) => alert.kind);

describe('the configured windows', () => {
  it('starts at the defaults and merges one change at a time', () => {
    expect(readQueueHealthConfig(db)).toEqual(DEFAULT_QUEUE_HEALTH_CONFIG);
    expect(writeQueueHealthConfig(db, { coverageDays: 3 })).toEqual({
      ...DEFAULT_QUEUE_HEALTH_CONFIG,
      coverageDays: 3,
    });
    expect(writeQueueHealthConfig(db, { approachingHours: 6 })).toEqual({
      ...DEFAULT_QUEUE_HEALTH_CONFIG,
      coverageDays: 3,
      approachingHours: 6,
    });
  });

  it('falls back to the defaults for a row it cannot read', () => {
    setSetting(db, QUEUE_HEALTH_SETTING_KEY, 'not json');
    expect(readQueueHealthConfig(db)).toEqual(DEFAULT_QUEUE_HEALTH_CONFIG);
    setSetting(db, QUEUE_HEALTH_SETTING_KEY, JSON.stringify({ coverageDays: -4 }));
    expect(readQueueHealthConfig(db)).toEqual(DEFAULT_QUEUE_HEALTH_CONFIG);
  });

  it('refuses a window outside its bounds and a channel it does not know', async () => {
    const app = createApp(db, { now: () => NOW, publish: new MockPublishProvider() });
    expect(
      (await request(app).put('/api/signal/health/config').send({ coverageDays: 0 })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put('/api/signal/health/config')
          .send({ coverageChannels: ['mastodon'] })
      ).status,
    ).toBe(400);
    expect((await request(app).put('/api/signal/health/config').send({})).status).toBe(400);
    expect(readQueueHealthConfig(db)).toEqual(DEFAULT_QUEUE_HEALTH_CONFIG);
  });

  it('applies a window through the API and returns the summary measured with it', async () => {
    const app = createApp(db, { now: () => NOW, publish: new MockPublishProvider() });
    const response = await request(app)
      .put('/api/signal/health/config')
      .send({ coverageDays: 5, coverageChannels: ['ig'] });
    expect(response.status).toBe(200);
    expect(response.body.config).toMatchObject({ coverageDays: 5, coverageChannels: ['ig'] });
    expect(
      response.body.alerts.filter((alert: { kind: string }) => alert.kind === 'CHANNEL_UNCOVERED'),
    ).toHaveLength(1);
  });
});

describe('what the summary is gathered from', () => {
  it('says the same moment twice, as an instant and as local labels', () => {
    const now = queueHealthNow(NOW);
    expect(now.instant).toBe(NOW.toISOString());
    expect(now.slot).toEqual({ date: dayLabel(0), time: '12:00' });
  });

  it('looks back a bounded number of days and forward as far as coverage reaches', () => {
    writeQueueHealthConfig(db, { coverageDays: 7 });
    const inside = seedSignalPost(db, { date: dayLabel(3), channels: ['x'] });
    seedSignalPost(db, { date: dayLabel(40), channels: ['x'] });
    seedSignalPost(db, { date: dayLabel(-(QUEUE_HEALTH_LOOKBACK_DAYS + 5)), channels: ['x'] });
    // The post inside the window covers `x`, so the only gap left is the absence of one.
    expect(kindsOf(readQueueHealth(db, NOW))).not.toContain('CHANNEL_UNCOVERED');
    db.prepare('DELETE FROM signal_posts WHERE id=?').run(inside.id);
    expect(kindsOf(readQueueHealth(db, NOW))).toContain('CHANNEL_UNCOVERED');
  });

  it('reads the channels the workspace has used, not the ones in one window', () => {
    seedSignalPost(db, { date: dayLabel(-200), channels: ['li'] });
    const channels = readQueueHealth(db, NOW)
      .alerts.filter((alert) => alert.kind === 'CHANNEL_UNCOVERED')
      .map((alert) => alert.channel);
    expect(channels).toEqual(['li']);
  });

  it('keeps an open delivery however old it is, and lets go of a settled one', () => {
    const post = seedSignalPost(db, { date: dayLabel(-200), status: 'PUBLISHED' });
    seedPublication(post.id, { state: 'FAILED', createdAt: '2025-01-01T00:00:00.000Z' });
    seedPublication(post.id, { state: 'CANCELLED', createdAt: '2025-01-01T00:00:00.000Z' });
    const publications = publicationsForHealth(db, dayLabel(-QUEUE_HEALTH_LOOKBACK_DAYS));
    expect(publications.map((publication) => publication.state)).toEqual(['FAILED']);
    expect(kindsOf(readQueueHealth(db, NOW))).toContain('DELIVERY_ATTENTION');
  });

  it('names the post behind a delivery whose post is outside the window', () => {
    const post = seedSignalPost(db, {
      date: dayLabel(-200),
      status: 'PUBLISHED',
      text: 'A post from the archive',
    });
    seedPublication(post.id, { state: 'FAILED', createdAt: '2025-01-01T00:00:00.000Z' });
    const alert = readQueueHealth(db, NOW).alerts.find(
      (candidate) => candidate.kind === 'DELIVERY_ATTENTION',
    );
    expect(alert?.subject).toBe('A post from the archive');
    expect(alert?.href).toBe(`/signal?post=${post.id}`);
  });

  it('reports the move the last provider check made', () => {
    const post = seedSignalPost(db, { date: dayLabel(1), status: 'PUBLISHED' });
    seedPublication(post.id, {
      state: 'CONFIRMED',
      checkedState: 'CONFIRMED',
      priorState: 'SUBMITTED',
    });
    expect(kindsOf(readQueueHealth(db, NOW))).toContain('PROVIDER_STATE_CHANGED');
  });

  it('reads the synchronisation record, and makes no claim without one', () => {
    const post = seedSignalPost(db, { date: dayLabel(1), status: 'PUBLISHED' });
    seedPublication(post.id, { state: 'SUBMITTED' });
    expect(kindsOf(readQueueHealth(db, NOW))).not.toContain('SYNC_BEHIND');
    recordSyncHealth(db, { lastSyncedAt: '2026-08-01T00:00:00.000Z' });
    expect(kindsOf(readQueueHealth(db, NOW))).toContain('SYNC_BEHIND');
  });
});

describe('the synchronisation record', () => {
  it('is absent until something has been observed, and unreadable rows read as absent', () => {
    expect(readSyncHealth(db)).toBeUndefined();
    setSetting(db, 'publish_sync_health', 'not json');
    expect(readSyncHealth(db)).toBeUndefined();
    setSetting(db, 'publish_sync_health', JSON.stringify({ lastSyncedAt: 7 }));
    expect(readSyncHealth(db)).toBeUndefined();
  });

  it('merges a rate limit into the record and a successful sync clears it', () => {
    recordSyncHealth(db, { rateLimitedUntil: '2026-08-19T13:00:00.000Z' });
    expect(readSyncHealth(db)).toEqual({ rateLimitedUntil: '2026-08-19T13:00:00.000Z' });
    recordSyncHealth(db, { lastSyncedAt: '2026-08-19T12:30:00.000Z' });
    expect(readSyncHealth(db)).toEqual({ lastSyncedAt: '2026-08-19T12:30:00.000Z' });
  });

  it('is stamped by a provider check, and a refused one records the limit it named', async () => {
    const post = seedSignalPost(db, { date: dayLabel(1), channels: ['x'] });
    const provider = new MockPublishProvider([
      { id: 1, platform: 'twitter', handle: '@studio', name: 'Studio' },
    ]);
    const service = new PublishService(
      db,
      new LocalSignalProvider(db),
      provider,
      'America/New_York',
      () => NOW,
    );
    const preview = await service.preview(post.id);
    const publication = await service.submit(post.id, preview.planHash);
    expect(readSyncHealth(db)).toBeUndefined();

    provider.result = { providerPostId: 'mock-publication', state: 'CONFIRMED' };
    const checked = await service.reconcile(publication.id);
    expect(readSyncHealth(db)).toEqual({ lastSyncedAt: NOW.toISOString() });
    // The move the check made is recorded, which is what the alert is derived from.
    expect(checked.priorState).toBe('SUBMITTED');
    expect(checked.checkedState).toBe('CONFIRMED');

    // A check that finds the state it already had clears the marker, so yesterday's move is not
    // reported again as though the provider had just said it.
    const unchanged = await service.reconcile(publication.id);
    expect(unchanged.priorState).toBeUndefined();
    expect(unchanged.checkedState).toBe('CONFIRMED');

    provider.check = async () => {
      throw new PublishProviderError('Refused (429).', false, {
        rateLimited: true,
        retryAfterSeconds: 120,
      });
    };
    await expect(service.reconcile(publication.id)).rejects.toThrow('Refused (429).');
    expect(readSyncHealth(db)?.rateLimitedUntil).toBe(
      new Date(NOW.getTime() + 120_000).toISOString(),
    );
  });
});

describe('acknowledging an alert', () => {
  /** One failed delivery and a covered channel, so the failure is the only alert in the summary. */
  const failing = () => {
    const post = seedSignalPost(db, { date: dayLabel(1), status: 'PUBLISHED' });
    seedSignalPost(db, { date: dayLabel(3), channels: ['x'] });
    const publicationId = seedPublication(post.id, { state: 'FAILED' });
    return { post, publicationId, alertId: `DELIVERY_ATTENTION:${publicationId}` };
  };

  it('changes no planning or delivery state at all', () => {
    const { post, publicationId, alertId } = failing();
    const posts = db.prepare('SELECT * FROM signal_posts ORDER BY id').all();
    const publications = db.prepare('SELECT * FROM signal_publications ORDER BY id').all();
    const targets = db.prepare('SELECT * FROM signal_publication_targets ORDER BY rowid').all();

    const summary = acknowledgeQueueAlert(db, alertId, NOW);

    expect(db.prepare('SELECT * FROM signal_posts ORDER BY id').all()).toEqual(posts);
    expect(db.prepare('SELECT * FROM signal_publications ORDER BY id').all()).toEqual(publications);
    expect(db.prepare('SELECT * FROM signal_publication_targets ORDER BY rowid').all()).toEqual(
      targets,
    );
    expect(summary.alerts.find((alert) => alert.id === alertId)?.acknowledged).toBe(true);
    expect(summary.counts).toEqual({ action: 0, watch: 0, acknowledged: 1 });
    // And no integration event either: this is local data, not something an integration did.
    expect(db.prepare('SELECT COUNT(*) AS total FROM integration_events').get()).toEqual({
      total: 0,
    });
    expect(readAcknowledgements(db)).toEqual([
      {
        alertId,
        fingerprint: 'FAILED|',
        acknowledgedAt: NOW.toISOString(),
      },
    ]);
    expect(post.status).toBe('PUBLISHED');
    expect(
      db.prepare('SELECT state FROM signal_publications WHERE id=?').get(publicationId),
    ).toEqual({ state: 'FAILED' });
  });

  it('refuses an id with no live alert behind it', () => {
    failing();
    expect(() => acknowledgeQueueAlert(db, 'DELIVERY_ATTENTION:nobody', NOW)).toThrow(
      QueueAlertNotFoundError,
    );
    expect(readAcknowledgements(db)).toEqual([]);
  });

  it('puts one back, and does not mind being asked twice', () => {
    const { alertId } = failing();
    acknowledgeQueueAlert(db, alertId, NOW);
    expect(restoreQueueAlert(db, alertId, NOW).counts.action).toBe(1);
    expect(restoreQueueAlert(db, alertId, NOW).counts.action).toBe(1);
    expect(readAcknowledgements(db)).toEqual([]);
  });

  it('keeps a bounded number of acknowledgements, newest first', () => {
    const { alertId } = failing();
    const insert = db.prepare(
      'INSERT INTO signal_alert_acks(alert_id,fingerprint,acknowledged_at) VALUES(?,?,?)',
    );
    for (let index = 0; index < QUEUE_ALERT_ACK_LIMIT; index += 1)
      insert.run(`OLD:${index}`, 'x', `2020-01-01T00:00:${String(index).padStart(2, '0')}.000Z`);
    acknowledgeQueueAlert(db, alertId, NOW);
    const kept = readAcknowledgements(db);
    expect(kept).toHaveLength(QUEUE_ALERT_ACK_LIMIT);
    expect(kept.map((record) => record.alertId)).toContain(alertId);
    expect(kept.map((record) => record.alertId)).not.toContain('OLD:0');
  });

  it('answers over the API and reports an unknown alert as a miss', async () => {
    const { alertId } = failing();
    const app = createApp(db, { now: () => NOW, publish: new MockPublishProvider() });
    const before = await request(app).get('/api/signal/health');
    expect(before.status).toBe(200);
    expect(before.body.counts.action).toBe(1);

    const acknowledged = await request(app).post(
      `/api/signal/health/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    );
    expect(acknowledged.status).toBe(200);
    expect(acknowledged.body.counts).toEqual({ action: 0, watch: 0, acknowledged: 1 });

    const restored = await request(app).delete(
      `/api/signal/health/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    );
    expect(restored.body.counts.action).toBe(1);

    expect(
      (await request(app).post('/api/signal/health/alerts/DELIVERY_ATTENTION:nope/acknowledge'))
        .status,
    ).toBe(404);
  });

  it('leaves nothing behind in the settings table it does not own', () => {
    const { alertId } = failing();
    acknowledgeQueueAlert(db, alertId, NOW);
    expect(getSetting(db, QUEUE_HEALTH_SETTING_KEY)).toBeUndefined();
  });
});
