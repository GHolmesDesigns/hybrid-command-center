import path from 'node:path';
import express from 'express';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { assertProductionRuntimeConfig, config } from './config.ts';
import { getDb } from './db.ts';
import { configureServerTimeouts } from './budgets.ts';
import { closeOnSignals } from './shutdown.ts';

const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
let productionRoot: string | undefined;
if (production) {
  assertProductionRuntimeConfig();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client');
  const indexPath = path.join(root, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `Production client is missing at ${indexPath}. Run npm run build before start.`,
    );
  }
  productionRoot = root;
}

const db = getDb();
const app = createApp(db);
if (productionRoot) {
  app.use(express.static(productionRoot));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(productionRoot, 'index.html')));
}
const server = app.listen(config.port, config.host, () =>
  console.log(`Command Center API ready at http://${config.host}:${config.port}`),
);
// Header and request deadlines belong to the server, not to middleware: nothing in the app runs
// until the headers have arrived, which is the wait these two bound.
configureServerTimeouts(server);
closeOnSignals(server, db);
