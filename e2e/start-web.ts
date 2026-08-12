import { createServer, type ViteDevServer } from 'vite';
import { handleE2eStopRequest } from './endpoints.ts';
import { stopWhenTheRunEnds } from './shutdown.ts';

/**
 * Vite for the E2E run, started through its own API rather than its CLI.
 *
 * The CLI has no reason to stop when Playwright goes away, so an interrupted run used to
 * leave it holding port 5174 — and because `reuseExistingServer` is false, the next run
 * would refuse to start against a port something was already answering on. Owning the
 * process here lets it close on the same guard the API server uses.
 */
const host = process.env.WEB_HOST || '127.0.0.1';
const port = Number(process.env.WEB_PORT || 5174);

const stop = stopWhenTheRunEnds('web server', () => server.close());

// `strictPort` so a busy port fails here and says so, rather than moving to 5175 and
// leaving Playwright to wait out its timeout on a port nothing will ever answer.
const server: ViteDevServer = await createServer({
  server: { host, port, strictPort: true },
  plugins: [
    {
      name: 'e2e-stop',
      enforce: 'pre',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (!handleE2eStopRequest(req, res, stop)) next();
        });
      },
    },
  ],
});
await server.listen();
console.log(`Command Center E2E web server ready at http://${host}:${port}`);
