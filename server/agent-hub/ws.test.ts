/**
 * Agent Hub WebSocket live channel (C236 / #669).
 */
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionToken } from '../auth/cookies.ts';
import { sessionFromRawToken } from '../auth/service.ts';
import request from 'supertest';
import {
  AGENT_HUB_WS_PATH,
  AGENT_HUB_WS_SERVER_PING_INTERVAL_MS,
} from '../../shared/agent-hub-live.ts';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { createDb, type Db } from '../db.ts';
import { setSetting } from '../drive/service.ts';
import {
  attachAgentHubWebSocket,
  closeAgentHubLiveForSession,
  type AgentHubLiveHub,
} from './ws.ts';
import { tipAgentHubConversation, tipAgentHubCoordination } from './tips.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';
const APP_ORIGIN = 'http://127.0.0.1';

describe('Agent Hub WebSocket (C236)', () => {
  let db: Db;
  let app: Express;
  let hub: AgentHubLiveHub;
  let server: ReturnType<Express['listen']>;
  let cookie: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    const passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
    app = createApp(db, {
      enforceAuth: true,
      appOrigin: APP_ORIGIN,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
      onAgentHubLiveContext: (ctx) => {
        server = ctx.app.listen(0, '127.0.0.1');
        hub = attachAgentHubWebSocket(server, ctx.registry, {
          db,
          appOrigin: ctx.appOrigin,
          auth: ctx.auth,
        });
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    cookie = login.headers['set-cookie']?.[0] as string;
  });

  afterEach(() => {
    hub?.dispose();
    server?.closeAllConnections();
    try {
      server?.close();
    } catch {
      // already closed
    }
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  function wsUrl(): string {
    const address = server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}${AGENT_HUB_WS_PATH}`;
  }

  it('rejects a foreign Origin before the upgrade completes', async () => {
    const address = server.address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: AGENT_HUB_WS_PATH,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          Origin: 'https://evil.example',
          Cookie: cookie,
        },
      });
      outgoing.on('response', (res) => resolve(res.statusCode));
      outgoing.on('upgrade', () => resolve(101));
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(status).toBe(403);
  });

  it('rejects unauthenticated upgrades when auth is required', async () => {
    const address = server.address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = httpRequest({
        host: '127.0.0.1',
        port: address.port,
        path: AGENT_HUB_WS_PATH,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          Origin: APP_ORIGIN,
        },
      });
      outgoing.on('response', (res) => resolve(res.statusCode));
      outgoing.on('upgrade', () => resolve(101));
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(status).toBe(401);
  });

  it('allows upgrades without a session when auth is not required', async () => {
    hub.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    app = createApp(db, {
      enforceAuth: false,
      appOrigin: APP_ORIGIN,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: await hashPassword(PASSWORD),
        trustedProxyHops: 0,
        secureCookies: false,
      },
      onAgentHubLiveContext: (ctx) => {
        server = ctx.app.listen(0, '127.0.0.1');
        hub = attachAgentHubWebSocket(server, ctx.registry, {
          db,
          appOrigin: ctx.appOrigin,
          auth: { authRequired: false, sessionSecret: ctx.auth.sessionSecret },
        });
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));

    const socket = new WebSocket(wsUrl(), { headers: { Origin: APP_ORIGIN } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.close();
  });

  it('fans out wake frames with feeds only and closes on logout', async () => {
    const socket = new WebSocket(wsUrl(), { headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const wake = new Promise<unknown>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
    });
    tipAgentHubConversation('conv-ws');
    const frame = await wake;
    expect(frame).toMatchObject({
      kind: 'wake',
      feeds: ['conversations'],
      conversationId: 'conv-ws',
    });
    expect(Object.keys(frame as object)).not.toContain('body');

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await request(app).post('/api/auth/logout').set('Cookie', cookie);
    const end = await closed;
    expect(end.code).toBe(1001);
  });

  it('closes the socket on unknown client frame kinds with a policy code', async () => {
    const socket = new WebSocket(wsUrl(), { headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    socket.send(JSON.stringify({ kind: 'wake' }));
    expect(await closed).toBe(1008);
  });

  it('routes assistant deltas only to the owning subscribed socket', async () => {
    const loginB = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    const cookieB = loginB.headers['set-cookie']?.[0] as string;

    const socketA = new WebSocket(wsUrl(), { headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    const socketB = new WebSocket(wsUrl(), { headers: { Cookie: cookieB, Origin: APP_ORIGIN } });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        socketA.once('open', () => resolve());
        socketA.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        socketB.once('open', () => resolve());
        socketB.once('error', reject);
      }),
    ]);
    socketA.send(JSON.stringify({ kind: 'subscribe', conversationId: 'conv-assistant' }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    const rawToken = readSessionToken(cookie);
    const sessionA = sessionFromRawToken(db, {
      rawToken,
      sessionSecret: SECRET,
      now: Date.now(),
    });
    hub.sendAssistantDelta(sessionA!.tokenHash, 'conv-assistant', {
      kind: 'assistant_delta',
      turnId: 'turn-1',
      conversationId: 'conv-assistant',
      delta: 'Hi',
    });
    hub.sendAssistantDelta(sessionA!.tokenHash, 'conv-other', {
      kind: 'assistant_delta',
      turnId: 'turn-1',
      conversationId: 'conv-other',
      delta: 'Hidden',
    });

    const delta = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for delta')), 2_000);
      socketA.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)));
      });
    });
    expect(delta).toMatchObject({
      kind: 'assistant_delta',
      conversationId: 'conv-assistant',
      delta: 'Hi',
    });

    socketB.close();
    socketA.close();
  });

  it('accepts ping and subscribe frames and responds with pong', async () => {
    const socket = new WebSocket(wsUrl(), { headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ kind: 'subscribe', conversationId: 'thread-1' }));
    socket.send(JSON.stringify({ kind: 'unsubscribe', conversationId: 'thread-1' }));
    const pong = new Promise<unknown>((resolve) => {
      socket.once('message', (data) => resolve(JSON.parse(String(data))));
    });
    socket.send(JSON.stringify({ kind: 'ping' }));
    expect(await pong).toEqual({ kind: 'pong' });
    socket.close();
  });

  it('closes on invalid JSON, binary payloads, and oversized frames', async () => {
    const socket = new WebSocket(wsUrl(), { headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    socket.send('{');
    expect(await closed).toBe(1008);

    const binarySocket = new WebSocket(wsUrl(), {
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      binarySocket.once('open', () => resolve());
      binarySocket.once('error', reject);
    });
    const binaryClosed = new Promise<number>((resolve) => {
      binarySocket.once('close', (code) => resolve(code));
    });
    binarySocket.send(Buffer.from([1, 2, 3]));
    expect(await binaryClosed).toBe(1008);

    const oversizedSocket = new WebSocket(wsUrl(), {
      headers: { Cookie: cookie, Origin: APP_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      oversizedSocket.once('open', () => resolve());
      oversizedSocket.once('error', reject);
    });
    const oversizedClosed = new Promise<number>((resolve) => {
      oversizedSocket.once('close', (code) => resolve(code));
    });
    oversizedSocket.send(JSON.stringify({ kind: 'ping', pad: 'x'.repeat(4096) }));
    expect(await oversizedClosed).toBe(1008);
  });

  it('closes when inbound message rate is exceeded', async () => {
    const now = 1_000;
    hub.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    app = createApp(db, {
      enforceAuth: true,
      appOrigin: APP_ORIGIN,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: await hashPassword(PASSWORD),
        trustedProxyHops: 0,
        secureCookies: false,
      },
      onAgentHubLiveContext: (ctx) => {
        server = ctx.app.listen(0, '127.0.0.1');
        hub = attachAgentHubWebSocket(server, ctx.registry, {
          db,
          appOrigin: ctx.appOrigin,
          auth: ctx.auth,
          now: () => now,
        });
      },
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    cookie = login.headers['set-cookie']?.[0] as string;

    const socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}${AGENT_HUB_WS_PATH}`,
      { headers: { Cookie: cookie, Origin: APP_ORIGIN } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    for (let i = 0; i < 21; i += 1) socket.send(JSON.stringify({ kind: 'ping' }));
    expect(await closed).toBe(1008);
  });

  it('fans out coordination wake frames and closes only the matching session', async () => {
    const loginB = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    const cookieB = loginB.headers['set-cookie']?.[0] as string;

    const socketA = new WebSocket(wsUrl(), { headers: { Cookie: cookie, Origin: APP_ORIGIN } });
    const socketB = new WebSocket(wsUrl(), { headers: { Cookie: cookieB, Origin: APP_ORIGIN } });
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        socketA.once('open', () => resolve());
        socketA.once('error', reject);
      }),
      new Promise<void>((resolve, reject) => {
        socketB.once('open', () => resolve());
        socketB.once('error', reject);
      }),
    ]);

    const wake = new Promise<unknown>((resolve) => {
      socketA.once('message', (data) => resolve(JSON.parse(String(data))));
    });
    tipAgentHubCoordination();
    expect(await wake).toMatchObject({
      kind: 'wake',
      feeds: ['coordination'],
    });

    const rawToken = readSessionToken(cookie);
    const sessionA = sessionFromRawToken(db, {
      rawToken,
      sessionSecret: SECRET,
      now: Date.now(),
    });
    closeAgentHubLiveForSession(sessionA!.tokenHash);
    const closedA = new Promise<number>((resolve) => {
      socketA.once('close', (code) => resolve(code));
    });
    expect(await closedA).toBe(1001);
    expect(socketB.readyState).toBe(WebSocket.OPEN);
    socketB.close();
  });

  it('sends server ping frames on the documented interval', async () => {
    vi.useFakeTimers();
    try {
      hub.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));

      app = createApp(db, {
        enforceAuth: true,
        appOrigin: APP_ORIGIN,
        auth: {
          sessionSecret: SECRET,
          operatorPasswordHash: await hashPassword(PASSWORD),
          trustedProxyHops: 0,
          secureCookies: false,
        },
        onAgentHubLiveContext: (ctx) => {
          server = ctx.app.listen(0, '127.0.0.1');
          hub = attachAgentHubWebSocket(server, ctx.registry, {
            db,
            appOrigin: ctx.appOrigin,
            auth: ctx.auth,
          });
        },
      });
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
      cookie = login.headers['set-cookie']?.[0] as string;

      const socket = new WebSocket(
        `ws://127.0.0.1:${(server.address() as AddressInfo).port}${AGENT_HUB_WS_PATH}`,
        { headers: { Cookie: cookie, Origin: APP_ORIGIN } },
      );
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      const ping = new Promise<void>((resolve) => {
        socket.once('ping', () => resolve());
      });
      vi.advanceTimersByTime(AGENT_HUB_WS_SERVER_PING_INTERVAL_MS);
      await ping;
      socket.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Agent Hub WebSocket shutdown', () => {
  let db: Db | undefined;
  let hub: AgentHubLiveHub | undefined;
  let server: ReturnType<Express['listen']> | undefined;
  let socket: WebSocket | undefined;

  afterEach(() => {
    socket?.close();
    hub?.dispose();
    server?.closeAllConnections();
    try {
      db?.close();
    } catch {
      // already closed
    }
  });

  it('closes open sockets with a going-away code on shutdown', async () => {
    db = createDb(':memory:');
    const passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
    const appRef = createApp(db, {
      enforceAuth: true,
      appOrigin: APP_ORIGIN,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
      onAgentHubLiveContext: (ctx) => {
        server = ctx.app.listen(0, '127.0.0.1');
        hub = attachAgentHubWebSocket(server, ctx.registry, {
          db: db!,
          appOrigin: ctx.appOrigin,
          auth: ctx.auth,
        });
      },
    });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const login = await request(appRef).post('/api/auth/login').send({ password: PASSWORD });
    const sessionCookie = login.headers['set-cookie']?.[0] as string;
    const address = server!.address() as AddressInfo;
    socket = new WebSocket(`ws://127.0.0.1:${address.port}${AGENT_HUB_WS_PATH}`, {
      headers: { Cookie: sessionCookie, Origin: APP_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', () => resolve());
      socket!.once('error', reject);
    });

    const closed = new Promise<number>((resolve) => {
      socket!.once('close', (code) => resolve(code));
    });
    hub!.closeAll();
    expect(await closed).toBe(1001);
    expect(hub!.openSocketCount()).toBe(0);
  });
});
