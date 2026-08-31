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

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

/** The hidden inputs of the rendered consent form, as a browser would submit them. */
function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)" \/>/g)) {
    fields[decodeEntities(match[1])] = decodeEntities(match[2]);
  }
  return fields;
}

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
    const resource = await request(app()).get(MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN).expect(200);
    expect(resource.body.resource).toBe(`${ORIGIN}/api/mcp`);

    const server = await request(app()).get(MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN).expect(200);
    expect(server.body.token_endpoint).toBe(`${ORIGIN}/token`);
    expect(server.body.registration_endpoint).toBe(`${ORIGIN}/register`);
  });

  it('returns WWW-Authenticate on unauthenticated MCP requests', async () => {
    const res = await request(app())
      .post(MCP_HTTP_PATH)
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      `${ORIGIN}/.well-known/oauth-protected-resource`,
    );
  });

  async function beginFlow() {
    const redirectUri = MCP_OAUTH_ALLOWED_REDIRECT_URIS[0];
    const register = await request(app())
      .post('/register')
      .send({
        redirect_uris: [redirectUri],
        client_name: 'Claude Chat',
        token_endpoint_auth_method: 'none',
      })
      .expect(201);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const login = await request(app())
      .post('/api/auth/login')
      .send({ password: PASSWORD })
      .expect(200);
    return {
      redirectUri,
      clientId: register.body.client_id as string,
      verifier,
      challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      cookie: login.headers['set-cookie']?.[0]?.split(';')[0] ?? '',
    };
  }

  type Flow = Awaited<ReturnType<typeof beginFlow>>;

  function authorizeQuery(flow: Flow) {
    return {
      response_type: 'code',
      client_id: flow.clientId,
      redirect_uri: flow.redirectUri,
      state: 'state-123',
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
    };
  }

  /** Render the consent page an operator actually sees and read back what its form would submit. */
  async function consentFields(flow: Flow, cookie = flow.cookie) {
    const consent = await request(app())
      .get('/authorize')
      .query(authorizeQuery(flow))
      .set('Cookie', cookie)
      .expect(200);
    return hiddenFields(consent.text);
  }

  it('registers, approves, and exchanges an authorization code end to end', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    expect(fields.approval_token).toBeTruthy();
    expect(fields.client_id).toBe(flow.clientId);

    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send(fields)
      .set('Cookie', flow.cookie)
      .expect(302);
    const location = approve.headers.location as string;
    expect(location.startsWith(flow.redirectUri)).toBe(true);
    const code = new URL(location).searchParams.get('code');
    expect(code).toBeTruthy();

    const token = await request(app())
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: flow.verifier,
      })
      .expect(200);
    expect(token.body.access_token).toMatch(/^hcc_mcp_/);
    expect(token.body.token_type).toBe('Bearer');
  });

  // The consent screen is the only thing standing between a registered connector and a scoped
  // token, so the cases below are what stop it from being bypassed rather than read.
  it('does not approve on GET, so a followed link cannot mint a code', async () => {
    const flow = await beginFlow();
    const approve = await request(app())
      .get('/authorize/approve')
      .query(authorizeQuery(flow))
      .set('Cookie', flow.cookie);
    expect(approve.status).toBe(404);
    expect(approve.headers.location).toBeUndefined();
  });

  it('refuses an approval POST with no approval token', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    delete fields.approval_token;
    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send(fields)
      .set('Cookie', flow.cookie);
    expect(approve.status).toBe(403);
    expect(approve.headers.location).toBeUndefined();
  });

  it('refuses an approval token minted for a different session', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    const other = await beginFlow();
    const otherFields = await consentFields(other);
    expect(otherFields.approval_token).not.toBe(fields.approval_token);

    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send({ ...fields, approval_token: otherFields.approval_token })
      .set('Cookie', flow.cookie);
    expect(approve.status).toBe(403);
    expect(approve.headers.location).toBeUndefined();
  });

  it('sends an unauthenticated approval POST back through sign-in', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    const approve = await request(app()).post('/authorize/approve').type('form').send(fields);
    expect(approve.status).toBe(401);
    expect(approve.text).toContain('/authorize/login');
  });

  it('rejects an unsupported scope instead of granting every scope', async () => {
    const flow = await beginFlow();
    const consent = await request(app())
      .get('/authorize')
      .query({ ...authorizeQuery(flow), scope: 'hcc:not-a-real-scope' })
      .set('Cookie', flow.cookie);
    expect(consent.status).toBe(400);
    expect(consent.text).toContain('Unsupported scope');
  });
});
