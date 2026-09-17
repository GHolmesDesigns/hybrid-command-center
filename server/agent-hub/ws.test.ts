/**
 * Agent Hub WebSocket live channel (C236 / #669).
 */
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AGENT_HUB_WS_PATH } from '../../shared/agent-hub-live.ts';
import { createApp } from '../app.ts';
import { hashPassword } from '../auth/password.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { createDb, type Db } from '../db.ts';
import { setSetting } from '../drive/service.ts';
import { attachAgentHubWebSocket, type AgentHubLiveHub } from './ws.ts';
import { tipAgentHubConversation } from './tips.ts';

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
