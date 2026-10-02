/**
 * The Ads performance refresh (C258): one complete, bounded snapshot of campaign metadata and the
 * latest 90 account-local days of the provider's own figures, for approved accounts only.
 *
 * The order of events is the whole safety property, and it is `server/publish/inventory.ts`'s:
 *
 * 1. **Every read completes first.** Each approved account is read for its metadata, its campaigns,
 *    and its dated metrics, one SearchStream call apiece, under a request ceiling, a row ceiling
 *    and a response-size ceiling. Nothing is written while any of that is still going.
 * 2. **Every row is checked.** A row for another account, an unknown campaign, a date outside the
 *    window, a repeat of an identity, or a shape the schemas refuse fails the refresh. Nothing is
 *    repaired and nothing is skipped.
 * 3. **One transaction replaces the provider-owned rows** — accounts' metadata, campaigns, days and
 *    windows — under one UTC `snapshot_at`, with the success event and the last-sync record in it.
 *
 * A failure at any step leaves the previous generation byte-for-byte where it was. Its record is
 * written afterwards in a transaction of its own, so it survives the rollback it describes.
 *
 * What this never touches: approval, the client mapping, the encrypted token, Drive, Signal, and
 * anything at the provider. It computes no rate or total — the four numbers are stored as reported.
 * It runs only when a person asks; no page read and no timer reaches it.
 */
import {
  ADS_SYNC_LIMITS,
  ADS_SYNC_MAX_REQUESTS,
  ADS_TARGET_ISSUE_MESSAGE,
  adsCampaignDaySchema,
  adsCampaignSnapshotSchema,
  adsSyncWindow,
  adsTargetIssue,
  type AdsAccountSnapshot,
  type AdsCampaignDay,
  type AdsCampaignSnapshot,
  type AdsSyncResult,
  type AdsSyncWindow,
} from '../../shared/ads.ts';
import type { config } from '../config.ts';
import { transaction, type Db } from '../db.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import { isAdsConnected, readConnectedAdsRefreshToken } from './connection.ts';
import { AdsAccountError } from './errors.ts';
import type { AdsProvider } from './provider.ts';

type AdsConfig = typeof config.ads;

const NOT_CONNECTED =
  'Google Ads is not connected, so nothing was read. Connect it in Settings first.';

/** One refresh at a time: a second press while one is reading would double the quota it spends. */
let refreshing = false;

interface AccountRead {
  snapshot: AdsAccountSnapshot;
  window: AdsSyncWindow;
  campaigns: AdsCampaignSnapshot[];
  days: AdsCampaignDay[];
}

/** Counts every Ads call and refuses the one past the ceiling, so a loop cannot spend the day. */
function budgeted(provider: AdsProvider) {
  let used = 0;
  const spend = () => {
    used += 1;
    if (used > ADS_SYNC_MAX_REQUESTS)
      throw new Error('the request budget for one refresh is spent');
  };
  return {
    readAccount: (...args: Parameters<AdsProvider['readAccount']>) => {
      spend();
      return provider.readAccount(...args);
    },
    readCampaigns: (...args: Parameters<AdsProvider['readCampaigns']>) => {
      spend();
      return provider.readCampaigns(...args);
    },
    readCampaignDays: (...args: Parameters<AdsProvider['readCampaignDays']>) => {
      spend();
      return provider.readCampaignDays(...args);
    },
  };
}

async function readAccountPerformance(
  reads: ReturnType<typeof budgeted>,
  accessToken: string,
  customerId: string,
  now: Date,
  loginCustomerId: string | undefined,
): Promise<AccountRead> {
  const options = { loginCustomerId };
  const snapshot = await reads.readAccount(accessToken, customerId, options);
  if (snapshot.customerId !== customerId)
    throw new Error(`account ${customerId}: the provider answered for a different account`);
  // The account was approved as an enabled serving account; one that has since stopped being one is
  // not read for figures, and the refusal says why rather than storing a half-reason.
  const issue = adsTargetIssue(snapshot);
  if (issue) throw new Error(`account ${customerId}: ${ADS_TARGET_ISSUE_MESSAGE[issue]}`);

  const window = adsSyncWindow(now, snapshot.timeZone);
  const rawCampaigns = await reads.readCampaigns(accessToken, customerId, options);
  if (rawCampaigns.length > ADS_SYNC_LIMITS.campaignsPerAccount)
    throw new Error(`account ${customerId}: more campaigns than one refresh holds`);
  const campaigns: AdsCampaignSnapshot[] = [];
  const known = new Set<string>();
  for (const raw of rawCampaigns) {
    const campaign = adsCampaignSnapshotSchema.parse(raw);
    if (campaign.customerId !== customerId)
      throw new Error(`account ${customerId}: a campaign row belongs to another account`);
    if (known.has(campaign.campaignId))
      throw new Error(`account ${customerId}: a campaign was listed twice`);
    known.add(campaign.campaignId);
    campaigns.push(campaign);
  }

  const rawDays = await reads.readCampaignDays(accessToken, customerId, window, options);
  if (rawDays.length > ADS_SYNC_LIMITS.dayRowsPerAccount)
    throw new Error(`account ${customerId}: more daily rows than one refresh holds`);
  const days: AdsCampaignDay[] = [];
  const seen = new Set<string>();
  for (const raw of rawDays) {
    const day = adsCampaignDaySchema.parse(raw);
    if (day.customerId !== customerId)
      throw new Error(`account ${customerId}: a daily row belongs to another account`);
    if (!known.has(day.campaignId))
      throw new Error(`account ${customerId}: a daily row names a campaign that was not listed`);
    // ISO dates compare as strings, so this is the window check with no instant in it.
    if (day.date < window.startDate || day.date > window.endDate)
      throw new Error(`account ${customerId}: a daily row falls outside the requested window`);
    const key = `${day.campaignId}|${day.date}`;
    if (seen.has(key)) throw new Error(`account ${customerId}: a campaign day was reported twice`);
    seen.add(key);
    days.push(day);
  }
  return { snapshot, window, campaigns, days };
}

/**
 * Reads every approved account the grant still reaches, then replaces the stored snapshot whole.
 * Resolves with what was stored; rejects with an {@link AdsAccountError} and leaves the previous
 * generation exactly as it was.
 */
export async function refreshAdsPerformance(
  db: Db,
  input: { provider: AdsProvider; ads: AdsConfig; now: Date },
): Promise<AdsSyncResult> {
  if (!isAdsConnected(db)) throw new AdsAccountError(NOT_CONNECTED, 409);
  if (refreshing)
    throw new AdsAccountError(
      'A Google Ads refresh is already running. Wait for it to finish.',
      409,
    );

  const approved = db
    .prepare(
      `SELECT s.customer_id id, d.customer_id discovered
         FROM ads_account_settings s LEFT JOIN ads_discovered_accounts d ON d.customer_id = s.customer_id
         WHERE s.approved = 1 ORDER BY s.customer_id`,
    )
    .all() as { id: string; discovered: string | null }[];
  // An approved account the grant no longer reaches keeps its snapshot, visibly stale, and is not
  // read: that is the stale rule from account selection, applied here rather than failing the rest.
  const targets = approved.filter((row) => row.discovered !== null).map((row) => row.id);
  const skipped = approved.length - targets.length;
  if (targets.length === 0)
    throw new AdsAccountError(
      approved.length === 0
        ? 'No account is approved, so there is nothing to refresh. Approve an account first.'
        : 'The connected Google account no longer reaches any approved account, so nothing was read.',
      409,
    );

  refreshing = true;
  const stamp = input.now.toISOString();
  try {
    if (targets.length > ADS_SYNC_LIMITS.accounts)
      throw new Error('more approved accounts than one refresh may read');
    const refreshToken = readConnectedAdsRefreshToken(db, input.ads);
    if (!refreshToken) throw new Error('the stored Google Ads credential cannot be read');
    const accessToken = await input.provider.accessToken(refreshToken);
    const reads = budgeted(input.provider);

    const results: AccountRead[] = [];
    for (const customerId of targets)
      results.push(
        await readAccountPerformance(
          reads,
          accessToken,
          customerId,
          input.now,
          input.ads.loginCustomerId || undefined,
        ),
      );

    return transaction(db, () => {
      if (!isAdsConnected(db)) throw new Error('Google Ads was disconnected during the refresh');
      const stillApproved = db.prepare(
        'SELECT 1 FROM ads_account_settings WHERE customer_id = ? AND approved = 1',
      );
      let campaignTotal = 0;
      let dayTotal = 0;
      for (const read of results) {
        const { snapshot, window, campaigns, days } = read;
        const id = snapshot.customerId;
        if (!stillApproved.get(id))
          throw new Error(`account ${id}: approval changed during the refresh`);
        // Upsert, never delete-and-insert: an account row is referenced by cascade.
        db.prepare(
          `INSERT INTO ads_accounts(customer_id,descriptive_name,currency_code,time_zone,manager,status,snapshot_at)
           VALUES(?,?,?,?,?,?,?)
           ON CONFLICT(customer_id) DO UPDATE SET descriptive_name=excluded.descriptive_name,
             currency_code=excluded.currency_code, time_zone=excluded.time_zone,
             manager=excluded.manager, status=excluded.status, snapshot_at=excluded.snapshot_at`,
        ).run(
          id,
          snapshot.descriptiveName,
          snapshot.currencyCode,
          snapshot.timeZone,
          snapshot.manager ? 1 : 0,
          snapshot.status,
          stamp,
        );
        // The window is replaced whole: out-of-window days go with the rest, and the in-window ones
        // are written again from this generation.
        db.prepare('DELETE FROM ads_campaign_days WHERE customer_id = ?').run(id);
        const listed = new Set(campaigns.map((campaign) => campaign.campaignId));
        for (const row of db
          .prepare('SELECT campaign_id FROM ads_campaigns WHERE customer_id = ?')
          .all(id) as { campaign_id: string }[])
          if (!listed.has(row.campaign_id))
            db.prepare('DELETE FROM ads_campaigns WHERE customer_id = ? AND campaign_id = ?').run(
              id,
              row.campaign_id,
            );
        const upsertCampaign = db.prepare(
          `INSERT INTO ads_campaigns(customer_id,campaign_id,name,status,channel_type,snapshot_at)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(customer_id,campaign_id) DO UPDATE SET name=excluded.name,
             status=excluded.status, channel_type=excluded.channel_type, snapshot_at=excluded.snapshot_at`,
        );
        for (const campaign of campaigns)
          upsertCampaign.run(
            id,
            campaign.campaignId,
            campaign.name,
            campaign.status,
            campaign.channelType,
            stamp,
          );
        const insertDay = db.prepare(
          `INSERT INTO ads_campaign_days(customer_id,campaign_id,date,impressions,clicks,cost_micros,conversions)
           VALUES(?,?,?,?,?,?,?)`,
        );
        for (const day of days)
          insertDay.run(
            id,
            day.campaignId,
            day.date,
            day.impressions,
            day.clicks,
            day.costMicros,
            day.conversions,
          );
        db.prepare(
          `INSERT INTO ads_sync_windows(customer_id,window_start,window_end,synced_at) VALUES(?,?,?,?)
           ON CONFLICT(customer_id) DO UPDATE SET window_start=excluded.window_start,
             window_end=excluded.window_end, synced_at=excluded.synced_at`,
        ).run(id, window.startDate, window.endDate, stamp);
        campaignTotal += campaigns.length;
        dayTotal += days.length;
      }
      db.prepare(
        `UPDATE ads_connection SET last_sync_at=?, last_sync_outcome='SUCCESS', last_sync_error=NULL
         WHERE id='google-ads'`,
      ).run(stamp);
      recordIntegrationEvent(db, {
        source: 'google-ads',
        operation: 'ads.sync',
        outcome: 'SUCCESS',
        summary: `Refreshed ${results.length} ${results.length === 1 ? 'account' : 'accounts'}: ${campaignTotal} campaigns and ${dayTotal} reported days.${skipped ? ` ${skipped} approved ${skipped === 1 ? 'account was' : 'accounts were'} not reached and left as they were.` : ''}`,
        entities: results.map((read) => ({
          type: 'adsAccount' as const,
          id: read.snapshot.customerId,
          label: read.snapshot.descriptiveName,
        })),
      });
      return {
        syncedAt: stamp,
        accounts: results.length,
        campaigns: campaignTotal,
        days: dayTotal,
        skipped,
      };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown failure';
    // The data transaction has rolled back by now. This one records only that the attempt failed.
    transaction(db, () => {
      const event = recordIntegrationEvent(db, {
        source: 'google-ads',
        operation: 'ads.sync',
        outcome: 'FAILURE',
        summary: 'Google Ads performance was not refreshed. The previous snapshot is unchanged.',
        error: reason,
      });
      db.prepare(
        `UPDATE ads_connection SET last_sync_at=?, last_sync_outcome='FAILURE', last_sync_error=?
         WHERE id='google-ads'`,
      ).run(stamp, event.error ?? null);
    });
    throw new AdsAccountError(
      'Google Ads did not complete the refresh, so the previous snapshot is unchanged.',
      502,
    );
  } finally {
    refreshing = false;
  }
}
