import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import {
  analyticsBackoffSeconds,
  analyticsPlatformSupported,
  analyticsRefreshGate,
  postMetricAvailability,
  postMetricsSyncable,
  POST_METRIC_FAILED_DELIVERY_DETAIL,
  ANALYTICS_BACKOFF_MAX_ATTEMPTS,
  type AnalyticsRefreshState,
  type AnalyticsSyncRecord,
  type PostMetricDay,
  type PostMetricsSummary,
  type PostTargetMetrics,
} from '../../shared/publish-analytics.ts';
import { publishPlatformFor } from '../../shared/publish-capabilities.ts';
import type { SignalChannel } from '../../shared/signal.ts';
import type {
  AnalyticsProvider,
  ProviderAnalyticsList,
  ProviderAnalyticsRecord,
} from './analytics-provider.ts';
import { PublishProviderError } from './provider.ts';
import { recordSyncHealth } from './sync-health.ts';

/**
 * Figures, beside the publishing service rather than inside it.
 *
 * Beside, and not inside, for two reasons the card states as criteria. It never touches
 * `SignalProvider`, which has no write method by construction and gains nothing here — this service
 * reads publication and target rows directly and asks nothing of Signal. And it is a different kind
 * of provider call from every other one in `server/publish/`: everything else in that directory
 * exists to get a post *out*, and this exists to read numbers back, so it holds an
 * `AnalyticsProvider` and has no way to submit, update, or cancel anything.
 *
 * ## What it writes, and what it will not
 *
 * It writes `signal_post_metrics`, `signal_post_metric_days`, one settings row recording how the
 * connection is behaving, and one `integration_events` row per refresh. It writes nothing else. In
 * particular it never touches `signal_posts` — the planning status stays the user's own claim — and
 * it never touches a publication or a target row, so a figure cannot rewrite a delivery answer.
 *
 * ## Reading is local, refreshing is asked for
 *
 * `read` makes no provider call at all, which is what lets the planner show stored figures the
 * moment a post is opened without any of the card's out-of-scope "refresh on page load" behaviour.
 * `refresh` is the only method that reaches the provider, and only a person's own button press calls
 * it: there is no timer, no schedule, and no background job anywhere in this path.
 */

/**
 * How the analytics connection is behaving: the last sync that got through, the wait in force, and
 * how many refusals in a row.
 *
 * A settings row rather than a table because there is exactly one of it, which is the same reason
 * `sync-health.ts` is one. It is kept *apart* from that record deliberately, and the distinction is
 * the point: `publish_sync_health.lastSyncedAt` answers *are the delivery answers on screen
 * current*, and an analytics sync refreshes none of them. Stamping it here would silence
 * `SYNC_BEHIND` for delivery answers that had gone stale — exactly the failure that record's own
 * documentation refuses for the account-list read. What analytics does share is the **rate limit**:
 * a `429` is a fact about the whole connection whichever endpoint returned it
 * (`docs/publishing-integration.md` §9), so it is written to both.
 *
 * Nothing here is a credential and nothing here is a provider response body: two timestamps, a
 * counter, and one already-redacted sentence.
 */
export const PUBLISH_ANALYTICS_SYNC_KEY = 'publish_analytics_sync';

/** The stored record, or nothing. A row this build cannot parse is treated as absent. */
export function readAnalyticsSync(db: Db): AnalyticsSyncRecord | undefined {
  const raw = getSetting(db, PUBLISH_ANALYTICS_SYNC_KEY);
  if (!raw) return undefined;
  try {
    const stored = JSON.parse(raw) as AnalyticsSyncRecord;
    return {
      ...(typeof stored.lastSyncedAt === 'string' ? { lastSyncedAt: stored.lastSyncedAt } : {}),
      ...(typeof stored.waitingUntil === 'string' ? { waitingUntil: stored.waitingUntil } : {}),
      ...(typeof stored.attempts === 'number' ? { attempts: stored.attempts } : {}),
      ...(typeof stored.reason === 'string' ? { reason: stored.reason } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Replaces the record. Written whole rather than merged: every field is decided per outcome. */
const writeAnalyticsSync = (db: Db, record: AnalyticsSyncRecord): void => {
  setSetting(
    db,
    PUBLISH_ANALYTICS_SYNC_KEY,
    JSON.stringify({
      ...(record.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
      ...(record.waitingUntil ? { waitingUntil: record.waitingUntil } : {}),
      ...(record.attempts ? { attempts: record.attempts } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    }),
  );
};

interface TargetRow {
  publication_id: string;
  provider_account_id: number;
  channel: string;
  handle: string;
  post_result_id: string | null;
  outcome: 'SUCCESS' | 'FAILURE' | null;
  provider: string;
  provider_account_ref: string | null;
}

interface MetricRow {
  publication_id: string;
  provider_account_id: number;
  post_result_id: string;
  analytics_id: string;
  platform: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  share_url: string | null;
  provider_synced_at: string | null;
  synced_at: string;
  /** NULL on a row written before C79, and NULL where the provider sent nothing readable. */
  match_confidence: string | null;
  platform_post_id: string | null;
}

interface DayRow {
  publication_id: string;
  provider_account_id: number;
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
}

/** The key a target, its metric row, and its days all share. */
const keyOf = (publicationId: string, accountId: number) => `${publicationId}:${accountId}`;

export class PublishAnalyticsService {
  private readonly db: Db;
  private readonly provider: AnalyticsProvider;
  private readonly clock: () => Date;
  /**
   * The jitter source for backoff. Injected so the wait after a `429` is a fixed number in a test
   * rather than a coin flip — the algorithm is `shared/publish-analytics.ts`'s, and this is only
   * where the random number comes from.
   */
  private readonly jitter: () => number;
  // Declared and assigned rather than constructor parameter properties: the server runs under
  // `node --experimental-strip-types` (`AGENTS.md` §Conventions).
  constructor(
    db: Db,
    provider: AnalyticsProvider,
    clock: () => Date = () => new Date(),
    jitter: () => number = Math.random,
  ) {
    this.db = db;
    this.provider = provider;
    this.clock = clock;
    this.jitter = jitter;
  }

  /**
   * Every delivery on one post, with whatever figures are stored against it.
   *
   * No provider call, on any path through this method. A target with no stored reading is reported
   * as the state it is actually in — waiting on a result identity, waiting on the provider, or on a
   * platform nobody measures — and never as a total of zero, which is the difference between *we do
   * not know* and *nobody looked*.
   *
   * Ordered newest publication first, then by the order the plan resolved the targets, so the rows
   * read down the page the way the delivery records above them do.
   */
  read(postId: string): PostMetricsSummary {
    const targets = this.db
      .prepare(
        `SELECT t.publication_id, t.provider_account_id, t.channel, t.handle, t.post_result_id, t.outcome,
                p.provider, a.provider_account_ref
           FROM signal_publication_targets t
           JOIN signal_publications p ON p.id = t.publication_id
           LEFT JOIN signal_provider_accounts a ON a.id=t.provider_account_id
          WHERE p.post_id = ?
          ORDER BY p.created_at DESC, p.id, t.rowid`,
      )
      .all(postId) as unknown as TargetRow[];
    const metrics = new Map(
      (
        this.db
          .prepare(
            `SELECT m.* FROM signal_post_metrics m
               JOIN signal_publications p ON p.id = m.publication_id
              WHERE p.post_id = ?`,
          )
          .all(postId) as unknown as MetricRow[]
      ).map((row) => [keyOf(row.publication_id, row.provider_account_id), row]),
    );
    const days = new Map<string, PostMetricDay[]>();
    for (const row of this.db
      .prepare(
        `SELECT d.* FROM signal_post_metric_days d
           JOIN signal_publications p ON p.id = d.publication_id
          WHERE p.post_id = ?
          ORDER BY d.date`,
      )
      .all(postId) as unknown as DayRow[]) {
      const key = keyOf(row.publication_id, row.provider_account_id);
      const list = days.get(key) ?? [];
      list.push({
        date: row.date,
        views: row.views,
        likes: row.likes,
        comments: row.comments,
        shares: row.shares,
      });
      days.set(key, list);
    }
    const record = readAnalyticsSync(this.db);
    return {
      postId,
      targets: targets.map((target) => {
        const key = keyOf(target.publication_id, target.provider_account_id);
        const metric = metrics.get(key);
        const platform = publishPlatformFor(target.channel) ?? null;
        const availability = postMetricAvailability({
          platform,
          ...(target.post_result_id ? { resultId: target.post_result_id } : {}),
          stored: Boolean(metric),
          ...(target.outcome === 'SUCCESS' || target.outcome === 'FAILURE'
            ? { outcome: target.outcome }
            : {}),
        });
        const row: PostTargetMetrics = {
          publicationId: target.publication_id,
          accountId: target.provider_account_id,
          provider: target.provider,
          accountRef: target.provider_account_ref ?? String(target.provider_account_id),
          channel: target.channel as SignalChannel,
          platform,
          handle: target.handle,
          availability,
          ...(target.post_result_id ? { resultId: target.post_result_id } : {}),
          ...(target.outcome === 'SUCCESS' || target.outcome === 'FAILURE'
            ? { outcome: target.outcome }
            : {}),
          days: days.get(key) ?? [],
        };
        // Totals only where a reading is stored, so an absent figure can never be rendered as a
        // zero: the field is missing rather than falsy.
        if (metric && availability === 'AVAILABLE') {
          row.totals = {
            views: metric.views,
            likes: metric.likes,
            comments: metric.comments,
            shares: metric.shares,
          };
          row.syncedAt = metric.synced_at;
          if (metric.provider_synced_at) row.providerSyncedAt = metric.provider_synced_at;
          if (metric.share_url) row.shareUrl = metric.share_url;
          // Provenance, carried only where the provider actually gave it. Assigned rather than
          // defaulted for the same reason `totals` is: a NULL column is the provider having said
          // nothing, and a panel that showed `Exact` for it would be putting words in its mouth.
          if (metric.match_confidence) row.matchConfidence = metric.match_confidence;
          if (metric.platform_post_id) row.platformPostId = metric.platform_post_id;
        }
        return row;
      }),
      ...(record?.lastSyncedAt ? { lastSyncedAt: record.lastSyncedAt } : {}),
      refresh: analyticsRefreshGate(record, this.clock()),
    };
  }

  /**
   * Asks the provider for figures, once, because somebody asked for them.
   *
   * The order is deliberate and each step can decline the next without damaging what is stored:
   *
   * 1. **Which deliveries could be measured at all.** A supported platform and a captured result
   *    identity. None, and the method returns the stored read with a sentence — no provider call is
   *    made for a post nothing measures.
   * 2. **Is a wait in force.** A `429` earlier recorded a deadline, and nothing is retried before it
   *    (§9). The stored figures come back untouched with the wait named.
   * 3. **Sync, then read.** A refusal at either step records the backoff and returns — leaving the
   *    last known good values exactly where they were, which is this card's criterion and the reason
   *    every write below happens after every read has already succeeded.
   * 4. **Store what came back, in one transaction**, for the results the provider actually named. A
   *    result it said nothing about keeps the figures it had; nothing is zeroed and nothing is
   *    deleted.
   */
  async refresh(postId: string): Promise<PostMetricsSummary> {
    const stored = this.read(postId);
    if (!this.provider.available)
      return this.declined(stored, 'Analytics needs POST_BRIDGE_API_KEY.');
    const measurable = stored.targets.filter((target) => postMetricsSyncable(target));
    if (!measurable.length)
      return this.declined(
        stored,
        stored.targets.some((target) => target.availability === 'AWAITING_RESULT')
          ? 'No delivery here has a provider result identity yet. Refresh the delivery first, then ask for figures.'
          : stored.targets.some(
                (target) =>
                  analyticsPlatformSupported(target.platform) && target.outcome === 'FAILURE',
              )
            ? POST_METRIC_FAILED_DELIVERY_DETAIL
            : 'None of this post’s channels is one this provider reports figures for.',
      );
    if (!stored.refresh.allowed) return stored;

    const resultIds = [...new Set(measurable.map((target) => target.resultId as string))];
    let listed: ProviderAnalyticsList;
    try {
      await this.provider.sync();
      listed = await this.provider.list(resultIds);
    } catch (error) {
      return this.refused(stored, error as Error);
    }
    const records = listed.records;

    /**
     * Daily snapshots, read per record and allowed to fail on their own.
     *
     * A history that cannot be read does not cost the totals that were read successfully: the day
     * rows this app already holds stay, and the total is stored. The alternative — failing the whole
     * refresh — would throw away an answer the provider had already given.
     */
    const daysByResult = new Map<string, PostMetricDay[]>();
    for (const record of records) {
      try {
        const days = await this.provider.days(record.analyticsId);
        if (days.length) daysByResult.set(record.postResultId, days);
      } catch {
        // Left alone on purpose. The stored days are the last ones that were read successfully, and
        // saying nothing about them is more honest than replacing them with an empty history.
      }
    }

    const byResult = new Map(records.map((record) => [record.postResultId, record]));
    const timestamp = this.clock().toISOString();
    // The post's own words, for the log entry alone. A read, and the only thing this service ever
    // asks `signal_posts` for — it has no statement anywhere that writes one.
    const caption = (
      (this.db.prepare('SELECT text FROM signal_posts WHERE id=?').get(postId) as
        { text: string } | undefined) ?? { text: postId }
    ).text.slice(0, 80);
    const written = measurable.filter((target) => byResult.has(target.resultId as string));
    transaction(this.db, () => {
      const metric = this.db.prepare(
        `INSERT INTO signal_post_metrics(
           publication_id,provider_account_id,post_result_id,analytics_id,platform,
           views,likes,comments,shares,share_url,provider_synced_at,synced_at,
           match_confidence,platform_post_id
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(publication_id,provider_account_id) DO UPDATE SET
           post_result_id=excluded.post_result_id, analytics_id=excluded.analytics_id,
           platform=excluded.platform, views=excluded.views, likes=excluded.likes,
           comments=excluded.comments, shares=excluded.shares, share_url=excluded.share_url,
           provider_synced_at=excluded.provider_synced_at, synced_at=excluded.synced_at,
           match_confidence=excluded.match_confidence, platform_post_id=excluded.platform_post_id`,
      );
      // A day is inserted or replaced, never cleared first. A provider that returns a shorter
      // history than last time has not withdrawn the days it left out.
      const day = this.db.prepare(
        `INSERT INTO signal_post_metric_days(
           publication_id,provider_account_id,date,views,likes,comments,shares
         ) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(publication_id,provider_account_id,date) DO UPDATE SET
           views=excluded.views, likes=excluded.likes,
           comments=excluded.comments, shares=excluded.shares`,
      );
      for (const target of written) {
        const record = byResult.get(target.resultId as string) as ProviderAnalyticsRecord;
        metric.run(
          target.publicationId,
          target.accountId,
          record.postResultId,
          record.analyticsId,
          record.platform,
          record.views,
          record.likes,
          record.comments,
          record.shares,
          record.shareUrl ?? null,
          record.lastSyncedAt ?? null,
          timestamp,
          // Null rather than an empty string where the provider said nothing, so the column reads
          // as absent and the panel shows nothing at all rather than a blank provenance line.
          record.matchConfidence ?? null,
          record.platformPostId ?? null,
        );
        for (const snapshot of daysByResult.get(record.postResultId) ?? [])
          day.run(
            target.publicationId,
            target.accountId,
            snapshot.date,
            snapshot.views,
            snapshot.likes,
            snapshot.comments,
            snapshot.shares,
          );
      }
      // A successful sync clears the wait and the refusal count: getting an answer is proof the
      // limit has passed, the same rule `sync-health.ts` applies to its own record.
      writeAnalyticsSync(this.db, { lastSyncedAt: timestamp });
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.analytics-sync',
        // Some deliveries measured and some not is the ordinary case rather than a half-finished
        // operation: a post that went out an hour ago has no figures yet. `PARTIAL` is reserved for
        // an operation that asked about deliveries and stored fewer than it asked about.
        outcome: written.length === measurable.length ? 'SUCCESS' : 'PARTIAL',
        // The parser's own warnings ride on the summary, which is where they belong: they are this
        // app's record of a provenance field it refused, and the outcome is still whatever the
        // figures themselves were. A refused field is not a failed refresh — the four counts landed —
        // so it does not change `SUCCESS` into anything, and it is never silent either.
        summary: [
          written.length === measurable.length
            ? `Read figures for ${written.length} ${written.length === 1 ? 'delivery' : 'deliveries'}.`
            : `Read figures for ${written.length} of ${measurable.length} deliveries; the provider had none for the rest yet.`,
          ...listed.warnings,
        ].join(' '),
        entities: [{ type: 'signalPost', id: postId, label: caption }],
      });
    });
    /**
     * Deliberately no `recordSyncHealth({ lastSyncedAt })` here.
     *
     * That value answers *are the delivery answers on screen current*, and this refresh has not
     * looked at a single delivery answer — the same reason the account-list read does not stamp it.
     * Claiming it would silence `SYNC_BEHIND` for submissions still waiting on the provider. A rate
     * limit is the one fact the two records share, and it needs no clearing here: it carries its own
     * deadline and stops applying when the deadline passes.
     */
    return this.read(postId);
  }

  /** The stored read, with a sentence and no provider call. Nothing is written. */
  private declined(stored: PostMetricsSummary, reason: string): PostMetricsSummary {
    return { ...stored, refresh: { ...stored.refresh, allowed: false, reason } };
  }

  /**
   * A refusal, recorded and reported, with every stored figure left where it was.
   *
   * Both kinds of failure land here and they are recorded differently.
   *
   * A **rate limit** earns a wait, and the wait is the longer of two numbers: the `Retry-After` the
   * provider named, and §9's own backoff for this attempt — base 1 s doubling per consecutive
   * refusal, capped at 60 s, with full jitter. Taking the longer honours the provider's figure
   * exactly (waiting longer than asked never breaks a limit) while still growing the gap when the
   * provider keeps refusing, which is what makes the backoff bounded rather than decorative: the
   * vendor's own `429` on this endpoint says only "please wait between syncs", so its stated delay is
   * a floor and not a schedule. It is also written to the shared connection record, because a limit
   * applies to every call this app would make.
   *
   * **Any other failure** names itself and asks for no wait. A network blip is not the provider
   * telling this app to slow down, and locking the button for a minute over one would be this app
   * inventing a limit. The refusal count is carried through untouched — only a sync that gets through
   * resets it, and only a `429` advances it.
   */
  private refused(stored: PostMetricsSummary, error: Error): PostMetricsSummary {
    const now = this.clock();
    const rateLimited = error instanceof PublishProviderError && error.rateLimited;
    const carried = stored.refresh.attempts;
    const message = redactSecrets(error.message);
    if (!rateLimited) {
      const reason = `The provider could not be read, so the figures below are the last ones it gave: ${message}`;
      writeAnalyticsSync(this.db, {
        ...(stored.lastSyncedAt ? { lastSyncedAt: stored.lastSyncedAt } : {}),
        ...(carried ? { attempts: carried } : {}),
        reason,
      });
      return { ...stored, refresh: { ...stored.refresh, allowed: false, reason } };
    }
    const attempts = carried + 1;
    const backoff = analyticsBackoffSeconds(attempts, this.jitter());
    const seconds = Math.max(backoff, error.retryAfterSeconds ?? 0);
    const waitingUntil = new Date(now.getTime() + seconds * 1000).toISOString();
    const reason = `The provider is rate-limiting synchronisations. Nothing is retried before ${waitingUntil}, and the figures below are the last ones it gave.`;
    writeAnalyticsSync(this.db, {
      ...(stored.lastSyncedAt ? { lastSyncedAt: stored.lastSyncedAt } : {}),
      waitingUntil,
      attempts,
      reason,
    });
    recordSyncHealth(this.db, { rateLimitedUntil: waitingUntil });
    const refresh: AnalyticsRefreshState = {
      allowed: false,
      attempts,
      exhausted: attempts >= ANALYTICS_BACKOFF_MAX_ATTEMPTS,
      waitingUntil,
      retryAfterSeconds: seconds,
      reason,
    };
    return { ...stored, refresh };
  }
}
