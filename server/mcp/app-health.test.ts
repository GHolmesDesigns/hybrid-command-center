import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { hashPassword } from '../auth/password.ts';
import { setSetting } from '../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { CSRF_HEADER_NAME } from '../../shared/auth.ts';
import * as healthPanelModule from './health-panel.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';

describe('MCP health HTTP routes', () => {
  let db: Db;
  let passwordHash: string;

  beforeEach(async () => {
    db = createDb(':memory:');
    passwordHash = await hashPassword(PASSWORD);
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, passwordHash);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      db.close();
    } catch {
      // already closed
    }
  });

  const authedApp = () =>
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
    const response = await request(authedApp())
      .post('/api/auth/login')
      .send({ password: PASSWORD });
    expect(response.status).toBe(200);
    return {
      cookie: response.headers['set-cookie']?.[0] as string,
      csrfToken: response.body.csrfToken as string,
    };
  }

  it('returns the health panel for an authenticated operator', async () => {
    const { cookie } = await login();
    const response = await request(authedApp()).get('/api/mcp/health').set('Cookie', cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      state: 'never_connected',
      agents: [],
    });
  });

  it('runs the connection diagnostic without changing workspace checksums', async () => {
    const { cookie, csrfToken } = await login();
    const response = await request(authedApp())
      .post('/api/mcp/health/test')
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken);
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.workspaceChecksumUnchanged).toBe(true);
    expect(response.body.status.transport).toBe('operator');
  });

  it('proves only a successful call from the selected credential', async () => {
    const { cookie, csrfToken } = await login();
    const issued = await request(authedApp())
      .post('/api/auth/mcp-agents')
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken)
      .send({
        label: 'verification-client',
        scopes: ['coordination:read'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(issued.status).toBe(201);
    const credentialId = issued.body.credential.id as string;
    const bearerToken = issued.body.bearerToken as string;

    const pending = await request(authedApp())
      .get(`/api/mcp/health/verification/${credentialId}`)
      .set('Cookie', cookie);
    expect(pending.status).toBe(200);
    expect(pending.body).toMatchObject({
      credentialId,
      agentLabel: 'verification-client',
      status: 'pending',
      verifiedAt: null,
    });
    expect(JSON.stringify(pending.body)).not.toContain(bearerToken);

    const clientCall = await request(authedApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${bearerToken}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(clientCall.status).toBe(200);

    const verified = await request(authedApp())
      .get(`/api/mcp/health/verification/${credentialId}`)
      .set('Cookie', cookie);
    expect(verified.body).toMatchObject({
      credentialId,
      agentLabel: 'verification-client',
      status: 'verified',
      verifiedAt: expect.any(String),
    });
    expect(JSON.stringify(verified.body)).not.toContain(bearerToken);

    await request(authedApp())
      .post(`/api/auth/mcp-credentials/${credentialId}/revoke`)
      .set('Cookie', cookie)
      .set(CSRF_HEADER_NAME, csrfToken);
    const oldClientCall = await request(authedApp())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${bearerToken}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(oldClientCall.status).toBe(401);
    const revoked = await request(authedApp())
      .get(`/api/mcp/health/verification/${credentialId}`)
      .set('Cookie', cookie);
    expect(revoked.body).toMatchObject({
      credentialId,
      status: 'revoked',
      verifiedAt: expect.any(String),
    });
  });

  it('reports an unknown credential as unverified', async () => {
    const { cookie } = await login();
    const response = await request(authedApp())
      .get('/api/mcp/health/verification/never-issued')
      .set('Cookie', cookie);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      credentialId: 'never-issued',
      status: 'not_found',
      verifiedAt: null,
    });
  });

  it('refuses the diagnostic test when auth is disabled on the host', async () => {
    const response = await request(createApp(db)).post('/api/mcp/health/test');
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Authentication is not required/);
  });

  it('returns an unavailable payload when the panel builder throws', async () => {
    vi.spyOn(healthPanelModule, 'buildMcpHealthPanel').mockImplementation(() => {
      throw new Error('panel unavailable');
    });
    const { cookie } = await login();
    const response = await request(authedApp()).get('/api/mcp/health').set('Cookie', cookie);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      state: 'unavailable',
      stateReason: 'panel unavailable',
    });
  });
});
