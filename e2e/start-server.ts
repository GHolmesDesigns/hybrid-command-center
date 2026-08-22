import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { getDb } from '../server/db.ts';
import { resetE2eDatabase } from './database.ts';
import { handleE2eStopRequest } from './endpoints.ts';
import { stopWhenTheRunEnds } from './shutdown.ts';
import {
  MockAnalyticsProvider,
  MockProviderInventoryProvider,
  MockPublishProvider,
} from '../server/publish/mock-provider.ts';
import { MockDriveMediaProvider } from '../server/drive/mock-provider.ts';

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
 * is what lets an end-to-end run reach the figures at all: the delivery refresh captures the id, and
 * the figures refresh asks about it. The submission itself is untouched, so every earlier spec still
 * sees a post the provider has merely accepted.
 */
publish.checkResult = {
  providerPostId: 'mock-publication',
  state: 'CONFIRMED',
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

const app = createApp(db, {
  publishTimezone: 'America/New_York',
  publish,
  analytics,
  inventory,
  driveMedia: () => driveMedia,
});
const server: Server = app.listen(config.port, config.host, () =>
  console.log(`Command Center E2E API ready at http://${config.host}:${config.port}`),
);

const stop = stopWhenTheRunEnds(
  'API',
  () =>
    new Promise<void>((resolve) => {
      // Keep-alive sockets held by the browser and by Playwright's own API calls would
      // otherwise keep `close()` pending until they time out on their own.
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
