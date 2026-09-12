import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { parse } from 'smol-toml';
import { buildMcpClientConfig, MCP_CLIENT_SERVER_NAME } from '../../shared/mcp-client-config.ts';
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
import {
  createMcpHttpHandler,
  handleMcpHttpPost,
  mcpHttpCsrfOk,
  resolveMcpHttpAuth,
} from './http.ts';
import { createSession } from '../auth/sessions.ts';
import { listMcpAgentEvents } from './events.ts';
import { COORDINATION_WRITE_LIMIT_PER_MINUTE } from '../../shared/mcp-agent-events.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';

describe('network MCP (C113)', () => {
  let db: Db;
  let passwordHash: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  const app = () =>
    createApp(db, {
      enforceAuth: true,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
    });

  async function login() {
    const res = await request(app()).post('/api/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    return {
      csrfToken: res.body.csrfToken as string,
      cookie: res.headers['set-cookie']?.[0] as string,
    };
  }

  async function issueBearer(cookie: string, csrfToken: string) {
    const res = await request(app())
      .post(MCP_BEARER_ISSUE_PATH)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken);
    expect(res.status).toBe(200);
    return res.body.bearerToken as string;
  }

  async function issueScopedBearer(
    cookie: string,
    csrfToken: string,
    label: string,
    scopes: string[],
  ) {
    const res = await request(app())
      .post('/api/auth/mcp-agents')
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send({ label, scopes, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(res.status).toBe(201);
    return res.body as {
      bearerToken: string;
      credential: { id: string; agentId: string };
    };
  }

  it('refuses unauthenticated MCP requests', async () => {
    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(401);
  });

  it('refuses cookie-authenticated mutations without CSRF', async () => {
    const { cookie } = await login();
    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Cookie', cookie)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/);
  });

  it('lists coordination tools over bearer auth like stdio', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(200);
    expect(
      res.body.result.tools.some(
        (tool: { name: string }) => tool.name === 'coordination_post_handoff',
      ),
    ).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/hcc_mcp_|session-secret|password/i);
  });

  it('lists and gets the shared prompt definitions over HTTP', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    const listed = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 30, method: 'prompts/list' });
    expect(listed.status).toBe(200);
    expect(listed.body.result.prompts).toHaveLength(5);

    const fetched = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({
        jsonrpc: '2.0',
        id: 31,
        method: 'prompts/get',
        params: { name: 'start_claimed_work', arguments: { handoffId: 'handoff-http' } },
      });
    expect(fetched.status).toBe(200);
    expect(fetched.body.result.messages[0].content.text).toContain('handoff-http');
    expect(fetched.body.result.messages[0].content.text).toContain('coordination_claim_handoff');
  });

  it('posts a handoff over bearer auth when agent_label is set', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: 'From network MCP.' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(false);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.state).toBe('OPEN');
    expect(payload.fromAgentProvenance).toBe('ASSERTED');

    const listed = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'coordination_list_handoffs', arguments: {} },
      });
    expect(JSON.parse(listed.body.result.content[0].text).handoffs[0]).toMatchObject({
      fromAgentLabel: 'cursor',
      fromAgentProvenance: 'ASSERTED',
    });
  });

  it.each(['cursor', 'claude', 'codex'] as const)(
    'authenticates unchanged %s config as its credential label',
    async (platform) => {
      const { cookie, csrfToken } = await login();
      const label = `${platform}-planning`;
      const issued = await issueScopedBearer(cookie, csrfToken, label, [
        'coordination:read',
        'coordination:write',
      ]);
      const config = buildMcpClientConfig({
        platform,
        transport: 'http',
        agentLabel: label,
        origin: 'https://hcc.example.com',
        bearerToken: issued.bearerToken,
        embedSecret: true,
      });
      const connection =
        config.format === 'toml'
          ? (
              parse(config.content) as {
                mcp_servers: Record<string, { url: string; http_headers: Record<string, string> }>;
              }
            ).mcp_servers[MCP_CLIENT_SERVER_NAME]
          : (
              JSON.parse(config.content) as {
                mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
              }
            ).mcpServers[MCP_CLIENT_SERVER_NAME];
      const headers = 'http_headers' in connection ? connection.http_headers : connection.headers;
      expect(headers).not.toHaveProperty(MCP_AGENT_LABEL_HEADER);
      const accepted = await request(app())
        .post(new URL(connection.url).pathname)
        .set(headers)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'coordination_post_handoff',
            arguments: { subjectType: 'freeform', message: 'Generated configuration identity.' },
          },
        });
      expect(accepted.status).toBe(200);
      expect(accepted.body.result.isError).toBe(false);
      expect(JSON.parse(accepted.body.result.content[0].text).fromAgentLabel).toBe(label);
    },
  );

  it('binds a scoped credential to its server-side label and audits header impersonation', async () => {
    const { cookie, csrfToken } = await login();
    const issued = await issueScopedBearer(cookie, csrfToken, 'cursor-planning', [
      'coordination:read',
      'coordination:write',
    ]);

    const refused = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .set(MCP_AGENT_LABEL_HEADER, 'codex-release')
      .send({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.data).toMatchObject({
      code: 'COORDINATION_CREDENTIAL_LABEL_MISMATCH',
      retryable: false,
    });
    expect(listMcpAgentEvents(db)[0]).toMatchObject({
      agentLabel: 'cursor-planning',
      outcome: 'REFUSED',
    });

    const accepted = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: 'Server-bound identity.' },
        },
      });
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body.result.content[0].text)).toMatchObject({
      fromAgentLabel: 'cursor-planning',
      fromAgentProvenance: 'VERIFIED',
    });

    const listed = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'coordination_list_handoffs', arguments: {} },
      });
    expect(JSON.parse(listed.body.result.content[0].text).handoffs[0]).toMatchObject({
      fromAgentLabel: 'cursor-planning',
      fromAgentProvenance: 'VERIFIED',
    });
  });

  it('allows reads but refuses writes without coordination:write', async () => {
    const { cookie, csrfToken } = await login();
    const issued = await issueScopedBearer(cookie, csrfToken, 'read-only-agent', [
      'coordination:read',
    ]);

    const read = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'coordination_list_handoffs', arguments: {} },
      });
    expect(read.status).toBe(200);
    expect(read.body.result.isError).toBe(false);

    const write = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: 'Must be refused.' },
        },
      });
    expect(write.status).toBe(403);
    expect(write.body.error.data.code).toBe('COORDINATION_SCOPE_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS total FROM agent_handoffs').get()).toEqual({ total: 0 });
  });

  it('refuses workspace reads without workspace:read scope', async () => {
    const { cookie, csrfToken } = await login();
    const issued = await issueScopedBearer(cookie, csrfToken, 'coordination-only', [
      'coordination:read',
    ]);

    const read = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: { name: 'workspace_dashboard_summary', arguments: {} },
      });
    expect(read.status).toBe(403);
    expect(read.body.error.data.code).toBe('WORKSPACE_SCOPE_REQUIRED');
  });

  it('allows workspace reads with workspace:read scope', async () => {
    const { cookie, csrfToken } = await login();
    const issued = await issueScopedBearer(cookie, csrfToken, 'reader', ['workspace:read']);

    const read = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name: 'workspace_dashboard_summary', arguments: {} },
      });
    expect(read.status).toBe(200);
    expect(read.body.result.isError).toBe(false);
    expect(JSON.parse(read.body.result.content[0].text).counts).toBeDefined();
  });

  it('revokes one scoped credential without interrupting another', async () => {
    const { cookie, csrfToken } = await login();
    const first = await issueScopedBearer(cookie, csrfToken, 'cursor', ['coordination:read']);
    const second = await issueScopedBearer(cookie, csrfToken, 'codex', ['coordination:read']);

    const revoked = await request(app())
      .post(`/api/auth/mcp-credentials/${first.credential.id}/revoke`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken);
    expect(revoked.status).toBe(200);

    const firstCall = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${first.bearerToken}`)
      .send({ jsonrpc: '2.0', id: 24, method: 'ping' });
    const secondCall = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${second.bearerToken}`)
      .send({ jsonrpc: '2.0', id: 25, method: 'ping' });
    expect(firstCall.status).toBe(401);
    expect(secondCall.status).toBe(200);
  });

  it('keeps scoped credential lifetime independent from its issuing operator session', async () => {
    const { cookie, csrfToken } = await login();
    const issued = await issueScopedBearer(cookie, csrfToken, 'independent-agent', [
      'coordination:read',
    ]);
    await request(app()).post('/api/auth/logout').set('Cookie', cookie);

    const call = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${issued.bearerToken}`)
      .send({ jsonrpc: '2.0', id: 26, method: 'ping' });
    expect(call.status).toBe(200);
  });

  it('refuses coordination writes without agent_label header', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: 'No label.' },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toMatch(/agent_label/);
  });

  it('revokes bearer on logout', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    await request(app()).post('/api/auth/logout').set('Cookie', cookie);

    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    expect(res.status).toBe(401);
  });

  it('refuses a password change under an env hash and leaves the bearer intact', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    const changed = await request(app())
      .post('/api/auth/password')
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send({ currentPassword: PASSWORD, newPassword: 'new-operator-password-ok!' });
    expect(changed.status).toBe(409);

    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    expect(res.status).toBe(200);
  });

  it('revokes bearer on password change', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    // The env hash always wins, so a rotation can only land on a host where it is unset and the
    // settings row is live. Same db, so the session cookie and the bearer carry over.
    const settingsRowApp = createApp(db, {
      enforceAuth: true,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: '',
        trustedProxyHops: 0,
        secureCookies: false,
      },
    });

    const changed = await request(settingsRowApp)
      .post('/api/auth/password')
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send({ currentPassword: PASSWORD, newPassword: 'new-operator-password-ok!' });
    expect(changed.status).toBe(200);

    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 5, method: 'ping' });
    expect(res.status).toBe(401);
  });

  it('allows cookie session MCP with CSRF on mutations', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .set(MCP_AGENT_LABEL_HEADER, 'cursor')
      .send({ jsonrpc: '2.0', id: 6, method: 'ping' });
    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({});
  });

  it('refuses invalid bearer tokens and malformed JSON-RPC bodies', async () => {
    const badBearer = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Authorization', 'Bearer hcc_mcp_not-in-database')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(badBearer.status).toBe(401);
    expect(badBearer.body).toMatchObject({
      error: 'MCP authentication failed.',
      code: 'MCP_CREDENTIAL_INVALID',
    });
    expect(badBearer.body.message).toMatch(/previous SESSION_SECRET/);

    const { cookie, csrfToken } = await login();
    const invalidBody = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send('not-json');
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body.error.code).toBe(-32700);
  });

  it('refuses an invalid agent label header before JSON-RPC runs', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .set(MCP_AGENT_LABEL_HEADER, 'bad label!')
      .send({ jsonrpc: '2.0', id: 7, method: 'ping' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
  });

  it('returns 202 for notifications without an id', async () => {
    const { cookie, csrfToken } = await login();
    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });
});

/**
 * The network write rate limit must persist across separate `POST /api/mcp` requests, not reset
 * with the fresh `McpSession` each one builds (C116 / #366). Every request below reuses ONE
 * `createApp()` instance — the app-per-request pattern the other suites use would rebuild the
 * registry every time and mask the exact bug this card fixes.
 */
describe('network MCP write rate limit persistence (C116)', () => {
  let db: Db;
  let passwordHash: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  const app = () =>
    createApp(db, {
      enforceAuth: true,
      auth: {
        sessionSecret: SECRET,
        operatorPasswordHash: passwordHash,
        trustedProxyHops: 0,
        secureCookies: false,
      },
    });

  async function login(instance: ReturnType<typeof app>) {
    const res = await request(instance).post('/api/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    return {
      csrfToken: res.body.csrfToken as string,
      cookie: res.headers['set-cookie']?.[0] as string,
    };
  }

  async function issueBearer(instance: ReturnType<typeof app>, cookie: string, csrfToken: string) {
    const res = await request(instance)
      .post(MCP_BEARER_ISSUE_PATH)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken);
    expect(res.status).toBe(200);
    return res.body.bearerToken as string;
  }

  function postHandoff(
    instance: ReturnType<typeof app>,
    bearer: string,
    label: string,
    id: number,
  ) {
    return request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .set(MCP_AGENT_LABEL_HEADER, label)
      .send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: `Write ${id}.` },
        },
      });
  }

  function listHandoffs(instance: ReturnType<typeof app>, bearer: string, id: number) {
    return request(instance)
      .post(MCP_HTTP_PATH)
      .set('Authorization', `Bearer ${bearer}`)
      .send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'coordination_list_handoffs', arguments: {} },
      });
  }

  it('refuses the 11th write with one bearer and one label, carrying retryAfterMs', async () => {
    const instance = app();
    const { cookie, csrfToken } = await login(instance);
    const bearer = await issueBearer(instance, cookie, csrfToken);

    for (let i = 1; i <= COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const res = await postHandoff(instance, bearer, 'cursor', i);
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(false);
    }

    const eleventh = await postHandoff(instance, bearer, 'cursor', 11);
    expect(eleventh.status).toBe(200);
    expect(eleventh.body.result.isError).toBe(true);
    const payload = JSON.parse(eleventh.body.result.content[0].text);
    expect(payload.outcome).toBe('REFUSED');
    expect(payload.error).toMatch(/rate limit/i);
    expect(payload.retryAfterMs).toBeGreaterThan(0);

    const events = listMcpAgentEvents(db, { tool: 'coordination_post_handoff' });
    const refused = events.find((event) => event.outcome === 'REFUSED');
    expect(refused?.agentLabel).toBe('cursor');
  });

  it('still hits the outer ceiling when eleven requests use eleven different agent labels', async () => {
    const instance = app();
    const { cookie, csrfToken } = await login(instance);
    const bearer = await issueBearer(instance, cookie, csrfToken);

    for (let i = 1; i <= COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const res = await postHandoff(instance, bearer, `cursor-${i}`, i);
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(false);
    }

    const eleventh = await postHandoff(instance, bearer, 'cursor-11', 11);
    const payload = JSON.parse(eleventh.body.result.content[0].text);
    expect(payload.outcome).toBe('REFUSED');
    expect(payload.error).toMatch(/rate limit/i);
  });

  it('does not share a write budget between two distinct bearers', async () => {
    const instance = app();
    const { cookie, csrfToken } = await login(instance);
    const bearerA = await issueBearer(instance, cookie, csrfToken);
    const bearerB = await issueBearer(instance, cookie, csrfToken);

    for (let i = 1; i <= COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const res = await postHandoff(instance, bearerA, 'cursor', i);
      expect(res.body.result.isError).toBe(false);
    }
    const bearerARefused = await postHandoff(instance, bearerA, 'cursor', 11);
    expect(JSON.parse(bearerARefused.body.result.content[0].text).outcome).toBe('REFUSED');

    const bearerBFirstWrite = await postHandoff(instance, bearerB, 'cursor', 12);
    expect(bearerBFirstWrite.body.result.isError).toBe(false);
  });

  it('never rate-limits reads', async () => {
    const instance = app();
    const { cookie, csrfToken } = await login(instance);
    const bearer = await issueBearer(instance, cookie, csrfToken);

    for (let i = 1; i <= COORDINATION_WRITE_LIMIT_PER_MINUTE + 5; i += 1) {
      const res = await listHandoffs(instance, bearer, i);
      expect(res.status).toBe(200);
      expect(res.body.result.isError).toBe(false);
    }
  });
});

/**
 * The `authRequired === false` branch (#356 / #362). Every suite above passes `enforceAuth: true`,
 * so nothing pinned the default derivation — a future change that mounted the MCP route above the
 * `authRequired` gate would publish an unauthenticated JSON-RPC surface on the app's own origin
 * and no test would go red. These construct the app on the incomplete local checklist rather than
 * passing `enforceAuth: false`, so they exercise the derivation production actually uses.
 */
describe('network MCP when auth is not required (C113)', () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(':memory:');
    // An operator password on record is the interesting case: even then, an incomplete checklist
    // must leave the network surface unmounted (loopback alone is not the gate).
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, await hashPassword(PASSWORD));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  it('does not mount the MCP route when auth is not required', async () => {
    const res = await request(createApp(db))
      .post(MCP_HTTP_PATH)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(404);
  });

  it('refuses to issue a bearer when auth is not required', async () => {
    const res = await request(createApp(db)).post(MCP_BEARER_ISSUE_PATH);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Authentication is not required on this host.');
  });
});

describe('network MCP handler units', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('resolveMcpHttpAuth and mcpHttpCsrfOk cover cookie and bearer branches', () => {
    const session = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const cookieReq = {
      headers: { cookie: `hcc_session=${session.rawToken}` },
    } as Parameters<typeof resolveMcpHttpAuth>[0];
    const cookieAuth = resolveMcpHttpAuth(cookieReq, {
      db,
      sessionSecret: SECRET,
      now: () => 1_001,
    });
    expect(cookieAuth?.usedBearer).toBe(false);
    expect(
      mcpHttpCsrfOk(cookieAuth!, { headers: { [CSRF_HEADER_NAME]: session.csrfToken } } as never),
    ).toBe(true);
    expect(mcpHttpCsrfOk(cookieAuth!, { headers: { [CSRF_HEADER_NAME]: 'wrong' } } as never)).toBe(
      false,
    );
  });

  it('createMcpHttpHandler rejects unsupported methods', async () => {
    const handler = createMcpHttpHandler({ db, sessionSecret: SECRET });
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
    };
    await handler({ method: 'PUT', headers: {}, body: {} } as never, res as never);
    expect(res.statusCode).toBe(405);
  });

  it('handleMcpHttpPost returns 401 without auth', async () => {
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
    };
    await handleMcpHttpPost({ headers: {}, body: {} } as never, res as never, {
      db,
      sessionSecret: SECRET,
    });
    expect(res.statusCode).toBe(401);
  });
});
