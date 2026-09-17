/**
 * Streamable HTTP MCP adapter (C113 / #340, C133 / #383).
 *
 * `POST /api/mcp` accepts JSON-RPC. One-shot clients (no session header) still get one JSON
 * response on the same call — the compatibility floor. Clients that complete `initialize` receive
 * an `Mcp-Session-Id` and may continue the session, open a GET SSE stream for server
 * notifications, and DELETE the session when finished. Progress and resource-update tips never
 * replace C132 change-feed cursors.
 */
import type { Request, Response } from 'express';
import type { Db } from '../db.ts';
import { CSRF_HEADER_NAME } from '../../shared/auth.ts';
import {
  MCP_AGENT_LABEL_HEADER,
  MCP_BEARER_HEADER,
  MCP_HTTP_PATH,
} from '../../shared/mcp-network.ts';
import {
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_HEADER,
  MCP_SESSION_ID_HEADER,
  isSupportedMcpProtocolVersion,
  negotiateMcpProtocolVersion,
} from '../../shared/mcp-transport.ts';
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
import { MCP_AGENT_SCOPES } from '../../shared/mcp-agent-registry.ts';
import {
  handleMcpJsonRpc,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpOutboundMessage,
} from './stdio.ts';
import {
  createMcpSession,
  setMcpSessionAgentLabel,
  setMcpSessionIdentityProvenance,
  type McpSession,
} from './session.ts';
import type { McpWriteLimiterRegistry } from './write-limiter-registry.ts';
import type { McpIntegrationToolDeps } from './integration-tools.ts';
import type { McpWorkspaceReadDeps } from './workspace-read.ts';
import type { McpWorkspaceWriteDeps } from './workspace-write.ts';
import {
  mcpCoordinationCredentialLabelMismatch,
  mcpCoordinationScopeRequired,
  mcpDriveScopeRequired,
  mcpScopeRequired,
  mcpWorkspaceScopeRequired,
} from '../../shared/mcp-coordination-errors.ts';
import { recordMcpAgentEvent } from './events.ts';
import { mcpToolRegistryEntry } from './registry.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import { McpHttpSessionRegistry, type McpHttpSessionRecord } from './http-sessions.ts';
import { sendMcpUnauthorized } from './oauth-routes.ts';

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
  /** Separate process-lifetime budget for Class-I integration writes (C131), typically limit 6. */
  integrationWriteLimiters?: McpWriteLimiterRegistry;
  /** Process-lifetime streamable HTTP sessions (C133). Required in production; tests may omit. */
  httpSessions?: McpHttpSessionRegistry;
  workspaceReadDeps?: McpWorkspaceReadDeps;
  workspaceWriteDeps?: McpWorkspaceWriteDeps;
  integrationDeps?: McpIntegrationToolDeps;
  /** Test-only: await before tools/call work so a concurrent cancel can land. */
  beforeToolsCall?: (signal: AbortSignal) => Promise<void>;
  /** Deployment origin for MCP OAuth discovery on 401 responses. */
  appOrigin?: string;
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

function sessionIdHeader(req: Request): string | null {
  return headerValue(req.headers[MCP_SESSION_ID_HEADER]);
}

function protocolVersionHeader(req: Request): string | null {
  return headerValue(req.headers[MCP_PROTOCOL_VERSION_HEADER]);
}

function acceptIncludes(req: Request, type: string): boolean {
  const accept = headerValue(req.headers.accept) ?? '';
  return accept.split(',').some((part) => part.trim().toLowerCase().startsWith(type));
}

function wantsEventStream(req: Request): boolean {
  return acceptIncludes(req, 'text/event-stream');
}

function isJsonRpcNotification(message: JsonRpcRequest): boolean {
  return message.id === undefined && typeof message.method === 'string';
}

function isJsonRpcResponseMessage(message: JsonRpcRequest): boolean {
  return (
    message.id !== undefined &&
    message.method === undefined &&
    ('result' in message || 'error' in message)
  );
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
      setMcpSessionIdentityProvenance(session, 'ASSERTED');
      return session.agentLabel;
    }
    if (fromHeader !== null && fromHeader !== credential.agentLabel) {
      throw Object.assign(new Error('x-agent-label does not match the credential identity.'), {
        detail: mcpCoordinationCredentialLabelMismatch(),
      });
    }
    setMcpSessionAgentLabel(session, credential.agentLabel);
    setMcpSessionIdentityProvenance(session, 'VERIFIED');
    return credential.agentLabel;
  }
  if (fromHeader !== null) {
    setMcpSessionAgentLabel(session, fromHeader);
    setMcpSessionIdentityProvenance(session, 'ASSERTED');
    return fromHeader;
  }
  return session.agentLabel;
}

function requestedTool(request: JsonRpcRequest): string {
  if (request.method !== 'tools/call') return request.method ?? 'unknown';
  const params = request.params as { name?: unknown } | undefined;
  return typeof params?.name === 'string' ? params.name : 'tools/call';
}

function requiredToolScope(request: JsonRpcRequest): McpAgentScope | null {
  if (request.method !== 'tools/call') return null;
  return mcpToolRegistryEntry(requestedTool(request))?.requiredScope ?? null;
}

function writeSseEvent(res: Response, event: { id?: string; message: unknown }): void {
  if (event.id) res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event.message)}\n\n`);
}

function attachWriteLimiters(
  session: McpSession,
  auth: McpHttpAuthContext,
  options: McpHttpHandlerOptions,
  nowMs: number,
): void {
  if (options.writeLimiters) {
    session.coordinationWrites = options.writeLimiters.limiterFor(
      auth.credentialKey,
      session.agentLabel ?? '',
      nowMs,
    );
  }
  if (options.integrationWriteLimiters) {
    session.integrationWrites = options.integrationWriteLimiters.limiterFor(
      auth.credentialKey,
      session.agentLabel ?? '',
      nowMs,
    );
  }
}

function refuseLabelMismatch(
  res: Response,
  options: McpHttpHandlerOptions,
  auth: McpHttpAuthContext,
  request: JsonRpcRequest,
  error: unknown,
): void {
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
}

function refuseScope(
  res: Response,
  options: McpHttpHandlerOptions,
  auth: McpHttpAuthContext,
  request: JsonRpcRequest,
  required: McpAgentScope,
): void {
  const detail =
    required === 'workspace:read' || required === 'workspace:write'
      ? mcpWorkspaceScopeRequired(required)
      : required === 'drive:write-request'
        ? mcpDriveScopeRequired()
        : required === 'coordination:read' || required === 'coordination:write'
          ? mcpCoordinationScopeRequired(required)
          : mcpScopeRequired(required);
  recordMcpAgentEvent(options.db, {
    agentLabel: auth.agentCredential!.agentLabel,
    tool: requestedTool(request),
    outcome: 'REFUSED',
    summary: `Credential lacks ${required}.`,
  });
  res.status(403).json({
    jsonrpc: '2.0',
    id: request.id ?? null,
    error: { code: -32003, message: `Credential lacks ${required}.`, data: detail },
  });
}

async function runJsonRpc(
  mcpSession: McpSession,
  request: JsonRpcRequest,
  options: McpHttpHandlerOptions,
  auth: McpHttpAuthContext,
  nowMs: number,
  onMessage: (message: McpOutboundMessage) => void,
  httpRecord?: McpHttpSessionRecord | null,
): Promise<void> {
  const grantedScopes = auth.agentCredential?.scopes ?? MCP_AGENT_SCOPES;
  const notify = (message: JsonRpcNotification) => {
    onMessage(message);
    if (httpRecord) options.httpSessions?.publish(httpRecord, message);
  };
  await handleMcpJsonRpc(mcpSession, request, onMessage, options.db, {
    grantedScopes,
    now: new Date(nowMs),
    transport: 'http',
    authenticated: true,
    baseUrl: options.appOrigin ?? options.integrationDeps?.baseUrl ?? null,
    workspaceReadDeps: options.workspaceReadDeps,
    workspaceWriteDeps: options.workspaceWriteDeps,
    integrationDeps: {
      ...options.integrationDeps,
      baseUrl: options.appOrigin ?? options.integrationDeps?.baseUrl ?? null,
    },
    notify,
    beforeToolsCall: options.beforeToolsCall,
  });
}

function rejectMcpUnauthenticated(
  req: Request,
  res: Response,
  options: McpHttpHandlerOptions,
): void {
  const hasBearer = Boolean(readMcpBearerToken(req.headers[MCP_BEARER_HEADER]));
  if (options.appOrigin) {
    sendMcpUnauthorized(res, options.appOrigin, hasBearer ? 'invalid' : 'missing');
    return;
  }
  if (hasBearer) {
    res.status(401).json({
      error: 'MCP authentication failed.',
      code: 'MCP_CREDENTIAL_INVALID',
      message:
        'The MCP bearer credential was not accepted. It may have been issued under a previous SESSION_SECRET; issue a new credential after rotating that secret.',
    });
    return;
  }
  res.status(401).json({ error: 'Authentication required.' });
}

export async function handleMcpHttpPost(
  req: Request,
  res: Response,
  options: McpHttpHandlerOptions,
): Promise<void> {
  const auth = resolveMcpHttpAuth(req, options);
  if (!auth) {
    rejectMcpUnauthenticated(req, res, options);
    return;
  }
  if (!mcpHttpCsrfOk(auth, req)) {
    res.status(403).json({ error: 'CSRF token missing or invalid.' });
    return;
  }

  const protocolHeader = protocolVersionHeader(req);
  if (protocolHeader && !isSupportedMcpProtocolVersion(protocolHeader)) {
    res.status(400).json({ error: `Unsupported MCP-Protocol-Version: ${protocolHeader}` });
    return;
  }

  const body = req.body;
  if (Array.isArray(body)) {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Invalid Request: JSON-RPC batches are not supported; send one message per POST.',
      },
    });
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = body as JsonRpcRequest;
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

  // Client → server responses are accepted with 202 and ignored (no server-originated requests yet).
  if (isJsonRpcResponseMessage(request)) {
    res.status(202).end();
    return;
  }

  const nowMs = options.now?.() ?? Date.now();
  const sessions = options.httpSessions;
  const existingSessionId = sessionIdHeader(req);
  let httpRecord: McpHttpSessionRecord | null = null;
  let mcpSession: McpSession;
  let issuedSessionId: string | null = null;

  if (existingSessionId) {
    if (!sessions) {
      res.status(400).json({ error: 'MCP sessions are not available on this server.' });
      return;
    }
    httpRecord = sessions.get(existingSessionId, nowMs);
    if (!httpRecord) {
      res.status(404).json({ error: 'MCP session not found.' });
      return;
    }
    if (httpRecord.credentialKey !== auth.credentialKey) {
      res.status(403).json({ error: 'MCP session does not belong to this credential.' });
      return;
    }
    mcpSession = httpRecord.mcp;
  } else if (request.method === 'initialize' && sessions) {
    const requested =
      request.params && typeof request.params === 'object'
        ? (request.params as Record<string, unknown>).protocolVersion
        : undefined;
    const protocolVersion = negotiateMcpProtocolVersion(requested);
    httpRecord = sessions.create({
      credentialKey: auth.credentialKey,
      protocolVersion,
      nowMs,
    });
    mcpSession = httpRecord.mcp;
    issuedSessionId = httpRecord.id;
  } else {
    // Compatibility floor: one-shot JSON-RPC with a fresh session per POST.
    mcpSession = createMcpSession();
  }

  try {
    applyAgentLabel(mcpSession, req, auth.agentCredential);
  } catch (error) {
    refuseLabelMismatch(res, options, auth, request, error);
    return;
  }

  if (auth.agentCredential) {
    const required = requiredToolScope(request);
    if (required && !hasMcpAgentScope(auth.agentCredential.scopes, required)) {
      refuseScope(res, options, auth, request, required);
      return;
    }
  }

  attachWriteLimiters(mcpSession, auth, options, nowMs);

  if (isJsonRpcNotification(request)) {
    await runJsonRpc(mcpSession, request, options, auth, nowMs, () => {}, httpRecord);
    res.status(202).end();
    return;
  }

  const useSse = wantsEventStream(req);
  const responses: JsonRpcResponse[] = [];
  const notifications: JsonRpcNotification[] = [];

  if (useSse) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (issuedSessionId) res.setHeader(MCP_SESSION_ID_HEADER, issuedSessionId);
    if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as Response & { flushHeaders: () => void }).flushHeaders();
    }

    await runJsonRpc(
      mcpSession,
      request,
      options,
      auth,
      nowMs,
      (message) => {
        writeSseEvent(res, { message });
      },
      httpRecord,
    );
    res.end();
    return;
  }

  await runJsonRpc(
    mcpSession,
    request,
    options,
    auth,
    nowMs,
    (message) => {
      if ('method' in message && !('id' in message)) {
        notifications.push(message as JsonRpcNotification);
        return;
      }
      responses.push(message as JsonRpcResponse);
    },
    httpRecord,
  );

  const reply = responses[0];
  if (!reply) {
    if (issuedSessionId) res.setHeader(MCP_SESSION_ID_HEADER, issuedSessionId);
    res.status(204).end();
    return;
  }
  if (issuedSessionId) res.setHeader(MCP_SESSION_ID_HEADER, issuedSessionId);
  // One-shot JSON clients do not receive mid-request notifications on this path; progress is
  // available when Accept includes text/event-stream (or via the GET stream on a session).
  void notifications;
  res.status(200).json(reply);
}

export async function handleMcpHttpGet(
  req: Request,
  res: Response,
  options: McpHttpHandlerOptions,
): Promise<void> {
  const auth = resolveMcpHttpAuth(req, options);
  if (!auth) {
    rejectMcpUnauthenticated(req, res, options);
    return;
  }
  if (!wantsEventStream(req)) {
    res.status(405).json({ error: 'GET requires Accept: text/event-stream.' });
    return;
  }
  const sessions = options.httpSessions;
  const sessionId = sessionIdHeader(req);
  if (!sessions || !sessionId) {
    res.status(405).json({ error: 'SSE listen requires an MCP session.' });
    return;
  }
  const nowMs = options.now?.() ?? Date.now();
  const record = sessions.get(sessionId, nowMs);
  if (!record) {
    res.status(404).json({ error: 'MCP session not found.' });
    return;
  }
  if (record.credentialKey !== auth.credentialKey) {
    res.status(403).json({ error: 'MCP session does not belong to this credential.' });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader(MCP_SESSION_ID_HEADER, record.id);
  if (typeof (res as Response & { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as Response & { flushHeaders: () => void }).flushHeaders();
  }

  const lastEventId = headerValue(req.headers['last-event-id']);
  for (const event of sessions.eventsAfter(record, lastEventId)) {
    writeSseEvent(res, event);
  }

  const onEvent = (event: { id: string; message: unknown }) => {
    if (!res.writableEnded) writeSseEvent(res, event);
  };
  record.streamListeners.add(onEvent);

  const keepAlive = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    record.streamListeners.delete(onEvent);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

export async function handleMcpHttpDelete(
  req: Request,
  res: Response,
  options: McpHttpHandlerOptions,
): Promise<void> {
  const auth = resolveMcpHttpAuth(req, options);
  if (!auth) {
    rejectMcpUnauthenticated(req, res, options);
    return;
  }
  if (!mcpHttpCsrfOk(auth, req)) {
    res.status(403).json({ error: 'CSRF token missing or invalid.' });
    return;
  }
  const sessions = options.httpSessions;
  const sessionId = sessionIdHeader(req);
  if (!sessions || !sessionId) {
    res.status(405).json({ error: 'DELETE requires an MCP session.' });
    return;
  }
  const nowMs = options.now?.() ?? Date.now();
  const record = sessions.get(sessionId, nowMs);
  if (!record) {
    res.status(404).json({ error: 'MCP session not found.' });
    return;
  }
  if (record.credentialKey !== auth.credentialKey) {
    res.status(403).json({ error: 'MCP session does not belong to this credential.' });
    return;
  }
  sessions.delete(sessionId);
  res.status(204).end();
}

/** Express handler factory for `${MCP_HTTP_PATH}` (POST / GET / DELETE). */
export function createMcpHttpHandler(options: McpHttpHandlerOptions) {
  const sessions = options.httpSessions ?? new McpHttpSessionRegistry();
  const resolved: McpHttpHandlerOptions = { ...options, httpSessions: sessions };

  return async (req: Request, res: Response): Promise<void> => {
    if (req.method === 'POST') {
      await handleMcpHttpPost(req, res, resolved);
      return;
    }
    if (req.method === 'GET') {
      await handleMcpHttpGet(req, res, resolved);
      return;
    }
    if (req.method === 'DELETE') {
      await handleMcpHttpDelete(req, res, resolved);
      return;
    }
    res.status(405).json({ error: 'Method not allowed.' });
  };
}

export { MCP_HTTP_PATH, MCP_PROTOCOL_VERSION, McpHttpSessionRegistry };
