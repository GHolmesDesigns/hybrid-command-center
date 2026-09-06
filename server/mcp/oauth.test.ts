import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import express from 'express';
import { createApp } from '../app.ts';
import { createMcpOAuthRouter } from './oauth-routes.ts';
import { createDb, type Db } from '../db.ts';
import { hashPassword } from '../auth/password.ts';
import { setSetting } from '../drive/service.ts';
import { OPERATOR_PASSWORD_HASH_SETTING_KEY } from '../auth/service.ts';
import { revokeAllSessions } from '../auth/sessions.ts';
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

  it('refuses a code whose approving operator session was revoked', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send(fields)
      .set('Cookie', flow.cookie)
      .expect(302);
    const code = new URL(approve.headers.location as string).searchParams.get('code');

    revokeAllSessions(db);

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
      .expect(400);
    expect(token.body.error).toBe('invalid_grant');
    expect(token.body.error_description).toContain('operator session');
  });

  it('signs in from the consent page and returns to the pending request', async () => {
    const flow = await beginFlow();
    const returnTo = `/authorize?${new URLSearchParams(authorizeQuery(flow)).toString()}`;

    const signedOut = await request(app())
      .get('/authorize')
      .query(authorizeQuery(flow))
      .expect(200);
    expect(signedOut.text).toContain('/authorize/login');

    const login = await request(app())
      .post('/authorize/login')
      .type('form')
      .send({ returnTo, password: PASSWORD })
      .expect(302);
    expect(login.headers.location).toBe(returnTo);
    expect(login.headers['set-cookie']?.[0]).toContain('hcc_session=');
  });

  // No wrong-password case here on purpose: `operatorLogin`'s progressive delay is process-wide,
  // so a failed attempt in this file throttles every later test's sign-in. Failed-login handling is
  // covered where it belongs, against the auth service.
  it('refuses a return path that points off this origin', async () => {
    const foreign = await request(app())
      .post('/authorize/login')
      .type('form')
      .send({ returnTo: 'https://evil.example.com/', password: PASSWORD })
      .expect(400);
    expect(foreign.headers['set-cookie']).toBeUndefined();
  });

  it('denies without writing anything', async () => {
    const flow = await beginFlow();
    const deny = await request(app())
      .get('/authorize/deny')
      .query(authorizeQuery(flow))
      .set('Cookie', flow.cookie)
      .expect(302);
    const location = new URL(deny.headers.location as string);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('state')).toBe('state-123');
    expect(location.searchParams.get('code')).toBeNull();

    await request(app()).get('/authorize/deny').query({ response_type: 'code' }).expect(400);
  });

  it('rejects a malformed or unknown authorization request', async () => {
    const flow = await beginFlow();
    const malformed = await request(app())
      .get('/authorize')
      .query({ ...authorizeQuery(flow), code_challenge: 'too-short' })
      .set('Cookie', flow.cookie)
      .expect(400);
    expect(malformed.text).toContain('authorization request was invalid');

    const unknown = await request(app())
      .get('/authorize')
      .query({ ...authorizeQuery(flow), client_id: crypto.randomUUID() })
      .set('Cookie', flow.cookie)
      .expect(400);
    expect(unknown.text).toContain('Unknown OAuth client');
  });

  it('rejects an approval POST whose parameters do not parse', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send({ ...fields, code_challenge: 'too-short' })
      .set('Cookie', flow.cookie)
      .expect(400);
    expect(approve.headers.location).toBeUndefined();
  });

  it('refuses a replayed or unknown authorization code', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send(fields)
      .set('Cookie', flow.cookie)
      .expect(302);
    const code = new URL(approve.headers.location as string).searchParams.get('code');
    const exchange = () =>
      request(app()).post('/token').type('form').send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: flow.verifier,
      });

    await exchange().expect(200);
    const replay = await exchange().expect(400);
    expect(replay.body.error).toBe('invalid_grant');

    const badVerifier = await request(app())
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'not-a-real-code',
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: flow.verifier,
      })
      .expect(400);
    expect(badVerifier.body.error).toBe('invalid_grant');
  });

  it('rejects client registration with a redirect URI that is not a Claude callback', async () => {
    const bad = await request(app())
      .post('/register')
      .send({ redirect_uris: ['https://evil.example.com/cb'], client_name: 'Nope' })
      .expect(400);
    expect(bad.body.error).toBe('invalid_client_metadata');
  });

  it('registers a client that requests refresh_token support, granting only what it supports', async () => {
    // Claude Desktop's MCP client requests grant_types: ["authorization_code", "refresh_token"]
    // unconditionally. This server only implements authorization_code — that must not fail the
    // whole registration, per RFC 7591 (unsupported-but-recognized values just aren't granted).
    const redirectUri = MCP_OAUTH_ALLOWED_REDIRECT_URIS[0];
    const register = await request(app())
      .post('/register')
      .send({
        redirect_uris: [redirectUri],
        client_name: 'Claude Desktop',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
      .expect(201);
    expect(register.body.grant_types).toEqual(['authorization_code']);
    expect(register.body.response_types).toEqual(['code']);
  });

  it('rejects client registration with an unrecognized grant type', async () => {
    const redirectUri = MCP_OAUTH_ALLOWED_REDIRECT_URIS[0];
    const bad = await request(app())
      .post('/register')
      .send({ redirect_uris: [redirectUri], grant_types: ['client_credentials'] })
      .expect(400);
    expect(bad.body.error).toBe('invalid_client_metadata');
  });

  it('labels and names a connector that registered without a name', async () => {
    const redirectUri = MCP_OAUTH_ALLOWED_REDIRECT_URIS[0];
    const register = await request(app())
      .post('/register')
      .send({ redirect_uris: [redirectUri] })
      .expect(201);
    const clientId = register.body.client_id as string;
    const login = await request(app())
      .post('/api/auth/login')
      .send({ password: PASSWORD })
      .expect(200);
    const cookie = login.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
    const verifier = crypto.randomBytes(32).toString('base64url');

    const consent = await request(app())
      .get('/authorize')
      .query({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'state-123',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })
      .set('Cookie', cookie)
      .expect(200);
    expect(consent.text).toContain('Claude connector');
    expect(consent.text).toContain(`claude-oauth-${clientId.slice(0, 8)}`);
  });

  it('ignores a repeated authorization parameter rather than carrying it forward', async () => {
    const flow = await beginFlow();
    // Express turns `state=a&state=b` into an array, which is not a value the form may echo.
    const consent = await request(app())
      .get(`/authorize?${new URLSearchParams(authorizeQuery(flow)).toString()}&state=second`)
      .set('Cookie', flow.cookie);
    expect(consent.status).toBe(400);
  });

  it('treats a revoked client as unknown', async () => {
    const flow = await beginFlow();
    db.prepare('UPDATE mcp_oauth_clients SET revoked_at = ? WHERE client_id = ?').run(
      new Date().toISOString(),
      flow.clientId,
    );
    const consent = await request(app())
      .get('/authorize')
      .query(authorizeQuery(flow))
      .set('Cookie', flow.cookie)
      .expect(400);
    expect(consent.text).toContain('Unknown OAuth client');
  });

  it('reports back to the callback when the client disappears before approval', async () => {
    const flow = await beginFlow();
    const fields = await consentFields(flow);
    db.prepare('UPDATE mcp_oauth_clients SET revoked_at = ? WHERE client_id = ?').run(
      new Date().toISOString(),
      flow.clientId,
    );

    const approve = await request(app())
      .post('/authorize/approve')
      .type('form')
      .send(fields)
      .set('Cookie', flow.cookie)
      .expect(302);
    const location = new URL(approve.headers.location);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('rejects a token request that does not parse', async () => {
    const malformed = await request(app()).post('/token').type('form').send({}).expect(400);
    expect(malformed.body.error).toBe('invalid_request');
  });

  it('ignores a request body that is not an object', async () => {
    const token = await request(app()).post('/token').type('json').send([]).expect(400);
    expect(token.body.error).toBe('invalid_request');

    const flow = await beginFlow();
    const approve = await request(app())
      .post('/authorize/approve')
      .type('json')
      .send([])
      .set('Cookie', flow.cookie)
      .expect(403);
    expect(approve.headers.location).toBeUndefined();
  });

  it('serves discovery when mounted without a rate limiter', async () => {
    const standalone = express();
    standalone.use(
      createMcpOAuthRouter({
        db,
        sessionSecret: SECRET,
        appOrigin: ORIGIN,
        secureCookies: true,
      }),
    );
    const resource = await request(standalone)
      .get(MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN)
      .expect(200);
    expect(resource.body.resource).toBe(`${ORIGIN}/api/mcp`);
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
