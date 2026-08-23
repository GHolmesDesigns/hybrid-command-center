import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { recordIntegrationEvent, redactSecrets } from '../integration-log.ts';
import { ANALYTICS_PLATFORMS, type AnalyticsPlatform } from '../../shared/publish-analytics.ts';
import {
  analyticsWindowsOffered,
  analyticsWindowMeaning,
  ANALYTICS_WINDOWS,
  analyticsWindowVerified,
  ANALYTICS_WINDOW_FIXTURE_DETAIL,
  ANALYTICS_WINDOW_PAGE_MAX,
  ANALYTICS_WINDOW_PAGE_SIZE,
  ANALYTICS_WINDOW_ROW_MAX,
  ANALYTICS_WINDOW_UNVERIFIED_DETAIL,
  summariseAnalyticsWindow,
  type AnalyticsWindow,
  type AnalyticsWindowRow,
  type AnalyticsWindowSnapshot,
} from '../../shared/publish-analytics-window.ts';
import { PublishProviderError, PUBLISH_RATE_LIMIT_FALLBACK_SECONDS } from './provider.ts';
import type { AnalyticsWindowProvider } from './analytics-window-provider.ts';
import { readAnalyticsWindowDeliveries, readAnalyticsWindowRows } from './analytics-window-rows.ts';
import { readSyncHealth, recordSyncHealth } from './sync-health.ts';

/**
 * A provider-filtered window of figures: read on request, stored as one generation, added up once.
 *
 * ## The one thing this service guarantees
 *
 * **Every page is read before anything is written.** The walk accumulates rows in memory; only a walk
 * that reached the provider's own end-of-list marker writes anything at all, and when it does it
 * replaces the whole `(platform, timeframe)` generation in one transaction. A refusal, a malformed
 * page, a token that does not advance, or a safety bound leaves every prior row exactly where it was
 * and records the failure. There is no mixed-generation window.
 *
 * That is also why the outcome vocabulary is only `SUCCESS` or `FAILURE`. `PARTIAL` means *some of it
 * landed*, and by construction none of it can. A row the provider named that no local delivery claims
 * is **not** a partial failure either — it is structurally valid, it is stored, and it is counted as
 * unmapped, which is information rather than a fault.
 *
 * ## It cannot spend a synchronisation, and it cannot touch the per-delivery figures
 *
 * The provider it holds has one method and that method lists (`analytics-window-provider.ts`), so
 * there is no `sync` on this path — opening or switching a window cannot ask the provider to refresh
 * its own copy, which is the card's own out-of-scope item. Locally it writes
 * `signal_analytics_window_metrics`, its own settings row, and one `integration_events` row per
 * attempt. It never writes `signal_post_metrics`, `signal_post_metric_days`, a post, a publication, a
 * target, or a planning status: the per-delivery figures answer a different question and stay exactly
 * as the per-post refresh left them.
 *
 * ## Only when a person presses something, and only for a window somebody has verified
 *
 * `read` makes no provider call on any path. `refresh` is reached only from the route a button calls,
 * and it refuses outright unless `ANALYTICS_WINDOW_EVIDENCE` carries a dated result for the window
 * being asked about. Today it carries none — §14's four analytics rows are unverified and each says
 * *"C80 stays blocked"* — so the refusal is the live behaviour and the walk below is exercised by
 * fixtures. That is deliberate: the machinery is testable now, and the eventual dated result is one
 * table entry rather than a card.
 */

/**
 * The record of the last attempt per platform and window: when a complete read last replaced the
 * generation, and why the most recent one did not.
 *
 * One settings row holding a small map rather than a row per window, for the reason
 * `PROVIDER_INVENTORY_KEY` is one row: there is exactly one of this fact per window and the set of
 * windows is fixed and tiny. It is deliberately *not* a metrics row and cannot become one — it holds
 * no provider figure, so writing it on a failed refresh cannot produce a mixed generation.
 *
 * It also carries the one thing the rows cannot: a complete read that returned *nothing* replaces the
 * previous generation with no rows at all, and without this record that outcome would be
 * indistinguishable from never having refreshed. Nothing here is a credential and nothing here is a
 * provider response body — one timestamp and one already-redacted sentence.
 */
export const ANALYTICS_WINDOW_KEY = 'signal_analytics_window';

interface StoredWindowRecord {
  lastRefreshAt?: string;
  reason?: string;
}

const recordKey = (platform: AnalyticsPlatform, timeframe: AnalyticsWindow): string =>
  `${platform}|${timeframe}`;

/** The stored records, or nothing. A row this build cannot parse is treated as absent. */
function readWindowRecords(db: Db): Record<string, StoredWindowRecord> {
  const raw = getSetting(db, ANALYTICS_WINDOW_KEY);
  if (!raw) return {};
  try {
    const stored = JSON.parse(raw) as Record<string, StoredWindowRecord>;
    return stored && typeof stored === 'object' ? stored : {};
  } catch {
    return {};
  }
}

function writeWindowRecord(
  db: Db,
  platform: AnalyticsPlatform,
  timeframe: AnalyticsWindow,
  record: StoredWindowRecord,
): void {
  const all = readWindowRecords(db);
  all[recordKey(platform, timeframe)] = {
    ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
  setSetting(db, ANALYTICS_WINDOW_KEY, JSON.stringify(all));
}

/**
 * Which platform and which window, validated at the boundary.
 *
 * Both required, and both enumerated against the vendor's own documented values — a platform outside
 * `tiktok | youtube | instagram` is not a platform this provider measures, and a window outside
 * `7d | 30d | 90d | all` is a parameter the endpoint does not take. Neither is defaulted: a request
 * that did not say which window it meant would get an answer labelled with a window it never asked
 * for, and the selection is the one thing a reader has to be sure of here.
 *
 * Passing this schema is not permission to *ask the provider* — `AnalyticsWindowService.refresh`
 * still refuses a window with no dated §14 result. This says only that the request named a real
 * platform and a real window.
 */
export const analyticsWindowQuery = z.object({
  platform: z.enum(ANALYTICS_PLATFORMS),
  timeframe: z.enum(ANALYTICS_WINDOWS),
});

/** What a walk that could not finish has to say for itself. */
class AnalyticsWindowReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsWindowReadError';
  }
}

export class AnalyticsWindowService {
  private readonly db: Db;
  private readonly provider: AnalyticsWindowProvider;
  private readonly clock: () => Date;
  /**
   * The windows this instance may offer and refresh.
   *
   * Defaults to `analyticsWindowsOffered()` — the §14 evidence table, which today yields none — and is
   * a constructor argument for exactly one reason: a fixture and the end-to-end run need to drive the
   * walk, the replacement, the unmapped count, and the failure path, and none of those is reachable
   * while every window is unverified. It is the same test-only seam `options.analytics` already is:
   * a mock provider stands in for the vendor, and this stands in for the dated result that would let
   * the app ask it something.
   *
   * Production passes nothing. Nothing in `server/` outside `app.ts` supplies it, and `app.ts` takes
   * it only from its own test-only options, so no runtime path can widen what the app claims.
   */
  private readonly offered: readonly AnalyticsWindow[];
  // Declared and assigned rather than constructor parameter properties: the server runs under
  // `node --experimental-strip-types` (`AGENTS.md` §Conventions).
  constructor(
    db: Db,
    provider: AnalyticsWindowProvider,
    clock: () => Date = () => new Date(),
    offered: readonly AnalyticsWindow[] = analyticsWindowsOffered(),
  ) {
    this.db = db;
    this.provider = provider;
    this.clock = clock;
    this.offered = offered;
  }

  /** Whether this instance may ask about the window, and describe what came back. */
  private verified(timeframe: AnalyticsWindow): boolean {
    return this.offered.includes(timeframe);
  }

  /**
   * What this window selects, for the three cases that exist.
   *
   * A window the evidence table verifies carries the meaning that table recorded. A window only this
   * instance offers carries the fixture sentence, so a test seam can never present itself as a dated
   * result. Anything else carries the unverified sentence, which is what a person sees today.
   */
  private meaningFor(timeframe: AnalyticsWindow): string {
    if (analyticsWindowVerified(timeframe)) return analyticsWindowMeaning(timeframe);
    return this.verified(timeframe)
      ? ANALYTICS_WINDOW_FIXTURE_DETAIL
      : ANALYTICS_WINDOW_UNVERIFIED_DETAIL;
  }

  /**
   * The stored window. No provider call on any path through this method.
   *
   * Which is what lets the panel show what the provider last said the moment it opens, without a page
   * load ever spending a provider request or an `analytics/sync`. Switching platform or window comes
   * back through here and is equally local.
   */
  read(platform: AnalyticsPlatform, timeframe: AnalyticsWindow): AnalyticsWindowSnapshot {
    const rows = readAnalyticsWindowRows(this.db, platform, timeframe);
    const { groups, unmapped } = summariseAnalyticsWindow({
      platform,
      window: timeframe,
      rows,
      deliveries: readAnalyticsWindowDeliveries(this.db, platform),
    });
    const record = readWindowRecords(this.db)[recordKey(platform, timeframe)] ?? {};
    return {
      available: this.provider.available,
      windows: [...this.offered],
      platform,
      window: timeframe,
      verified: this.verified(timeframe),
      meaning: this.meaningFor(timeframe),
      groups,
      unmapped,
      counts: {
        rows: rows.length,
        mapped: rows.length - unmapped.length,
        unmapped: unmapped.length,
      },
      ...(record.lastRefreshAt ? { lastRefreshAt: record.lastRefreshAt } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
    };
  }

  /**
   * Reads every page, then replaces this platform and window — or replaces nothing and says why.
   *
   * The three refusals that happen *before* any provider call are not attempts and write no event: an
   * unconfigured provider was never asked, an unverified window must not be asked (there would be no
   * honest way to label the answer), and a rate limit in force means §9 forbids asking
   * (`docs/publishing-integration.md`). Every attempt that does reach the provider writes exactly one
   * `SUCCESS` or `FAILURE` event.
   */
  async refresh(
    platform: AnalyticsPlatform,
    timeframe: AnalyticsWindow,
  ): Promise<AnalyticsWindowSnapshot> {
    const stored = this.read(platform, timeframe);
    if (!this.provider.available)
      return { ...stored, reason: 'The provider analytics window needs POST_BRIDGE_API_KEY.' };
    // The §14 gate, and the reason this card can ship while its evidence rows stay open. Asking the
    // provider would return rows this app has no verified way to describe, and storing them under a
    // window label would be the app asserting the semantics the probe has not observed.
    if (!this.verified(timeframe)) return { ...stored, reason: this.meaningFor(timeframe) };
    const waiting = readSyncHealth(this.db)?.rateLimitedUntil;
    if (waiting && Date.parse(waiting) > this.clock().getTime())
      return {
        ...stored,
        reason: `The provider is rate-limiting this app until ${waiting}. Nothing is asked before then, so the figures below are the last ones it gave.`,
      };

    let read: { rows: AnalyticsWindowRow[]; warnings: string[] };
    try {
      read = await this.walk(platform, timeframe);
    } catch (error) {
      return this.failed(platform, timeframe, error as Error);
    }
    return this.replace(platform, timeframe, read.rows, read.warnings);
  }

  /**
   * Every page, in order, with the bounds that make the walk finite.
   *
   * Four ways it stops without a window, and each of them throws rather than returning what it has:
   * the provider refuses a page, a page cannot be read, `meta.next` is a shape nobody has verified, or
   * the next token does not advance past the one just read — which is what a repeated cursor looks
   * like from here. The page and row bounds are the backstop for a provider that keeps answering with
   * a fresh token for ever.
   *
   * Rows are keyed by the provider's result id as they arrive, so a row that shifts between pages
   * while the walk is running is one row rather than two, and the last page to mention it wins. That
   * key is also the primary key's tail, so the walk cannot hand the replacement two rows that would
   * collide inside its own transaction.
   */
  private async walk(
    platform: AnalyticsPlatform,
    timeframe: AnalyticsWindow,
  ): Promise<{ rows: AnalyticsWindowRow[]; warnings: string[] }> {
    const rows = new Map<string, AnalyticsWindowRow>();
    const warnings: string[] = [];
    // Starts at the first page and is always sent, which is what makes the repeated-token refusal
    // below catch a provider that answers page one with a token pointing back at page one. §14's
    // question 4 verified this contract as an offset, and zero is where an offset walk begins.
    let pageToken = 0;
    for (let page = 1; page <= ANALYTICS_WINDOW_PAGE_MAX; page += 1) {
      const answer = await this.provider.listWindow({ platform, timeframe, pageToken });
      for (const row of answer.rows) rows.set(row.postResultId, row);
      warnings.push(...answer.warnings);
      if (rows.size > ANALYTICS_WINDOW_ROW_MAX)
        throw new AnalyticsWindowReadError(
          `The provider listed more than ${ANALYTICS_WINDOW_ROW_MAX} rows for this window, which is past the safety bound for one read.`,
        );
      const next = answer.next;
      if ('done' in next) return { rows: [...rows.values()], warnings };
      if ('unknown' in next)
        throw new AnalyticsWindowReadError(
          next.unknown === 'META'
            ? 'The provider answered a page without the pagination envelope this app reads.'
            : 'The provider answered with a next-page token this app has not verified, so the rest of the window was not guessed at.',
        );
      if (next.offset <= pageToken)
        throw new AnalyticsWindowReadError(
          `The provider's next page did not advance past offset ${pageToken}, so the walk was stopped rather than repeated.`,
        );
      pageToken = next.offset;
    }
    throw new AnalyticsWindowReadError(
      `The provider was still listing rows after ${ANALYTICS_WINDOW_PAGE_MAX} pages of ${ANALYTICS_WINDOW_PAGE_SIZE}, so the read was stopped at its safety bound.`,
    );
  }

  /**
   * The generation replaced, in one transaction: this platform and window emptied, the rows the
   * provider named inserted, the record stamped, and one `SUCCESS` event written.
   *
   * A delete-then-insert over the `(platform, timeframe)` prefix rather than an upsert-and-difference,
   * which is the opposite of what `ProviderInventoryService` does and for a stated reason: an
   * inventory row's absence means *the provider deleted that post*, a fact worth expressing as a
   * deletion, whereas a window row's absence means only *the provider did not name that delivery in
   * this window this time*. There is nothing to preserve across generations here, so replacing the set
   * outright is both simpler and truer to what a window is.
   *
   * A refused provenance field rides along in the summary rather than downgrading the outcome: four
   * counts the platform did report are still the answer, and the reason this app would not store a
   * fifth field belongs in the log beside them.
   */
  private replace(
    platform: AnalyticsPlatform,
    timeframe: AnalyticsWindow,
    rows: AnalyticsWindowRow[],
    warnings: string[],
  ): AnalyticsWindowSnapshot {
    const refreshedAt = this.clock().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM signal_analytics_window_metrics WHERE platform=? AND timeframe=?')
        .run(platform, timeframe);
      const insert = this.db.prepare(
        `INSERT INTO signal_analytics_window_metrics(
           platform,timeframe,post_result_id,analytics_id,row_platform,
           views,likes,comments,shares,provider_synced_at,match_confidence,platform_post_id,refreshed_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const row of rows)
        insert.run(
          platform,
          timeframe,
          row.postResultId,
          row.analyticsId,
          row.platform,
          row.views,
          row.likes,
          row.comments,
          row.shares,
          row.providerSyncedAt ?? null,
          row.matchConfidence ?? null,
          row.platformPostId ?? null,
          refreshedAt,
        );
      writeWindowRecord(this.db, platform, timeframe, { lastRefreshAt: refreshedAt });
      const summary = this.read(platform, timeframe);
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.analytics-window-refresh',
        outcome: 'SUCCESS',
        summary: `Read the whole ${timeframe} window for ${platform}: ${rows.length} ${
          rows.length === 1 ? 'row' : 'rows'
        }, ${summary.counts.unmapped} of them matching no delivery here.${
          warnings.length ? ` ${warnings.join(' ')}` : ''
        }`,
      });
    });
    return this.read(platform, timeframe);
  }

  /**
   * A failed read: nothing replaced, one `FAILURE` event, and the reason on screen.
   *
   * A rate limit is also written to the shared connection record, because a `429` is a fact about the
   * whole connection whichever endpoint returned it (`docs/publishing-integration.md` §9) — the same
   * rule the figures and inventory paths follow. Nothing else about the connection is touched: this
   * read synchronised no delivery answer, so it has no business stamping `lastSyncedAt`.
   */
  private failed(
    platform: AnalyticsPlatform,
    timeframe: AnalyticsWindow,
    error: Error,
  ): AnalyticsWindowSnapshot {
    const rateLimited = error instanceof PublishProviderError && error.rateLimited;
    const message = redactSecrets(error.message);
    const reason = `The ${timeframe} window for ${platform} could not be read, so nothing was replaced: ${message}`;
    const stored = readWindowRecords(this.db)[recordKey(platform, timeframe)] ?? {};
    transaction(this.db, () => {
      writeWindowRecord(this.db, platform, timeframe, {
        ...(stored.lastRefreshAt ? { lastRefreshAt: stored.lastRefreshAt } : {}),
        reason,
      });
      if (rateLimited) {
        const seconds =
          (error as PublishProviderError).retryAfterSeconds ?? PUBLISH_RATE_LIMIT_FALLBACK_SECONDS;
        recordSyncHealth(this.db, {
          rateLimitedUntil: new Date(this.clock().getTime() + seconds * 1000).toISOString(),
        });
      }
      recordIntegrationEvent(this.db, {
        source: 'signal-campaign',
        operation: 'signal.analytics-window-refresh',
        outcome: 'FAILURE',
        summary: `The ${timeframe} window for ${platform} could not be read; no stored row was replaced.`,
        error: message,
      });
    });
    return this.read(platform, timeframe);
  }
}
