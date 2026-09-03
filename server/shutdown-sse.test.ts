import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { CSRF_HEADER_NAME } from '../shared/auth.ts';
import { MCP_BEARER_ISSUE_PATH, MCP_HTTP_PATH } from '../shared/mcp-network.ts';
import { MCP_SESSION_ID_HEADER } from '../shared/mcp-transport.ts';
import { createApp } from './app.ts';
import { hashPassword } from './auth/password.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from './auth/service.ts';
import { createDb, type Db } from './db.ts';
import { setSetting } from './drive/service.ts';
import { closeOnSignals } from './shutdown.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';

describe('production shutdown with active MCP SSE', () => {
  let db: Db | undefined;
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  let stream: IncomingMessage | undefined;

  afterEach(() => {
    stream?.destroy();
    server?.closeAllConnections();
    try {
      db?.close();
    } catch {
      // The shutdown callback may already have closed it.
    }
  });

  async function openServerAndStream() {
    db = createDb(':memory:');
    const passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
    const app = createApp(db, {
      enforceAuth: true,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server!.once('listening', resolve));

    const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    const bearerResponse = await request(app)
      .post(MCP_BEARER_ISSUE_PATH)
      .set('Cookie', login.headers['set-cookie']?.[0] as string)
      .set(CSRF_HEADER_NAME, login.body.csrfToken);
    const bearer = bearerResponse.body.bearerToken as string;
    const initialized = await request(app)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'shutdown-test', version: '0' } },
      });
    const sessionId = initialized.headers[MCP_SESSION_ID_HEADER] as string;
    expect(sessionId).toBeTruthy();

    const address = server.address() as AddressInfo;
    stream = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: MCP_HTTP_PATH,
          headers: {
            Accept: 'text/event-stream',
            Authorization: `Bearer ${bearer}`,
            [MCP_SESSION_ID_HEADER]: sessionId,
          },
        },
        resolve,
      );
      outgoing.once('error', reject);
      outgoing.end();
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);

    return { db, server, stream };
  }

  function shutdownRuntime() {
    const signals = new EventEmitter();
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    return {
      signals,
      exited,
      runtime: {
        once(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
          signals.once(signal, listener);
        },
        exit: vi.fn((code: number) => resolveExit(code)),
      },
    };
  }

  it('exits zero without forcing a client that disconnects within the drain bound', async () => {
    const active = await openServerAndStream();
    const { signals, exited, runtime } = shutdownRuntime();
    const closeDb = vi.spyOn(active.db, 'close');
    const forceClose = vi.spyOn(active.server, 'closeAllConnections');
    closeOnSignals(active.server, active.db, runtime, 1_000);

    signals.emit('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(closeDb).not.toHaveBeenCalled();

    active.stream.destroy();
    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('shutdown did not drain after SSE disconnected')), 1_000),
      ),
    ]);
    expect(exitCode).toBe(0);
    expect(forceClose).not.toHaveBeenCalled();
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it('force-closes an MCP SSE client at the bound and exits zero', async () => {
    const active = await openServerAndStream();
    const { signals, exited, runtime } = shutdownRuntime();
    const closeDb = vi.spyOn(active.db, 'close');
    const forceClose = vi.spyOn(active.server, 'closeAllConnections');
    closeOnSignals(active.server, active.db, runtime, 25);

    signals.emit('SIGTERM');
    signals.emit('SIGINT');

    const exitCode = await Promise.race([
      exited,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('shutdown exceeded its forced drain bound')), 1_000),
      ),
    ]);
    expect(exitCode).toBe(0);
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(closeDb).toHaveBeenCalledTimes(1);
    expect(runtime.exit).toHaveBeenCalledTimes(1);
  });
});
