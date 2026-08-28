/**
 * MCP resource adapters (C111 coordination inbox, C120 workspace context).
 */
import type { Db } from '../db.ts';
import { listHandoffs } from '../agent-coordination/service.ts';
import { COORDINATION_INBOX_URI } from '../../shared/mcp-agent-events.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
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
] as const;

export const MCP_RESOURCE_DEFINITIONS = [
  ...COORDINATION_RESOURCE_DEFINITIONS,
  WORKSPACE_CONTEXT_RESOURCE_DEFINITION,
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
