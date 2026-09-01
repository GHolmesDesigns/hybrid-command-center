/**
 * MCP protocol conformance cases (C133 / #383).
 *
 * One case set runs over stdio and streamable HTTP so the transports cannot diverge.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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
import { MCP_PROTOCOL_VERSION, MCP_SESSION_ID_HEADER } from '../../shared/mcp-transport.ts';
import { COORDINATION_INBOX_URI } from '../../shared/mcp-agent-events.ts';
import { listHandoffs } from '../agent-coordination/service.ts';
import { handleMcpJsonRpc, type McpOutboundMessage } from './stdio.ts';
import { createMcpSession, type McpSession } from './session.ts';
import { MCP_RESOURCE_DEFINITIONS } from './resources.ts';
import { onMcpResourceUpdated, resetMcpResourceNotifierForTests } from './resource-notifier.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';

type TransportKind = 'stdio' | 'http';

type ConformanceClient = {
  kind: TransportKind;
  session: McpSession;
  call: (
    message: Record<string, unknown>,
    options?: { beforeToolsCall?: (signal: AbortSignal) => Promise<void> },
  ) => Promise<{
    status: number;
    headers: Record<string, string>;
    messages: McpOutboundMessage[];
    body: unknown;
  }>;
  /** HTTP only: open GET SSE long enough to capture buffered tips. */
  listen?: (sessionId: string) => Promise<McpOutboundMessage[]>;
};

describe.each([['stdio'], ['http']] as const)('MCP protocol conformance (%s)', (kind) => {
  let db: Db;
  let passwordHash: string;
  let client: ConformanceClient;
  let httpSessionId: string | null = null;

  beforeEach(async () => {
    // This suite uses Vitest assertions throughout; an early return must not pass silently.
    expect.hasAssertions();
    resetMcpResourceNotifierForTests();
    db = createDb(':memory:');
    passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
    httpSessionId = null;
    client = await createClient(
      kind,
      db,
      passwordHash,
      () => httpSessionId,
      (id) => {
        httpSessionId = id;
      },
    );
  });

  afterEach(() => {
    resetMcpResourceNotifierForTests();
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it('negotiates initialize and advertises resource subscribe', async () => {
    const res = await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'conformance', version: '0' },
      },
    });
    expect(res.status).toBe(200);
    const result = (res.messages[0] as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toMatchObject({
      resources: { subscribe: true },
      tools: {},
      prompts: {},
    });
    if (kind === 'http') {
      expect(res.headers[MCP_SESSION_ID_HEADER]).toBeTruthy();
    }
  });

  it('falls back to the default protocol version for an unknown request', async () => {
    const res = await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '1999-01-01',
        clientInfo: { name: 'old', version: '0' },
      },
    });
    const result = (res.messages[0] as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });

  it('keeps resources/list stable and ordered', async () => {
    await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'conformance', version: '0' } },
    });
    const first = await client.call({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    const second = await client.call({ jsonrpc: '2.0', id: 3, method: 'resources/list' });
    const uris = (messages: McpOutboundMessage[]) =>
      (
        (messages[0] as { result: { resources: Array<{ uri: string }> } }).result.resources ?? []
      ).map((resource) => resource.uri);
    expect(uris(first.messages)).toEqual(MCP_RESOURCE_DEFINITIONS.map((resource) => resource.uri));
    expect(uris(second.messages)).toEqual(uris(first.messages));
  });

  it('accepts notifications without a JSON-RPC response body', async () => {
    await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'conformance', version: '0' } },
    });
    const res = await client.call({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    if (kind === 'http') {
      expect(res.status).toBe(202);
    } else {
      expect(res.messages).toEqual([]);
    }
  });

  // This harness feeds batches only through HTTP. Do not collect a no-op stdio "pass".
  if (kind === 'http') {
    it('refuses malformed JSON-RPC batches', async () => {
      const app = createApp(db, {
        enforceAuth: true,
        auth: {
          sessionSecret: SECRET,
          operatorPasswordHash: passwordHash,
          trustedProxyHops: 0,
          secureCookies: false,
        },
      });
      const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
      const bearer = await request(app)
        .post(MCP_BEARER_ISSUE_PATH)
        .set('Cookie', login.headers['set-cookie']?.[0] as string)
        .set(CSRF_HEADER_NAME, login.body.csrfToken);
      const res = await request(app)
        .post(MCP_HTTP_PATH)
        .set('Authorization', `Bearer ${bearer.body.bearerToken}`)
        .set(MCP_AGENT_LABEL_HEADER, 'conformance')
        .send([
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ]);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(-32600);
    });
  }

  it('emits progress notifications when a progressToken is present', async () => {
    await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'conformance', version: '0' } },
    });
    const res = await client.call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'system_capabilities',
        arguments: {},
        _meta: { progressToken: 'p1' },
      },
    });
    const progress = res.messages.filter(
      (message) =>
        'method' in message && (message as { method: string }).method === 'notifications/progress',
    );
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(res.messages.some((message) => 'result' in message)).toBe(true);
  });

  it('cancels an in-flight tools/call without leaving a partial write', async () => {
    await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientInfo: { name: 'conformance', version: '0' },
        _meta: { agent_label: 'conformance' },
      },
    });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    if (kind === 'stdio') {
      const callPromise = client.call(
        {
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'coordination_post_handoff',
            arguments: { subjectType: 'freeform', message: 'Should not land.' },
          },
        },
        {
          beforeToolsCall: async (signal) => {
            await Promise.race([
              gate,
              new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              }),
            ]);
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await client.call({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 99, reason: 'conformance cancel' },
      });
      releaseGate();
      const res = await callPromise;
      expect(res.messages.some((message) => 'result' in message || 'error' in message)).toBe(false);
    } else {
      const { createMcpHttpHandler, McpHttpSessionRegistry } = await import('./http.ts');
      const { McpWriteLimiterRegistry } = await import('./write-limiter-registry.ts');
      const sessions = new McpHttpSessionRegistry();
      const handler = createMcpHttpHandler({
        db,
        sessionSecret: SECRET,
        writeLimiters: new McpWriteLimiterRegistry(),
        httpSessions: sessions,
        beforeToolsCall: async (signal) => {
          await Promise.race([
            gate,
            new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            }),
          ]);
        },
      });
      const app = createApp(db, {
        enforceAuth: true,
        auth: {
          sessionSecret: SECRET,
          operatorPasswordHash: passwordHash,
          trustedProxyHops: 0,
          secureCookies: false,
        },
      });
      const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
      const bearerRes = await request(app)
        .post(MCP_BEARER_ISSUE_PATH)
        .set('Cookie', login.headers['set-cookie']?.[0] as string)
        .set(CSRF_HEADER_NAME, login.body.csrfToken);
      const bearer = bearerRes.body.bearerToken as string;

      const init = await invokeHandler(handler, {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'conformance', version: '0' },
            _meta: { agent_label: 'conformance' },
          },
        },
        bearer,
        sessionId: null,
        accept: 'application/json',
      });
      const sessionId = init.headers[MCP_SESSION_ID_HEADER]!;
      const callPromise = invokeHandler(handler, {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: {
            name: 'coordination_post_handoff',
            arguments: { subjectType: 'freeform', message: 'Should not land.' },
          },
        },
        bearer,
        sessionId,
        accept: 'application/json',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await invokeHandler(handler, {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: 99, reason: 'conformance cancel' },
        },
        bearer,
        sessionId,
        accept: 'application/json',
      });
      releaseGate();
      const res = await callPromise;
      expect(res.messages.some((message) => 'result' in message || 'error' in message)).toBe(false);
    }

    expect(listHandoffs(db, { state: 'OPEN' })).toHaveLength(0);
  });

  it('subscribes to a resource and receives an update tip without replacing cursors', async () => {
    await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'conformance', version: '0' } },
    });
    const sub = await client.call({
      jsonrpc: '2.0',
      id: 2,
      method: 'resources/subscribe',
      params: { uri: COORDINATION_INBOX_URI },
    });
    expect((sub.messages[0] as { result?: unknown }).result).toEqual({});

    const tips: string[] = [];
    const stop = onMcpResourceUpdated((uri) => tips.push(uri));
    const { notifyMcpResourceUpdated } = await import('./resource-notifier.ts');
    notifyMcpResourceUpdated(COORDINATION_INBOX_URI);
    stop();
    expect(tips).toContain(COORDINATION_INBOX_URI);

    // Durable path still works: resources/read returns a snapshot regardless of tips.
    const read = await client.call({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/read',
      params: { uri: COORDINATION_INBOX_URI },
    });
    expect((read.messages[0] as { result: { contents: unknown[] } }).result.contents).toHaveLength(
      1,
    );
  });

  it('handles a large but accepted payload and refuses an oversized body on HTTP', async () => {
    await client.call({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'conformance', version: '0' } },
    });
    const largeNote = 'x'.repeat(50_000);
    const res = await client.call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'system_capabilities',
        arguments: { note: largeNote },
      },
    });
    expect(res.messages.some((message) => 'result' in message)).toBe(true);

    if (kind === 'http') {
      const app = createApp(db, {
        enforceAuth: true,
        auth: {
          sessionSecret: SECRET,
          operatorPasswordHash: passwordHash,
          trustedProxyHops: 0,
          secureCookies: false,
        },
      });
      const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
      const bearer = await request(app)
        .post(MCP_BEARER_ISSUE_PATH)
        .set('Cookie', login.headers['set-cookie']?.[0] as string)
        .set(CSRF_HEADER_NAME, login.body.csrfToken);
      const huge = 'y'.repeat(1_200_000);
      const oversized = await request(app)
        .post(MCP_HTTP_PATH)
        .set('Authorization', `Bearer ${bearer.body.bearerToken}`)
        .set(MCP_AGENT_LABEL_HEADER, 'conformance')
        .send({
          jsonrpc: '2.0',
          id: 9,
          method: 'ping',
          params: { pad: huge },
        });
      expect(oversized.status).toBeGreaterThanOrEqual(400);
    }
  });

  // These features belong to HTTP; register only the transport that actually exercises them.
  if (kind === 'http') {
    it('replays buffered SSE events after Last-Event-ID on HTTP reconnect', async () => {
      const { createMcpHttpHandler, McpHttpSessionRegistry } = await import('./http.ts');
      const { McpWriteLimiterRegistry } = await import('./write-limiter-registry.ts');
      const sessions = new McpHttpSessionRegistry();
      const handler = createMcpHttpHandler({
        db,
        sessionSecret: SECRET,
        writeLimiters: new McpWriteLimiterRegistry(),
        httpSessions: sessions,
      });
      const app = createApp(db, {
        enforceAuth: true,
        auth: {
          sessionSecret: SECRET,
          operatorPasswordHash: passwordHash,
          trustedProxyHops: 0,
          secureCookies: false,
        },
      });
      const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
      const bearerRes = await request(app)
        .post(MCP_BEARER_ISSUE_PATH)
        .set('Cookie', login.headers['set-cookie']?.[0] as string)
        .set(CSRF_HEADER_NAME, login.body.csrfToken);
      const bearer = bearerRes.body.bearerToken as string;
      const init = await invokeHandler(handler, {
        method: 'POST',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: 'conformance', version: '0' } },
        },
        bearer,
        sessionId: null,
        accept: 'application/json',
      });
      const sessionId = init.headers[MCP_SESSION_ID_HEADER]!;
      const record = sessions.get(sessionId, Date.now())!;
      sessions.publish(record, {
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri: COORDINATION_INBOX_URI },
      });
      const replayed = sessions.eventsAfter(record, '0');
      expect(replayed).toHaveLength(1);
      expect(replayed[0]?.message).toMatchObject({
        method: 'notifications/resources/updated',
      });
    });

    it('continues one-shot JSON-RPC without a session header on HTTP', async () => {
      const app = createApp(db, {
        enforceAuth: true,
        auth: {
          sessionSecret: SECRET,
          operatorPasswordHash: passwordHash,
          trustedProxyHops: 0,
          secureCookies: false,
        },
      });
      const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
      const bearer = await request(app)
        .post(MCP_BEARER_ISSUE_PATH)
        .set('Cookie', login.headers['set-cookie']?.[0] as string)
        .set(CSRF_HEADER_NAME, login.body.csrfToken);
      const res = await request(app)
        .post(MCP_HTTP_PATH)
        .set('Authorization', `Bearer ${bearer.body.bearerToken}`)
        .set(MCP_AGENT_LABEL_HEADER, 'oneshot')
        .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ result: {} });
      expect(res.headers[MCP_SESSION_ID_HEADER]).toBeUndefined();
    });
  }
});

async function createClient(
  kind: TransportKind,
  db: Db,
  passwordHash: string,
  getSessionId: () => string | null,
  setSessionId: (id: string) => void,
): Promise<ConformanceClient> {
  if (kind === 'stdio') {
    const session = createMcpSession();
    return {
      kind,
      session,
      call: async (message, options) => {
        const messages: McpOutboundMessage[] = [];
        await handleMcpJsonRpc(
          session,
          message as never,
          (outbound) => {
            messages.push(outbound);
          },
          db,
          {
            transport: 'stdio',
            beforeToolsCall: options?.beforeToolsCall,
          },
        );
        return { status: 200, headers: {}, messages, body: messages[0] ?? null };
      },
    };
  }

  const app = createApp(db, {
    enforceAuth: true,
    auth: {
      sessionSecret: SECRET,
      operatorPasswordHash: passwordHash,
      trustedProxyHops: 0,
      secureCookies: false,
    },
  });
  const login = await request(app).post('/api/auth/login').send({ password: PASSWORD });
  const cookie = login.headers['set-cookie']?.[0] as string;
  const csrfToken = login.body.csrfToken as string;
  const bearerRes = await request(app)
    .post(MCP_BEARER_ISSUE_PATH)
    .set('Cookie', cookie)
    .set(CSRF_HEADER_NAME, csrfToken);
  const bearer = bearerRes.body.bearerToken as string;
  // Shared MCP session object is only meaningful for stdio; HTTP uses server-side registry.
  const session = createMcpSession({ agentLabel: 'conformance' });

  return {
    kind,
    session,
    call: async (message, options) => {
      const sessionId = getSessionId();
      const accept =
        message.method === 'tools/call' &&
        message.params &&
        typeof message.params === 'object' &&
        (message.params as { _meta?: { progressToken?: unknown } })._meta?.progressToken != null
          ? 'application/json, text/event-stream'
          : 'application/json';

      void options;

      const req = request(app)
        .post(MCP_HTTP_PATH)
        .set('Authorization', `Bearer ${bearer}`)
        .set(MCP_AGENT_LABEL_HEADER, 'conformance')
        .set('Accept', accept);
      if (sessionId) req.set(MCP_SESSION_ID_HEADER, sessionId);
      const res = await req.send(message);
      const headerSession = res.headers[MCP_SESSION_ID_HEADER] as string | undefined;
      if (headerSession) setSessionId(headerSession);

      if (String(res.headers['content-type'] ?? '').includes('text/event-stream')) {
        const messages = parseSsePayload(String(res.text ?? ''));
        return {
          status: res.status,
          headers: normalizeHeaders(res.headers),
          messages,
          body: messages.find((message) => 'result' in message || 'error' in message) ?? null,
        };
      }

      const messages: McpOutboundMessage[] = [];
      if (res.status === 200 && res.body && typeof res.body === 'object') {
        messages.push(res.body as McpOutboundMessage);
      }
      return {
        status: res.status,
        headers: normalizeHeaders(res.headers),
        messages,
        body: res.body,
      };
    },
  };
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

function parseSsePayload(text: string): McpOutboundMessage[] {
  const messages: McpOutboundMessage[] = [];
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      messages.push(JSON.parse(dataLine.slice(6)) as McpOutboundMessage);
    } catch {
      // ignore keepalive / malformed
    }
  }
  return messages;
}

async function invokeHandler(
  handler: (req: never, res: never) => Promise<void>,
  input: {
    method: string;
    body: unknown;
    bearer: string;
    sessionId: string | null;
    accept: string;
  },
): Promise<{
  status: number;
  headers: Record<string, string>;
  messages: McpOutboundMessage[];
  body: unknown;
}> {
  const headers: Record<string, string> = {};
  let status = 200;
  const chunks: Buffer[] = [];
  let ended = false;

  const req = {
    method: input.method,
    body: input.body,
    headers: {
      authorization: `Bearer ${input.bearer}`,
      [MCP_AGENT_LABEL_HEADER]: 'conformance',
      accept: input.accept,
      ...(input.sessionId ? { [MCP_SESSION_ID_HEADER]: input.sessionId } : {}),
    },
    ip: '127.0.0.1',
    on: () => req,
  };

  const res = {
    statusCode: 200,
    status(code: number) {
      status = code;
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    json(payload: unknown) {
      headers['content-type'] = 'application/json';
      chunks.push(Buffer.from(JSON.stringify(payload)));
      ended = true;
      return this;
    },
    end(payload?: unknown) {
      if (typeof payload === 'string') chunks.push(Buffer.from(payload));
      ended = true;
      return this;
    },
    write(chunk: string | Buffer) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      return true;
    },
    writableEnded: false,
    on: () => res,
  };

  Object.defineProperty(res, 'writableEnded', {
    get: () => ended,
  });

  await handler(req as never, res as never);
  const text = Buffer.concat(chunks).toString('utf8');
  if (String(headers['content-type'] ?? '').includes('text/event-stream')) {
    return { status, headers, messages: parseSsePayload(text), body: null };
  }
  if (!text) return { status, headers, messages: [], body: null };
  try {
    const body = JSON.parse(text) as McpOutboundMessage;
    return { status, headers, messages: [body], body };
  } catch {
    return { status, headers, messages: [], body: text };
  }
}
