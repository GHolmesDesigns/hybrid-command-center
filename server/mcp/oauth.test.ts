import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../app.ts';
import { createDb, type Db } from '../db.ts';
import { hashPassword } from '../auth/password.ts';
import { setSetting } from '../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { MCP_HTTP_PATH } from '../../shared/mcp-network.ts';
import {
  MCP_OAUTH_ALLOWED_REDIRECT_URIS,
  MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN,
  MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
} from '../../shared/mcp-oauth.ts';

const SECRET = 'test-session-secret-at-least-32-chars!';
const PASSWORD = 'operator-password-ok';
const ORIGIN = 'https://hcc.example.com';

describe('MCP OAuth routes', () => {
  let db: Db;

  beforeEach(async () => {
    db = createDb(':memory:');
    setSetting(db, OPERATOR_PASSWORD_HASH_SETTING_KEY, await hashPassword(PASSWORD));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* closed */
    }
  });

  function app() {
    return createApp(db, {
      enforceAuth: true,
      appOrigin: ORIGIN,
      auth: {
        sessionSecret: SECRET,
        secureCookies: true,
        productionTlsTerminated: true,
        trustedProxyHopsConfigured: true,
      },
    });
  }

  it('serves protected-resource and authorization-server metadata', async () => {
    const resource = await request(app())
      .get(MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN)
      .expect(200);
    expect(resource.body.resource).toBe(`${ORIGIN}/api/mcp`);

    const server = await request(app())
      .get(MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN)
      .expect(200);
    expect(server.body.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(server.body.registration_endpoint).toBe(`${ORIGIN}/register`);
  });

  it('returns WWW-Authenticate on unauthenticated MCP requests', async () => {
    const res = await request(app()).post(MCP_HTTP_PATH).send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      `${ORIGIN}/.well-known/oauth-protected-resource`,
    );
  });

  it('registers, approves, and exchanges an authorization code end to end', async () => {
    const redirectUri = MCP_OAUTH_ALLOWED_REDIRECT_URIS[0];
    const register = await request(app())
      .post('/register')
      .send({
        redirect_uris: [redirectUri],
        client_name: 'Claude Chat',
        token_endpoint_auth_method: 'none',
      })
      .expect(201);
    const clientId = register.body.client_id as string;

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const login = await request(app()).post('/api/auth/login').send({ password: PASSWORD }).expect(200);
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0] ?? '';

    const approve = await request(app())
      .get('/authorize/approve')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'state-123',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
      .set('Cookie', cookie)
      .expect(302);
    const location = approve.headers.location as string;
    expect(location.startsWith(redirectUri)).toBe(true);
    const code = new URL(location).searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await request(app())
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      })
      .expect(200);
    expect(token.body.access_token).toMatch(/^hcc_mcp_/);
    expect(token.body.token_type).toBe('Bearer');
  });
});
