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

  it('revokes bearer on password change', async () => {
    const { cookie, csrfToken } = await login();
    const bearer = await issueBearer(cookie, csrfToken);

    const changed = await request(app())
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
});
