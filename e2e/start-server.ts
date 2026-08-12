import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { getDb } from '../server/db.ts';
import { resetE2eDatabase } from './database.ts';
import { handleE2eStopRequest } from './endpoints.ts';
import { stopWhenTheRunEnds } from './shutdown.ts';

const databasePath = resetE2eDatabase();
console.log(`Reset E2E database at ${databasePath}`);

// Opened after the reset above, never at import time, so every run starts from an empty file.
// The listener is owned here rather than by `server/index.ts` so that shutdown has something
// to close; the production static-file branch in that module is not wanted anyway, since Vite
// serves the client during E2E.
const db = getDb();
const app = createApp(db);
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
