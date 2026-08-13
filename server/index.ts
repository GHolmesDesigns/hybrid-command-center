import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { config } from './config.ts';
import { getDb } from './db.ts';
import { configureServerTimeouts } from './budgets.ts';
import { closeOnSignals } from './shutdown.ts';

const db = getDb();
const app = createApp(db);
if (process.env.NODE_ENV === 'production' || process.argv.includes('--production')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client');
  app.use(express.static(root));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(root, 'index.html')));
}
const server = app.listen(config.port, config.host, () =>
  console.log(`Command Center API ready at http://${config.host}:${config.port}`),
);
// Header and request deadlines belong to the server, not to middleware: nothing in the app runs
// until the headers have arrived, which is the wait these two bound.
configureServerTimeouts(server);
closeOnSignals(server, db);
