import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { getDb } from '../server/db.ts';
import { resetE2eDatabase } from './database.ts';

const databasePath = resetE2eDatabase();
console.log(`Reset E2E database at ${databasePath}`);

// Opened after the reset above, never at import time, so every run starts from an empty file.
// The listener is owned here rather than by `server/index.ts` so that shutdown has something
// to close; the production static-file branch in that module is not wanted anyway, since Vite
// serves the client during E2E.
const db = getDb();
const server = createApp(db).listen(config.port, config.host, () =>
  console.log(`Command Center E2E API ready at http://${config.host}:${config.port}`),
);

let stopping = false;
/**
 * Playwright tears its web servers down when the suite ends, passing or failing. On POSIX
 * that is a signal to the process group; on Windows there are no signals, so it force-kills
 * the tree instead — and a `taskkill /T` that misses a grandchild leaves a server holding
 * port 8788 and the SQLite file, which fails every later run.
 *
 * Signals cover POSIX and Ctrl+C. Stdin EOF covers the rest: Playwright owns the write end of
 * this pipe, so losing it means the run is over whether or not the kill reached us. The one
 * cost is that launching this server with stdin closed stops it immediately — run it through
 * Playwright or a terminal, both of which give it a real stdin.
 */
function stop(reason: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Stopping the E2E API (${reason}).`);
  // Keep-alive sockets held by the browser and by Playwright's own API calls would otherwise
  // keep `close()` pending until they time out on their own.
  server.closeAllConnections();
  server.close(() => {
    // Releases the SQLite handle, so the next run can delete the file on Windows.
    db.close();
    process.exit(0);
  });
  // A socket that will not drop must not outlive the run.
  setTimeout(() => process.exit(0), 5_000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)
  process.on(signal, () => stop(signal));
process.stdin.on('end', () => stop('stdin closed'));
process.stdin.on('error', () => stop('stdin closed'));
process.stdin.resume();
