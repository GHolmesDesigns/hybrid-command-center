/**
 * Streamable HTTP lifecycle coverage beyond the dual-transport conformance suite (C133).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { hashPassword } from '../auth/password.ts';
import { setSetting } from '../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { CSRF_HEADER_NAME } from '../../shared/auth.ts';
import {
  MCP_AGENT_LABEL_HEADER,
  MCP_BEARER_ISSUE_PATH,
  MCP_HTTP_PATH,
} from '../../shared/mcp-network.ts';
import { MCP_PROTOCOL_VERSION_HEADER, MCP_SESSION_ID_HEADER } from '../../shared/mcp-transport.ts';
import { COORDINATION_INBOX_URI } from '../../shared/mcp-agent-events.ts';
import {
  createMcpHttpHandler,
  handleMcpHttpDelete,
  handleMcpHttpGet,
  McpHttpSessionRegistry,
} from './http.ts';
import { McpWriteLimiterRegistry } from './write-limiter-registry.ts';
import { setMcpResourceUpdateBridge, notifyMcpResourceUpdated } from './resource-notifier.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';

describe('streamable HTTP MCP lifecycle (C133)', () => {
  let db: Db;
  let passwordHash: string;
  let instance: Express;

  beforeEach(async () => {
    db = createDb(':memory:');
    passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
    instance = createApp(db, {
      enforceAuth: true,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
    });
  });

  afterEach(() => {
    setMcpResourceUpdateBridge(null);
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  async function bearer() {
    const login = await request(instance).post('/api/auth/login').send({ password: PASSWORD });
    const issued = await request(instance)
      .post(MCP_BEARER_ISSUE_PATH)
      .set('Cookie', login.headers['set-cookie']?.[0] as string)
      .set(CSRF_HEADER_NAME, login.body.csrfToken);
    return issued.body.bearerToken as string;
  }

  async function initialize(token: string) {
    const res = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', clientInfo: { name: 'stream', version: '0' } },
      });
    expect(res.status).toBe(200);
    return res.headers[MCP_SESSION_ID_HEADER] as string;
  }

  it('continues a session, opens SSE POST, tips subscribers, and deletes the session', async () => {
    const token = await bearer();
    const sessionId = await initialize(token);

    const sub = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .set(MCP_SESSION_ID_HEADER, sessionId)
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: COORDINATION_INBOX_URI },
      });
    expect(sub.status).toBe(200);

    notifyMcpResourceUpdated(COORDINATION_INBOX_URI);

    const ping = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .set(MCP_SESSION_ID_HEADER, sessionId)
      .set(MCP_PROTOCOL_VERSION_HEADER, '2025-03-26')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    expect(ping.status).toBe(200);
    expect(String(ping.headers['content-type'])).toContain('text/event-stream');
    expect(ping.text).toContain('"result"');

    const deleted = await request(instance)
      .delete(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_SESSION_ID_HEADER, sessionId);
    expect(deleted.status).toBe(204);

    const missing = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .set(MCP_SESSION_ID_HEADER, sessionId)
      .send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(missing.status).toBe(404);
  });

  it('refuses an unsupported protocol version header and session credential mismatch', async () => {
    const token = await bearer();
    const sessionId = await initialize(token);

    const badVersion = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .set(MCP_PROTOCOL_VERSION_HEADER, '1999-01-01')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(badVersion.status).toBe(400);

    const other = await bearer();
    const stolen = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${other}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .set(MCP_SESSION_ID_HEADER, sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(stolen.status).toBe(403);
  });

  it('accepts JSON-RPC response messages with 202 and rejects batches', async () => {
    const token = await bearer();
    const responseAck = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .send({ jsonrpc: '2.0', id: 1, result: {} });
    expect(responseAck.status).toBe(202);

    const batch = await request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${token}`)
      .set(MCP_AGENT_LABEL_HEADER, 'stream')
      .send([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(batch.status).toBe(400);
  });

  it('covers GET/DELETE auth and Accept guards on the handler directly', async () => {
    const sessions = new McpHttpSessionRegistry();
    const options = {
      db,
      sessionSecret: SECRET,
      writeLimiters: new McpWriteLimiterRegistry(),
      httpSessions: sessions,
    };
    const handler = createMcpHttpHandler(options);
    const token = await bearer();

    const res = {
      statusCode: 200,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
      end() {
        return this;
      },
      setHeader() {
        return this;
      },
    };

    await handleMcpHttpGet(
      { method: 'GET', headers: { accept: 'text/event-stream' } } as never,
      res as never,
      options,
    );
    expect(res.statusCode).toBe(401);

    await handleMcpHttpGet(
      {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
        },
      } as never,
      res as never,
      options,
    );
    expect(res.statusCode).toBe(405);

    await handleMcpHttpDelete({ method: 'DELETE', headers: {} } as never, res as never, options);
    expect(res.statusCode).toBe(401);

    await handler({ method: 'PATCH', headers: {} } as never, res as never);
    expect(res.statusCode).toBe(405);
  });

  it('replays Last-Event-ID on GET for an authenticated session', async () => {
    const sessions = new McpHttpSessionRegistry();
    const options = {
      db,
      sessionSecret: SECRET,
      writeLimiters: new McpWriteLimiterRegistry(),
      httpSessions: sessions,
      now: () => Date.now(),
    };
    const token = await bearer();
    const initRes = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      chunks: [] as Buffer[],
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      json(payload: unknown) {
        this.chunks.push(Buffer.from(JSON.stringify(payload)));
        return this;
      },
      end(payload?: string) {
        if (payload) this.chunks.push(Buffer.from(payload));
        return this;
      },
      write(chunk: string | Buffer) {
        this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return true;
      },
      writableEnded: false,
      on() {
        return this;
      },
      flushHeaders() {},
    };
    const handler = createMcpHttpHandler(options);
    await handler(
      {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'stream', version: '0' } },
        },
        headers: {
          authorization: `Bearer ${token}`,
          [MCP_AGENT_LABEL_HEADER]: 'stream',
          accept: 'application/json',
        },
        ip: '127.0.0.1',
        on() {
          return this;
        },
      } as never,
      initRes as never,
    );
    const sessionId = initRes.headers[MCP_SESSION_ID_HEADER];
    expect(sessionId).toBeTruthy();
    const record = sessions.get(sessionId!, Date.now())!;
    sessions.publish(record, {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: COORDINATION_INBOX_URI },
    });

    let closed: (() => void) | null = null;
    const getRes = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      chunks: [] as Buffer[],
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
      },
      json(payload: unknown) {
        this.chunks.push(Buffer.from(JSON.stringify(payload)));
        return this;
      },
      end() {
        return this;
      },
      write(chunk: string | Buffer) {
        this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return true;
      },
      get writableEnded() {
        return false;
      },
      on(event: string, cb: () => void) {
        if (event === 'close') closed = cb;
        return this;
      },
      flushHeaders() {},
    };
    const getReq = {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/event-stream',
        [MCP_SESSION_ID_HEADER]: sessionId,
        'last-event-id': '0',
      },
      ip: '127.0.0.1',
      on(event: string, cb: () => void) {
        if (event === 'close') closed = cb;
        return this;
      },
    };
    const getPromise = handleMcpHttpGet(getReq as never, getRes as never, options);
    await new Promise((resolve) => setTimeout(resolve, 20));
    closed?.();
    await getPromise;
    expect(getRes.statusCode).toBe(200);
    expect(Buffer.concat(getRes.chunks).toString()).toContain('notifications/resources/updated');
  });
});
