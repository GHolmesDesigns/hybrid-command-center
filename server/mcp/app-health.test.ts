import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { hashPassword } from '../auth/password.ts';
import { setSetting } from '../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '../../shared/auth.ts';
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
    const response = await request(authedApp()).post('/api/auth/login').send({ password: PASSWORD });
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
