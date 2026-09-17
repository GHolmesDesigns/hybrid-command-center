import path from 'node:path';
import express from 'express';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { assertProductionRuntimeConfig, config } from './config.ts';
import { getDb } from './db.ts';
import { configureServerTimeouts } from './budgets.ts';
import { closeOnSignals, HTTP_SHUTDOWN_DRAIN_MS } from './shutdown.ts';
import {
  attachAgentHubWebSocket,
  registerAgentHubLiveHub,
  type AgentHubLiveHub,
  type AgentHubWsAuth,
} from './agent-hub/ws.ts';
import type { AgentHubTipRegistry } from './agent-hub/tips.ts';

const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
let productionClient: { root: string; indexHtml: string } | undefined;
if (production) {
  assertProductionRuntimeConfig();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/client');
  const indexPath = path.join(root, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `Production client is missing at ${indexPath}. Run npm run build before start.`,
    );
  }
  productionClient = { root, indexHtml: fs.readFileSync(indexPath, 'utf8') };
}

const db = getDb();
let agentHubLiveHub: AgentHubLiveHub | undefined;
let agentHubLiveContext:
  | {
      registry: AgentHubTipRegistry;
      auth: AgentHubWsAuth;
      appOrigin: string;
    }
  | undefined;
const app = createApp(db, {
  onAgentHubLiveContext: (ctx) => {
    agentHubLiveContext = ctx;
  },
});
if (productionClient) {
  app.use(express.static(productionClient.root));
  app.get('/{*splat}', (_req, res) => res.type('html').send(productionClient.indexHtml));
}
const server = app.listen(config.port, config.host, () => {
  if (agentHubLiveContext) {
    agentHubLiveHub = attachAgentHubWebSocket(server, agentHubLiveContext.registry, {
      db,
      appOrigin: agentHubLiveContext.appOrigin,
      auth: agentHubLiveContext.auth,
    });
  }
  console.log(`Command Center API ready at http://${config.host}:${config.port}`);
});
// Header and request deadlines belong to the server, not to middleware: nothing in the app runs
// until the headers have arrived, which is the wait these two bound.
configureServerTimeouts(server);
closeOnSignals(server, db, process, HTTP_SHUTDOWN_DRAIN_MS, () => {
  agentHubLiveHub?.closeAll();
  agentHubLiveHub?.dispose();
  registerAgentHubLiveHub(null);
});
