import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import {
  attachAgentHubWebSocket,
  type AgentHubLiveHub,
  type AgentHubWsAuth,
} from '../server/agent-hub/ws.ts';
import type { AgentHubTipRegistry } from '../server/agent-hub/tips.ts';
import { config } from '../server/config.ts';
import { getDb } from '../server/db.ts';
import { resetE2eDatabase } from './database.ts';
import { e2eWebOrigin, handleE2eResetAdsRequest, handleE2eStopRequest } from './endpoints.ts';
import { stopWhenTheRunEnds } from './shutdown.ts';
import {
  MockAnalyticsProvider,
  MockAnalyticsWindowProvider,
  MockProviderInventoryProvider,
  MockPublishProvider,
  MockBufferReadProvider,
  MockBufferWriteProvider,
} from '../server/publish/mock-provider.ts';
import { MockDriveMediaProvider } from '../server/drive/mock-provider.ts';
import { MockAdsOAuthClient } from '../server/ads/mock-oauth.ts';
import { MockAdsProvider } from '../server/ads/mock-provider.ts';
import { adsSyncWindow } from '../shared/ads.ts';

const databasePath = resetE2eDatabase();
console.log(`Reset E2E database at ${databasePath}`);

// Opened after the reset above, never at import time, so every run starts from an empty file.
// The listener is owned here rather than by `server/index.ts` so that shutdown has something
// to close; the production static-file branch in that module is not wanted anyway, since Vite
// serves the client during E2E.
const db = getDb();
const driveMedia = new MockDriveMediaProvider();
driveMedia.seed('1AbCdEfGhIjKlMnOpQrStUvWxYz012345', {
  name: 'e2e-drive-image.png',
  size: '4',
});
driveMedia.seedBody('1AbCdEfGhIjKlMnOpQrStUvWxYz012345', new Uint8Array([137, 80, 78, 71]));
// The LinkedIn document post: the one media role the live probe verified (C76). A PDF plus the
// existing document-title override, rather than a role row of its own.
driveMedia.seed('2PdFeFgHiJkLmNoPqRsTuVwXyZ0123456', {
  name: 'e2e-drive-report.pdf',
  mimeType: 'application/pdf',
  size: '5',
});
driveMedia.seedBody('2PdFeFgHiJkLmNoPqRsTuVwXyZ0123456', new Uint8Array([37, 80, 68, 70, 45]));
// And a still image for a variant media role, which is stored, version-bound, and — until the
// provider role is verified — deliberately not sent.
driveMedia.seed('3CoVeRgHiJkLmNoPqRsTuVwXyZ0123456', {
  name: 'e2e-drive-cover.png',
  mimeType: 'image/png',
  size: '4',
});
driveMedia.seedBody('3CoVeRgHiJkLmNoPqRsTuVwXyZ0123456', new Uint8Array([137, 80, 78, 71]));

// One account per platform, which is what target resolution requires and what makes a
// per-account override deliverable as its platform's configuration.
const publish = new MockPublishProvider([
  { id: 901, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' },
  { id: 902, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: 903, platform: 'linkedin', handle: '@gholmes-designs', name: 'G.Holmes Designs' },
  // TikTok is here because it is one of the three platforms the provider reports figures for, and a
  // figure needs a delivery to belong to.
  { id: 904, platform: 'tiktok', handle: '@gholmes', name: 'G.Holmes Designs' },
  // YouTube is here for the one platform Post Bridge names a thumbnail role for: a role needs a
  // resolved account before the composer can offer it.
  { id: 905, platform: 'youtube', handle: '@gholmesdesigns', name: 'G.Holmes Designs' },
  // A second Facebook page, so C77's two-account case has a same-platform pair to choose between.
  // Named differently on purpose: §3.1's rule still resolves G.Holmes Designs uniquely for every
  // post that makes no explicit choice, so the specs written before C77 are unaffected by it.
  { id: 906, platform: 'facebook', handle: 'wildeyephoto', name: 'Wild Eye Photography' },
]);
/**
 * What a check reports, set here rather than left to the submission.
 *
 * A delivery only has a provider result identity once the provider has tried to deliver it, so this
 * is what lets an end-to-end run reach the figures at all: the delivery check captures the id, and
 * the figures refresh asks about it. The state stays `SUBMITTED` so specs that still need Compare /
 * Refresh delivery after submit keep those controls; only the per-target result id is filled in.
 */
publish.checkResult = {
  providerPostId: 'mock-publication',
  state: 'SUBMITTED',
  targets: [{ accountId: 904, outcome: 'SUCCESS', resultId: 'e2e-result-tt' }],
};

const analytics = new MockAnalyticsProvider();
analytics.records = [
  {
    analyticsId: 'e2e-analytics-tt',
    postResultId: 'e2e-result-tt',
    platform: 'tiktok',
    views: 4210,
    likes: 318,
    comments: 24,
    shares: 61,
    lastSyncedAt: '2099-09-15T11:00:00.000Z',
    shareUrl: 'https://tiktok.example/video/e2e',
    // C79's provenance, so the browser proves the panel says how the provider matched the record
    // and not how accurate its counts are. Both fields are the provider's own and neither is a
    // default: a record without them is covered against fixtures rather than here.
    matchConfidence: 'exact',
    platformPostId: 'tt-e2e-7788',
  },
];
analytics.daysByRecord = {
  'e2e-analytics-tt': [
    { date: '2099-09-14', views: 3000, likes: 200, comments: 20, shares: 50 },
    { date: '2099-09-15', views: 4210, likes: 318, comments: 24, shares: 61 },
  ],
};

/**
 * What the provider is holding, for the one flow only a browser can prove: a post this app did not
 * make, surfacing because somebody pressed refresh.
 *
 * One complete page, because the pagination walk itself — several pages, a repeated offset, a
 * malformed row, a page that fails — is covered against fixtures in `server/publish/inventory.test.ts`
 * where each of those can be arranged exactly. `mock-publication` is the id `MockPublishProvider`
 * hands back from every submit, so the second row is the one an end-to-end run can prove is *not* an
 * orphan once a spec has submitted something.
 */
const inventory = new MockProviderInventoryProvider();
inventory.hold([
  {
    providerPostId: 'e2e-provider-orphan',
    state: 'SCHEDULED',
    scheduledInstant: '2099-09-16T13:00:00.000Z',
    captionExcerpt: 'Scheduled straight in Post Bridge, not from here',
    accountIds: [901],
  },
  {
    providerPostId: 'mock-publication',
    state: 'SCHEDULED',
    scheduledInstant: '2099-09-15T13:00:00.000Z',
    captionExcerpt: 'Submitted by this app',
    accountIds: [901],
  },
]);

/**
 * What the provider reports over a window, for the one flow only a browser can prove: a person
 * pressing **Refresh window**, a mapped account total, a row belonging to nothing here, and a second
 * press that fails and leaves the first read exactly where it was.
 *
 * One complete page, because the walk itself — several pages, a repeated offset, an unreadable
 * envelope, the safety bounds — is covered against fixtures in
 * `server/publish/analytics-window.test.ts` where each can be arranged exactly.
 *
 * `e2e-result-tt` is the result identity `publish.checkResult` hands back, so the first row maps to a
 * delivery this run created; the second names a result nothing here claims, which is what an unmapped
 * row is. `failureAt = 2` makes the second press the failure case.
 *
 * **Every count here differs from the per-delivery fixture above, deliberately.** The two stores
 * answer different questions and are allowed to disagree, so a window figure that happened to equal a
 * `signal_post_metrics` figure would let a leak between them pass the spec unnoticed — the window
 * panel could be rendering per-delivery totals, or a window read could be writing into the per-post
 * table, and the assertions would still be green. Distinct numbers make each panel prove which store
 * it read.
 */
const analyticsWindow = new MockAnalyticsWindowProvider();
analyticsWindow.pages = [
  {
    rows: [
      {
        analyticsId: 'e2e-window-tt',
        postResultId: 'e2e-result-tt',
        platform: 'tiktok',
        views: 5117,
        likes: 402,
        comments: 31,
        shares: 78,
        providerSyncedAt: '2099-09-15T11:00:00.000Z',
        matchConfidence: 'exact',
        platformPostId: 'tt-e2e-7788',
      },
      {
        analyticsId: 'e2e-window-elsewhere',
        postResultId: 'made-in-post-bridge',
        platform: 'tiktok',
        views: 9000,
        likes: 12,
        comments: 3,
        shares: 4,
      },
    ],
    next: { done: true },
    warnings: [],
  },
];
analyticsWindow.failureAt = 2;

/**
 * The Google Ads authorization server (C256). Google's consent screen is replaced by an immediate
 * redirect to the app's own callback through the web origin, carrying the state the app minted and
 * a fixed code, so the spec drives the real start, callback, state, and storage code with no live
 * Google call. The account list answers from here too.
 */
const adsOauth = new MockAdsOAuthClient();
// Account listing and approval answer from a mock too, so no browser run can reach Google.
const adsProvider = new MockAdsProvider();
// Ads performance (C259): two accounts in two currencies and zones, a campaign with daily figures,
// one with none, and a day-read that fails once on the third call. All from the mock, so no run
// reads Google. Dates are relative to the account's own today, which keeps them inside the window.
{
  const localDates = (timeZone: string) => {
    const { endDate } = adsSyncWindow(new Date(), timeZone);
    const previous = new Date(new Date(`${endDate}T00:00:00.000Z`).getTime() - 86_400_000);
    return { today: endDate, yesterday: previous.toISOString().slice(0, 10) };
  };
  const ny = localDates('America/New_York');
  const berlin = localDates('Europe/Berlin');
  adsProvider.accessible = ['1234567890', '2345678901'];
  adsProvider.accounts.set('2345678901', {
    customerId: '2345678901',
    descriptiveName: 'Berlin account',
    currencyCode: 'EUR',
    timeZone: 'Europe/Berlin',
    manager: false,
    status: 'ENABLED',
  });
  const campaign = (customerId: string, campaignId: string, name: string) => ({
    customerId,
    campaignId,
    name,
    status: 'ENABLED',
    channelType: 'SEARCH',
  });
  adsProvider.campaigns.set('1234567890', [
    campaign('1234567890', '111', 'E2E Search'),
    campaign('1234567890', '112', 'E2E Idle'),
  ]);
  adsProvider.campaigns.set('2345678901', [campaign('2345678901', '221', 'E2E Berlin Brand')]);
  adsProvider.days.set('1234567890', [
    {
      customerId: '1234567890',
      campaignId: '111',
      date: ny.yesterday,
      impressions: 1000,
      clicks: 100,
      costMicros: 20_000_000,
      conversions: 4,
    },
    {
      customerId: '1234567890',
      campaignId: '111',
      date: ny.today,
      impressions: 500,
      clicks: 50,
      costMicros: 10_000_000,
      conversions: 1,
    },
  ]);
  adsProvider.days.set('2345678901', [
    {
      customerId: '2345678901',
      campaignId: '221',
      date: berlin.today,
      impressions: 70,
      clicks: 7,
      costMicros: 3_000_000,
      conversions: 2,
    },
  ]);
  // Refresh one reads each account's days once, in customer-ID order; the third call is the first
  // account of refresh two, which fails so the page's stale state can be driven. Later calls succeed.
  const readDays = adsProvider.readCampaignDays.bind(adsProvider);
  adsProvider.readCampaignDays = async (...args) => {
    if (adsProvider.dayCalls.length === 2) {
      adsProvider.dayCalls.push({ customerId: args[1], window: args[2] });
      throw new Error('e2e scripted day-query failure');
    }
    return readDays(...args);
  };
}
adsOauth.consentUrl = ({ state }) =>
  `${e2eWebOrigin}/api/ads/oauth/callback?${new URLSearchParams({ state, code: 'e2e-ads-code' })}`;

const bufferWrite = new MockBufferWriteProvider();
bufferWrite.createdStateByChannel.set('e2e-buffer-youtube', 'FAILED');

let agentHubLiveHub: AgentHubLiveHub | undefined;
let agentHubLiveContext:
  { registry: AgentHubTipRegistry; auth: AgentHubWsAuth; appOrigin: string } | undefined;
const app = createApp(db, {
  publishTimezone: 'America/New_York',
  publish,
  analytics,
  inventory,
  analyticsWindow,
  bufferRead: new MockBufferReadProvider(),
  bufferWrite,
  // The window the fixture may ask about. The app itself offers none — `ANALYTICS_WINDOW_EVIDENCE`
  // records §14's unverified rows — so without this the refresh path could not be reached at all.
  // A build a person uses never gets this option; see the option's own comment in `server/app.ts`.
  analyticsWindows: ['30d'],
  driveMedia: () => driveMedia,
  adsOauth: () => adsOauth,
  adsProvider: () => adsProvider,
  onAgentHubLiveContext: (ctx) => {
    agentHubLiveContext = ctx;
  },
});
const server: Server = app.listen(config.port, config.host, () => {
  if (agentHubLiveContext) {
    agentHubLiveHub = attachAgentHubWebSocket(server, agentHubLiveContext.registry, {
      db,
      appOrigin: agentHubLiveContext.appOrigin,
      auth: agentHubLiveContext.auth,
    });
  }
  console.log(`Command Center E2E API ready at http://${config.host}:${config.port}`);
});

const stop = stopWhenTheRunEnds(
  'API',
  () =>
    new Promise<void>((resolve) => {
      // Keep-alive sockets held by the browser and by Playwright's own API calls would
      // otherwise keep `close()` pending until they time out on their own.
      agentHubLiveHub?.closeAll();
      agentHubLiveHub?.dispose();
      server.closeAllConnections();
      server.close(() => {
        // Releases the SQLite handle, so the next run can delete the file on Windows.
        db.close();
        resolve();
      });
    }),
);

app.use((req, res, next) => {
  if (!handleE2eStopRequest(req, res, stop)) next();
});
// The Ads spec connects and approves accounts; this puts the Ads tables back where a later spec
// (Settings' card layout) expects them. Local data only: it never reaches the provider.
app.use((req, res, next) => {
  const reset = () => {
    for (const table of [
      'ads_campaign_days',
      'ads_campaigns',
      'ads_sync_windows',
      'ads_accounts',
      'ads_account_settings',
      'ads_discovered_accounts',
    ])
      db.exec(`DELETE FROM ${table}`);
    db.exec(
      `UPDATE ads_connection SET last_sync_at = NULL, last_sync_outcome = NULL, last_sync_error = NULL`,
    );
  };
  if (!handleE2eResetAdsRequest(req, res, reset)) next();
});
