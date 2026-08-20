import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { getDb } from '../server/db.ts';
import { resetE2eDatabase } from './database.ts';
import { handleE2eStopRequest } from './endpoints.ts';
import { stopWhenTheRunEnds } from './shutdown.ts';
import { MockAnalyticsProvider, MockPublishProvider } from '../server/publish/mock-provider.ts';
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

// One account per platform, which is what target resolution requires and what makes a
// per-account override deliverable as its platform's configuration.
const publish = new MockPublishProvider([
  { id: 901, platform: 'twitter', handle: '@gholmes', name: 'G.Holmes Designs' },
  { id: 902, platform: 'facebook', handle: 'gholmesdesigns', name: 'G.Holmes Designs' },
  { id: 903, platform: 'linkedin', handle: '@gholmes-designs', name: 'G.Holmes Designs' },
  // TikTok is here because it is one of the three platforms the provider reports figures for, and a
  // figure needs a delivery to belong to.
  { id: 904, platform: 'tiktok', handle: '@gholmes', name: 'G.Holmes Designs' },
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
  },
];
analytics.daysByRecord = {
  'e2e-analytics-tt': [
    { date: '2099-09-14', views: 3000, likes: 200, comments: 20, shares: 50 },
    { date: '2099-09-15', views: 4210, likes: 318, comments: 24, shares: 61 },
  ],
};

const app = createApp(db, {
  publishTimezone: 'America/New_York',
  publish,
  analytics,
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
