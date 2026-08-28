/**
 * Streamable HTTP MCP adapter (C113 / #340).
 *
 * POST `/api/mcp` accepts one JSON-RPC request per call and returns a JSON-RPC response on the
 * same origin as the API. Operator auth is a session cookie or a bearer bound to that session;
 * cookie mutations also require CSRF. Scoped bearer identity is resolved server-side; the label
 * header is advisory and a mismatch is refused.
 */
import type { Request, Response } from 'express';
import type { Db } from '../db.ts';
import { CSRF_HEADER_NAME } from '../../shared/auth.ts';
import {
  MCP_AGENT_LABEL_HEADER,
  MCP_BEARER_HEADER,
  MCP_HTTP_PATH,
} from '../../shared/mcp-network.ts';
import { readSessionToken } from '../auth/cookies.ts';
import { readMcpBearerToken, resolveMcpBearer } from '../auth/mcp-bearers.ts';
import {
  hasMcpAgentScope,
  operatorBootstrapCredential,
  resolveMcpAgentCredential,
  type ResolvedMcpAgentCredential,
} from '../auth/mcp-agent-credentials.ts';
import { sessionFromRawToken } from '../auth/service.ts';
import type { OperatorSessionRecord } from '../auth/sessions.ts';
import { handleMcpJsonRpc, type JsonRpcRequest, type JsonRpcResponse } from './stdio.ts';
import { createMcpSession, setMcpSessionAgentLabel, type McpSession } from './session.ts';
import type { McpWriteLimiterRegistry } from './write-limiter-registry.ts';
import { COORDINATION_WRITE_TOOLS } from '../../shared/mcp-agent-events.ts';
import {
  mcpCoordinationCredentialLabelMismatch,
  mcpCoordinationScopeRequired,
} from '../../shared/mcp-coordination-errors.ts';
import { recordMcpAgentEvent } from './events.ts';

export type McpHttpAuthContext = {
  session: OperatorSessionRecord | null;
  usedBearer: boolean;
  agentCredential: ResolvedMcpAgentCredential | null;
  /**
   * The presented credential's own identity — the bearer's token hash when bearer-authenticated,
   * or the session's token hash for cookie auth. Deliberately not always `session.tokenHash`:
   * each bearer issued from one session gets its own write budget (C116), distinct from the
   * cookie session's own budget.
   */
  credentialKey: string;
};

export type McpHttpHandlerOptions = {
  db: Db;
  sessionSecret: string;
  now?: () => number;
  /** Process-lifetime coordination write budgets (C116). Omitted only in tests that don't
   *  exercise rate limiting — coordination writes then fall back to the per-request no-op limiter
   *  that reproduced the original bug, so production wiring must always pass one. */
  writeLimiters?: McpWriteLimiterRegistry;
};

function headerValue(raw: string | string[] | undefined): string | null {
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  return null;
}

function csrfHeader(req: Request): string | null {
  return headerValue(req.headers[CSRF_HEADER_NAME]);
}

function agentLabelHeader(req: Request): string | null {
  return headerValue(req.headers[MCP_AGENT_LABEL_HEADER]);
}

/** Resolve operator session from bearer or cookie. */
export function resolveMcpHttpAuth(
  req: Request,
  options: McpHttpHandlerOptions,
): McpHttpAuthContext | null {
  const now = options.now?.() ?? Date.now();
  const bearerRaw = readMcpBearerToken(req.headers[MCP_BEARER_HEADER]);
  if (bearerRaw) {
    const agentCredential = resolveMcpAgentCredential(options.db, {
      rawToken: bearerRaw,
      sessionSecret: options.sessionSecret,
      origin: req.ip || null,
      now,
    });
    if (agentCredential) {
      return {
        session: null,
        usedBearer: true,
        agentCredential,
        credentialKey: agentCredential.tokenHash,
      };
    }
    const resolved = resolveMcpBearer(options.db, {
      rawToken: bearerRaw,
      sessionSecret: options.sessionSecret,
      now,
    });
    if (!resolved) return null;
    return {
      session: resolved.session,
      usedBearer: true,
      agentCredential: operatorBootstrapCredential(resolved.bearer.tokenHash),
      credentialKey: resolved.bearer.tokenHash,
    };
  }

  const rawToken = readSessionToken(req.headers.cookie);
  const session = sessionFromRawToken(options.db, {
    rawToken,
    sessionSecret: options.sessionSecret,
    now,
  });
  if (!session) return null;
  return { session, usedBearer: false, agentCredential: null, credentialKey: session.tokenHash };
}

/** Fail closed when a cookie session POST lacks a matching CSRF token. Bearer auth skips CSRF. */
export function mcpHttpCsrfOk(auth: McpHttpAuthContext, req: Request): boolean {
  if (auth.usedBearer) return true;
  const token = csrfHeader(req);
  return Boolean(token && token === auth.session?.csrfToken);
}

function applyAgentLabel(
  session: McpSession,
  req: Request,
  credential: ResolvedMcpAgentCredential | null,
): string | null {
  const fromHeader = agentLabelHeader(req);
  if (credential) {
    if (credential.isBootstrap) {
      // Compatibility floor: operator-session bearers predate registrations. They are mapped to
      // the built-in full-coordination registration, while retaining their established label
      // header until the operator rotates them to a scoped credential.
      if (fromHeader !== null) setMcpSessionAgentLabel(session, fromHeader);
      return session.agentLabel;
    }
    if (fromHeader !== null && fromHeader !== credential.agentLabel) {
      throw Object.assign(new Error('x-agent-label does not match the credential identity.'), {
        detail: mcpCoordinationCredentialLabelMismatch(),
      });
    }
    setMcpSessionAgentLabel(session, credential.agentLabel);
    return credential.agentLabel;
  }
  if (fromHeader !== null) {
    setMcpSessionAgentLabel(session, fromHeader);
    return fromHeader;
  }
  return session.agentLabel;
}

const WRITE_TOOLS = new Set<string>(COORDINATION_WRITE_TOOLS);

function requestedTool(request: JsonRpcRequest): string {
  if (request.method !== 'tools/call') return request.method ?? 'unknown';
  const params = request.params as { name?: unknown } | undefined;
  return typeof params?.name === 'string' ? params.name : 'tools/call';
}

function requiredCoordinationScope(
  request: JsonRpcRequest,
): 'coordination:read' | 'coordination:write' {
  return WRITE_TOOLS.has(requestedTool(request)) ? 'coordination:write' : 'coordination:read';
}

export async function handleMcpHttpPost(
  req: Request,
  res: Response,
  options: McpHttpHandlerOptions,
): Promise<void> {
  const auth = resolveMcpHttpAuth(req, options);
  if (!auth) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  if (!mcpHttpCsrfOk(auth, req)) {
    res.status(403).json({ error: 'CSRF token missing or invalid.' });
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = req.body as JsonRpcRequest;
    if (!request || typeof request !== 'object') {
      throw new Error('Invalid JSON-RPC body.');
    }
  } catch {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }

  const session = createMcpSession();
  try {
    applyAgentLabel(session, req, auth.agentCredential);
  } catch (error) {
    const detail = (error as { detail?: ReturnType<typeof mcpCoordinationCredentialLabelMismatch> })
      .detail;
    if (detail) {
      recordMcpAgentEvent(options.db, {
        agentLabel: auth.agentCredential?.agentLabel ?? null,
        tool: requestedTool(request),
        outcome: 'REFUSED',
        summary: 'Credential label mismatch refused.',
      });
    }
    res.status(400).json({
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: {
        code: -32602,
        message: error instanceof Error ? error.message : 'Invalid agent label.',
        ...(detail ? { data: detail } : {}),
      },
    });
    return;
  }
  if (auth.agentCredential) {
    const required = requiredCoordinationScope(request);
    if (!hasMcpAgentScope(auth.agentCredential.scopes, required)) {
      const detail = mcpCoordinationScopeRequired(required);
      recordMcpAgentEvent(options.db, {
        agentLabel: auth.agentCredential.agentLabel,
        tool: requestedTool(request),
        outcome: 'REFUSED',
        summary: `Credential lacks ${required}.`,
      });
      res.status(403).json({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32003, message: `Credential lacks ${required}.`, data: detail },
      });
      return;
    }
  }
  // Replace the per-request no-op limiter with one backed by the process-lifetime registry, so
  // coordination writes actually accumulate across requests (C116). Label may still be null here
  // (coordination.ts refuses writes without one before ever consulting the limiter).
  if (options.writeLimiters) {
    const now = options.now?.() ?? Date.now();
    session.coordinationWrites = options.writeLimiters.limiterFor(
      auth.credentialKey,
      session.agentLabel ?? '',
      now,
    );
  }

  const responses: JsonRpcResponse[] = [];
  await handleMcpJsonRpc(
    session,
    request,
    (message) => {
      responses.push(message);
    },
    options.db,
  );

  const reply = responses[0];
  if (!reply) {
    res.status(204).end();
    return;
  }
  res.status(200).json(reply);
}

/** Express handler factory for `POST ${MCP_HTTP_PATH}`. */
export function createMcpHttpHandler(options: McpHttpHandlerOptions) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed.' });
      return;
    }
    await handleMcpHttpPost(req, res, options);
  };
}

export { MCP_HTTP_PATH };
