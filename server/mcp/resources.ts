/**
 * MCP resource adapters (C111 coordination inbox, C120 workspace context, C132 change feeds).
 */
import type { Db } from '../db.ts';
import { listHandoffs } from '../agent-coordination/service.ts';
import { readChangeFeed } from '../change-feeds.ts';
import { COORDINATION_INBOX_URI } from '../../shared/mcp-agent-events.ts';
import {
  COORDINATION_CHANGES_URI,
  MCP_CHANGE_FEED_SCOPE,
  WORKSPACE_CHANGES_URI,
  parseChangeFeedUri,
} from '../../shared/mcp-change-feeds.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import { MCP_AGENT_SCOPES } from '../../shared/mcp-agent-registry.ts';
import {
  mcpCoordinationScopeRequired,
  mcpWorkspaceScopeRequired,
} from '../../shared/mcp-coordination-errors.ts';
import { hasMcpAgentScope } from '../auth/mcp-agent-credentials.ts';
import { redactToolResult } from './redact.ts';
import {
  readWorkspaceContextResource,
  WORKSPACE_CONTEXT_RESOURCE_DEFINITION,
} from './workspace-context.ts';

export const COORDINATION_RESOURCE_DEFINITIONS = [
  {
    uri: COORDINATION_INBOX_URI,
    name: 'Coordination inbox',
    description: 'Open and claimed agent handoffs (active inbox).',
    mimeType: 'application/json',
  },
  {
    uri: COORDINATION_CHANGES_URI,
    name: 'Coordination change feed',
    description:
      'Resumable coordination changes after an opaque cursor (?after=). Expired cursors return cursor_expired.',
    mimeType: 'application/json',
  },
] as const;

export const WORKSPACE_CHANGE_RESOURCE_DEFINITION = {
  uri: WORKSPACE_CHANGES_URI,
  name: 'Workspace change feed',
  description:
    'Resumable workspace changes after an opaque cursor (?after=). Expired cursors return cursor_expired.',
  mimeType: 'application/json',
} as const;

export const MCP_RESOURCE_DEFINITIONS = [
  ...COORDINATION_RESOURCE_DEFINITIONS,
  WORKSPACE_CONTEXT_RESOURCE_DEFINITION,
  WORKSPACE_CHANGE_RESOURCE_DEFINITION,
] as const;

export function readCoordinationResource(
  db: Db,
  uri: string,
): {
  uri: string;
  mimeType: string;
  text: string;
} {
  const normalized = uri.trim();
  if (normalized !== COORDINATION_INBOX_URI && !isOpenInboxUri(normalized)) {
    throw new Error(`Unknown coordination resource: ${uri}`);
  }
  const open = listHandoffs(db, { state: 'OPEN' });
  const claimed = listHandoffs(db, { state: 'CLAIMED' });
  const payload = redactToolResult({
    state: 'open',
    handoffs: [...open, ...claimed].sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
    }),
  });
  return {
    uri: COORDINATION_INBOX_URI,
    mimeType: 'application/json',
    text: JSON.stringify(payload),
  };
}

export function readChangeFeedResource(
  db: Db,
  uri: string,
  grantedScopes: readonly McpAgentScope[] = MCP_AGENT_SCOPES,
): {
  uri: string;
  mimeType: string;
  text: string;
} {
  const parsed = parseChangeFeedUri(uri);
  if (!parsed) {
    throw new Error(`Unknown change-feed resource: ${uri}`);
  }
  const required = MCP_CHANGE_FEED_SCOPE[parsed.feed];
  if (!hasMcpAgentScope(grantedScopes, required)) {
    const detail =
      parsed.feed === 'coordination'
        ? mcpCoordinationScopeRequired('coordination:read')
        : mcpWorkspaceScopeRequired('workspace:read');
    throw new Error(
      `Missing MCP scope ${required}. ${detail.requiredAction ?? 'Ask the operator for access.'}`,
    );
  }
  const result = readChangeFeed(db, parsed.feed, {
    after: parsed.after,
    limit: parsed.limit,
  });
  const canonical =
    parsed.feed === 'coordination' ? COORDINATION_CHANGES_URI : WORKSPACE_CHANGES_URI;
  return {
    uri: canonical,
    mimeType: 'application/json',
    text: JSON.stringify(redactToolResult(result)),
  };
}

export function readMcpResource(
  db: Db,
  uri: string,
  options: { grantedScopes?: readonly McpAgentScope[]; now?: Date } = {},
): {
  uri: string;
  mimeType: string;
  text: string;
} {
  const normalized = uri.trim();
  const grantedScopes = options.grantedScopes ?? MCP_AGENT_SCOPES;
  if (parseChangeFeedUri(normalized)) {
    return readChangeFeedResource(db, normalized, grantedScopes);
  }
  if (normalized.startsWith('hcc://workspace/context')) {
    return readWorkspaceContextResource(db, normalized, options.grantedScopes, options.now);
  }
  return readCoordinationResource(db, normalized);
}

function isOpenInboxUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return (
      parsed.protocol === 'hcc:' &&
      parsed.hostname === 'coordination' &&
      parsed.pathname === '/inbox' &&
      (parsed.searchParams.get('state') === 'open' || parsed.searchParams.get('state') === null)
    );
  } catch {
    return false;
  }
}
