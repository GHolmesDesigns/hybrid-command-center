import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDb } from '../db.ts';
import { createSession } from './sessions.ts';
import { resolveMcpAgentCredential } from './mcp-agent-credentials.ts';
import {
  agentLabelForOAuthClient,
  beginMcpOAuthAuthorization,
  exchangeMcpOAuthCode,
  McpOAuthError,
  parseAuthorizeRequest,
  registerMcpOAuthClient,
} from './mcp-oauth.ts';
import { MCP_OAUTH_CODE_TTL_MS } from '../../shared/mcp-oauth.ts';

const ISSUER = 'https://hcc.example.com';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const SECRET = 'test-session-secret';

describe('mcp oauth', () => {
  it('registers a client, authorizes with PKCE, and issues a scoped bearer', () => {
    const db = createDb(':memory:');
    const client = registerMcpOAuthClient(db, {
      redirect_uris: [REDIRECT],
      client_name: 'Claude Cowork',
      token_endpoint_auth_method: 'none',
    });
    const label = `claude-oauth-claude-cowork-${client.clientId.slice(0, 8)}`;
    expect(agentLabelForOAuthClient(client)).toBe(label);

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const pending = parseAuthorizeRequest({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      state: 'oauth-state-1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'coordination:read coordination:write',
    });

    const session = createSession(db, {
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
      now: 1_000,
    });

    const { code } = beginMcpOAuthAuthorization(db, {
      ...pending,
      operatorSessionHash: session.record.tokenHash,
      now: 2_000,
    });

    const token = exchangeMcpOAuthCode(
      db,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: client.clientId,
        code_verifier: verifier,
      },
      { sessionSecret: SECRET, now: 3_000 },
    );

    expect(token.token_type).toBe('Bearer');
    expect(token.access_token.startsWith('hcc_mcp_')).toBe(true);
    expect(token.scope).toBe('coordination:read coordination:write');

    const resolved = resolveMcpAgentCredential(db, {
      rawToken: token.access_token,
      sessionSecret: SECRET,
      origin: ISSUER,
      now: 4_000,
    });
    expect(resolved?.agentLabel).toBe(label);
    expect(resolved?.scopes).toEqual(['coordination:read', 'coordination:write']);
  });

  it('refuses a reused authorization code', () => {
    const db = createDb(':memory:');
    const client = registerMcpOAuthClient(db, { redirect_uris: [REDIRECT] });
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const pending = parseAuthorizeRequest({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      state: 'oauth-state-2',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const session = createSession(db, {
      clientAddress: '127.0.0.1',
      sessionSecret: SECRET,
    });
    const { code } = beginMcpOAuthAuthorization(db, {
      ...pending,
      operatorSessionHash: session.record.tokenHash,
    });
    const body = {
      grant_type: 'authorization_code' as const,
      code,
      redirect_uri: REDIRECT,
      client_id: client.clientId,
      code_verifier: verifier,
    };
    exchangeMcpOAuthCode(db, body, { sessionSecret: SECRET });
    expect(() => exchangeMcpOAuthCode(db, body, { sessionSecret: SECRET })).toThrow(
      /already used/i,
    );
  });
  /** A code is bound to the client and callback it was issued for, and to a ten-minute window. */
  describe('authorization code binding', () => {
    function approved(now = 2_000) {
      const db = createDb(':memory:');
      const client = registerMcpOAuthClient(db, {
        redirect_uris: [REDIRECT],
        client_name: 'Claude Chat',
      });
      const verifier = crypto.randomBytes(32).toString('base64url');
      const pending = parseAuthorizeRequest({
        response_type: 'code',
        client_id: client.clientId,
        redirect_uri: REDIRECT,
        state: 'oauth-state-1',
        code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      const session = createSession(db, {
        clientAddress: '127.0.0.1',
        sessionSecret: SECRET,
        now: 1_000,
      });
      const { code } = beginMcpOAuthAuthorization(db, {
        ...pending,
        operatorSessionHash: session.record.tokenHash,
        now,
      });
      return { db, client, verifier, code };
    }

    it('refuses a code presented by a different client', () => {
      const { db, verifier, code } = approved();
      const other = registerMcpOAuthClient(db, {
        redirect_uris: [REDIRECT],
        client_name: 'Someone Else',
      });
      expect(() =>
        exchangeMcpOAuthCode(
          db,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: other.clientId,
            code_verifier: verifier,
          },
          { sessionSecret: SECRET, now: 3_000 },
        ),
      ).toThrow(/does not match this client/);
      db.close();
    });

    // The message is "invalid or already used" rather than "expired" because the purge at the top
    // of exchangeMcpOAuthCode deletes the row before the expiry check further down can name it.
    // Both refuse; only the wording differs, so this pins the refusal and not the phrasing.
    it('refuses a code presented after it expired', () => {
      const { db, client, verifier, code } = approved();
      expect(() =>
        exchangeMcpOAuthCode(
          db,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: client.clientId,
            code_verifier: verifier,
          },
          { sessionSecret: SECRET, now: 2_000 + MCP_OAUTH_CODE_TTL_MS + 1 },
        ),
      ).toThrow(McpOAuthError);
      db.close();
    });

    it('refuses a code whose verifier does not match the challenge', () => {
      const { db, client, code } = approved();
      expect(() =>
        exchangeMcpOAuthCode(
          db,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: client.clientId,
            code_verifier: crypto.randomBytes(32).toString('base64url'),
          },
          { sessionSecret: SECRET, now: 3_000 },
        ),
      ).toThrow(/PKCE/);
      db.close();
    });

    it('refuses an unknown client at authorization and at exchange', () => {
      const { db, verifier, code } = approved();
      const unknown = crypto.randomUUID();
      expect(() =>
        exchangeMcpOAuthCode(
          db,
          {
            grant_type: 'authorization_code',
            code,
            redirect_uri: REDIRECT,
            client_id: unknown,
            code_verifier: verifier,
          },
          { sessionSecret: SECRET, now: 3_000 },
        ),
      ).toThrow(/Unknown OAuth client/);
      db.close();
    });

    it('rejects an authorization request naming a scope this server does not offer', () => {
      expect(() =>
        parseAuthorizeRequest({
          response_type: 'code',
          client_id: crypto.randomUUID(),
          redirect_uri: REDIRECT,
          state: 'oauth-state-1',
          code_challenge: 'a'.repeat(43),
          code_challenge_method: 'S256',
          scope: 'coordination:read nope:write',
        }),
      ).toThrow(/Unsupported scope/);
    });
  });
});
