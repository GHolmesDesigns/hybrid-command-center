/**
 * Express routes for MCP OAuth discovery and the authorization_code + PKCE flow.
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import express from 'express';
import { ZodError } from 'zod';
import type { Db } from '../db.ts';
import { readSessionToken } from '../auth/cookies.ts';
import { buildSessionCookie } from '../auth/cookies.ts';
import { login as operatorLogin, sessionFromRawToken } from '../auth/service.ts';
import type { OperatorSessionRecord } from '../auth/sessions.ts';
import { clientAddress } from '../auth/client-address.ts';
import {
  agentLabelForOAuthClient,
  beginMcpOAuthAuthorization,
  exchangeMcpOAuthCode,
  McpOAuthError,
  parseAuthorizeRequest,
  readMcpOAuthClient,
  redirectWithAuthorizationCode,
  redirectWithOAuthError,
  registerMcpOAuthClient,
  registrationResponse,
} from '../auth/mcp-oauth.ts';
import {
  buildMcpAuthorizationServerMetadata,
  buildMcpProtectedResourceMetadata,
  mcpOAuthWwwAuthenticateHeader,
  MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN,
  MCP_OAUTH_AUTHORIZE_PATH,
  MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
  MCP_OAUTH_REGISTER_PATH,
  MCP_OAUTH_TOKEN_PATH,
} from '../../shared/mcp-oauth.ts';

export type McpOAuthRouteOptions = {
  db: Db;
  sessionSecret: string;
  appOrigin: string;
  secureCookies: boolean;
  operatorPasswordHash?: string;
  trustedProxyHops?: number;
  now?: () => number;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Constant-time comparison, so a mismatch does not leak where it stopped matching. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const MCP_OAUTH_APPROVE_PATH = `${MCP_OAUTH_AUTHORIZE_PATH}/approve`;
const MCP_OAUTH_DENY_PATH = `${MCP_OAUTH_AUTHORIZE_PATH}/deny`;
const APPROVAL_FORM_TOKEN_FIELD = 'approval_token';
const APPROVAL_FORM_TOKEN_PURPOSE = 'mcp-oauth-approve';

/**
 * The token the consent form carries, so an approval cannot be driven from another site.
 *
 * Approving used to be a bare `GET /authorize/approve`, which left the session cookie alone
 * deciding it — and that cookie is `SameSite=Lax`, which browsers do send on a top-level cross-site
 * navigation. Any link an operator followed could mint a code for a connector they never saw, and
 * because dynamic registration is open and the callback allowlist points at claude.ai, whoever
 * started that flow collected the token.
 *
 * Derived from the session rather than stored: an HMAC over the session's token hash is unforgeable
 * without the session secret and dies with the session it names. Deriving it also means the page
 * does not have to carry `session.csrfToken` — the header token the SPA sends on every write — which
 * would leave a value in page source that unlocks the rest of the API for the session's whole life.
 */
function approvalFormToken(session: OperatorSessionRecord, sessionSecret: string): string {
  return crypto
    .createHmac('sha256', sessionSecret)
    .update(`${APPROVAL_FORM_TOKEN_PURPOSE}:${session.tokenHash}`, 'utf8')
    .digest('hex');
}

function operatorSession(
  req: Request,
  options: McpOAuthRouteOptions,
): ReturnType<typeof sessionFromRawToken> {
  const raw = readSessionToken(req.headers.cookie);
  if (!raw) return null;
  return sessionFromRawToken(options.db, {
    rawToken: raw,
    sessionSecret: options.sessionSecret,
    now: options.now?.() ?? Date.now(),
  });
}

function oauthErrorStatus(error: McpOAuthError): number {
  if (error.errorCode === 'invalid_client' || error.errorCode === 'invalid_grant') return 400;
  if (error.errorCode === 'unauthorized_client') return 401;
  return 400;
}

function renderAuthorizePage(input: { title: string; body: string; actions?: string }): string {
  const actions = input.actions ?? '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
    .panel { border: 1px solid #d0d7de; border-radius: 8px; padding: 1.25rem; }
    label { display: block; margin: 0.75rem 0 0.25rem; font-weight: 600; }
    input[type=password] { width: 100%; padding: 0.5rem; box-sizing: border-box; }
    a.primary, button.primary { display: inline-block; background: #111827; color: #fff; padding: 0.6rem 1rem; border-radius: 6px; text-decoration: none; border: 0; cursor: pointer; }
    a.secondary { color: #374151; }
    .error { color: #b42318; }
  </style>
</head>
<body>
  <div class="panel">
    <h1>${escapeHtml(input.title)}</h1>
    ${input.body}
    ${actions}
  </div>
</body>
</html>`;
}

function renderLoginPage(returnTo: string, errorMessage?: string): string {
  const error = errorMessage ? `<p class="error" role="alert">${escapeHtml(errorMessage)}</p>` : '';
  return renderAuthorizePage({
    title: 'Sign in to Hybrid Command Center',
    body: `${error}
      <p>Claude is asking to connect to your Command Center. Sign in to approve the connector.</p>
      <form method="post" action="/authorize/login">
        <input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}" />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required />
        <p style="margin-top: 1rem"><button class="primary" type="submit">Sign in</button></p>
      </form>`,
  });
}

function renderConsentPage(input: {
  clientName: string;
  agentLabel: string;
  scopes: readonly string[];
  params: Record<string, string>;
  formToken: string;
  denyHref: string;
}): string {
  const scopeList = input.scopes
    .map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`)
    .join('');
  // The authorization parameters ride the POST body rather than the form action, because approving
  // ends in a redirect to claude.ai and anything left in the query string would ride the Referer
  // off-origin with it.
  const hidden = Object.entries(input.params)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`,
    )
    .join('\n        ');
  return renderAuthorizePage({
    title: 'Approve MCP connector',
    body: `<p><strong>${escapeHtml(input.clientName)}</strong> wants to connect as agent
      <code>${escapeHtml(input.agentLabel)}</code>.</p>
      <p>It will receive these capabilities:</p>
      <ul>${scopeList}</ul>
      <p>Only approve if you started this connection from Claude.</p>`,
    actions: `<form method="post" action="${escapeHtml(MCP_OAUTH_APPROVE_PATH)}">
        <input type="hidden" name="${APPROVAL_FORM_TOKEN_FIELD}" value="${escapeHtml(input.formToken)}" />
        ${hidden}
        <p><button class="primary" type="submit">Approve connector</button></p>
      </form>
      <p><a class="secondary" href="${escapeHtml(input.denyHref)}">Deny</a></p>`,
  });
}

/**
 * The parameters of an authorization request, carried forward by name.
 *
 * A fixed list rather than every query key: these are the only values `authorizeQuerySchema` reads,
 * and copying anything a caller sent would put attacker-chosen fields into the consent form.
 */
const AUTHORIZE_PARAM_NAMES = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'scope',
] as const;

function authorizeParams(source: Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const name of AUTHORIZE_PARAM_NAMES) {
    const value = source[name];
    if (typeof value === 'string') params[name] = value;
  }
  return params;
}

function authorizeQueryString(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function createMcpOAuthRouter(options: McpOAuthRouteOptions): Router {
  const router = express.Router();
  const issuer = options.appOrigin.replace(/\/+$/, '');

  router.get(MCP_OAUTH_PROTECTED_RESOURCE_WELL_KNOWN, (_req, res) => {
    res.json(buildMcpProtectedResourceMetadata({ issuer }));
  });

  router.get(MCP_OAUTH_AUTHORIZATION_SERVER_WELL_KNOWN, (_req, res) => {
    res.json(buildMcpAuthorizationServerMetadata({ issuer }));
  });

  router.post(MCP_OAUTH_REGISTER_PATH, express.json(), (req, res) => {
    try {
      const client = registerMcpOAuthClient(options.db, req.body, options.now?.());
      res.status(201).json(registrationResponse(client));
    } catch (error) {
      if (error instanceof ZodError) {
        res
          .status(400)
          .json({ error: 'invalid_client_metadata', error_description: error.message });
        return;
      }
      throw error;
    }
  });

  router.post(
    MCP_OAUTH_TOKEN_PATH,
    express.urlencoded({ extended: false }),
    express.json(),
    (req, res) => {
      try {
        const body =
          req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
        const token = exchangeMcpOAuthCode(options.db, body, {
          sessionSecret: options.sessionSecret,
          now: options.now?.(),
        });
        res.json(token);
      } catch (error) {
        if (error instanceof McpOAuthError) {
          res.status(oauthErrorStatus(error)).json({
            error: error.errorCode,
            error_description: error.message,
          });
          return;
        }
        if (error instanceof ZodError) {
          res.status(400).json({ error: 'invalid_request', error_description: error.message });
          return;
        }
        throw error;
      }
    },
  );

  router.get(MCP_OAUTH_AUTHORIZE_PATH, (req, res) => {
    let pending;
    try {
      pending = parseAuthorizeRequest(req.query as Record<string, unknown>);
    } catch (error) {
      // An McpOAuthError here names something the operator can act on — an unsupported scope, say —
      // so its message is worth showing. A ZodError's is not.
      const message =
        error instanceof McpOAuthError
          ? error.message
          : error instanceof ZodError
            ? 'The authorization request was invalid.'
            : 'Invalid request.';
      res.status(400).send(
        renderAuthorizePage({
          title: 'Connector authorization failed',
          body: `<p class="error">${escapeHtml(message)}</p>`,
        }),
      );
      return;
    }

    const client = readMcpOAuthClient(options.db, pending.clientId);
    if (!client) {
      res.status(400).send(
        renderAuthorizePage({
          title: 'Connector authorization failed',
          body: '<p class="error">Unknown OAuth client.</p>',
        }),
      );
      return;
    }

    const session = operatorSession(req, options);
    const params = authorizeParams(req.query as Record<string, unknown>);
    const query = authorizeQueryString(params);
    if (!session) {
      res.status(200).send(renderLoginPage(`${MCP_OAUTH_AUTHORIZE_PATH}?${query}`));
      return;
    }

    res.status(200).send(
      renderConsentPage({
        clientName: client.clientName ?? 'Claude connector',
        agentLabel: agentLabelForOAuthClient(client),
        scopes: pending.scopes,
        params,
        formToken: approvalFormToken(session, options.sessionSecret),
        denyHref: `${MCP_OAUTH_DENY_PATH}?${query}`,
      }),
    );
  });

  router.post(
    '/authorize/login',
    express.urlencoded({ extended: false }),
    async (req, res, next) => {
      try {
        const returnTo = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        if (!returnTo.startsWith(`${MCP_OAUTH_AUTHORIZE_PATH}?`)) {
          res.status(400).send('Invalid return path.');
          return;
        }
        const address = clientAddress(req, options.trustedProxyHops ?? 0);
        const result = await operatorLogin(options.db, {
          password,
          clientAddress: address,
          sessionSecret: options.sessionSecret,
          envHash: options.operatorPasswordHash,
          now: options.now?.() ?? Date.now(),
        });
        if (!result.ok) {
          res
            .status(result.retryAfterMs > 0 ? 429 : 401)
            .send(renderLoginPage(returnTo, result.error));
          return;
        }
        res.setHeader(
          'Set-Cookie',
          buildSessionCookie(result.rawToken, { secure: options.secureCookies }),
        );
        res.redirect(302, returnTo);
      } catch (error) {
        next(error);
      }
    },
  );

  // POST, not GET: minting an authorization code is the state change this whole flow exists to
  // make, and a GET made it reachable by anything that could get an operator to follow a link.
  router.post(MCP_OAUTH_APPROVE_PATH, express.urlencoded({ extended: false }), (req, res) => {
    const body: Record<string, unknown> =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const params = authorizeParams(body);

    const session = operatorSession(req, options);
    if (!session) {
      // The form outlived the session. Send them back through sign-in with the request intact
      // rather than dropping it, which is what the consent page's own login form does.
      res
        .status(401)
        .send(renderLoginPage(`${MCP_OAUTH_AUTHORIZE_PATH}?${authorizeQueryString(params)}`));
      return;
    }

    // Before anything else reads the request: an approval that cannot prove it came from this
    // origin's own consent page is not an approval.
    const submitted = body[APPROVAL_FORM_TOKEN_FIELD];
    const expected = approvalFormToken(session, options.sessionSecret);
    if (typeof submitted !== 'string' || !sameSecret(submitted, expected)) {
      res.status(403).send(
        renderAuthorizePage({
          title: 'Connector authorization failed',
          body: `<p class="error">This approval could not be verified. Start the connection again
            from Claude.</p>`,
        }),
      );
      return;
    }

    let pending;
    try {
      pending = parseAuthorizeRequest(body);
    } catch {
      res.status(400).send('Invalid authorization request.');
      return;
    }
    try {
      const { code } = beginMcpOAuthAuthorization(options.db, {
        ...pending,
        operatorSessionHash: session.tokenHash,
        now: options.now?.(),
      });
      res.redirect(
        302,
        redirectWithAuthorizationCode({
          redirectUri: pending.redirectUri,
          code,
          state: pending.oauthState,
        }),
      );
    } catch (error) {
      if (error instanceof McpOAuthError) {
        res.redirect(
          302,
          redirectWithOAuthError({
            redirectUri: pending.redirectUri,
            error: 'access_denied',
            state: pending.oauthState,
            description: error.message,
          }),
        );
        return;
      }
      throw error;
    }
  });

  // Still a GET: denying writes nothing, and a forced deny costs the operator a retry at worst.
  router.get(MCP_OAUTH_DENY_PATH, (req, res) => {
    let pending;
    try {
      pending = parseAuthorizeRequest(req.query as Record<string, unknown>);
    } catch {
      res.status(400).send('Invalid authorization request.');
      return;
    }
    res.redirect(
      302,
      redirectWithOAuthError({
        redirectUri: pending.redirectUri,
        error: 'access_denied',
        state: pending.oauthState,
        description: 'The operator denied the connector request.',
      }),
    );
  });

  return router;
}

export function sendMcpUnauthorized(res: Response, appOrigin: string): void {
  res.setHeader('WWW-Authenticate', mcpOAuthWwwAuthenticateHeader(appOrigin));
  res.status(401).json({ error: 'Authentication required.' });
}
