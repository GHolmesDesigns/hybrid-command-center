/**
 * Read-only MCP connection diagnostic (C124 `system_connection_status`).
 *
 * Verifies protocol surfaces without creating handoffs or other workspace writes.
 */
import { APP_VERSION } from '../../shared/branding.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import type { McpConnectionStatus } from '../../shared/mcp-health.ts';
import { MCP_PROTOCOL_VERSION } from '../../shared/mcp-transport.ts';
import { WORKSPACE_CONTEXT_URI } from '../../shared/mcp-workspace-context.ts';
import { getStoreId, type Db } from '../db.ts';
import { MCP_CAPABILITY_VERSION, mcpToolsListPayload } from './registry.ts';
import { MCP_RESOURCE_DEFINITIONS, readMcpResource } from './resources.ts';

export type ConnectionStatusOptions = {
  transport: McpConnectionStatus['transport'];
  authenticated: boolean;
  agentLabel: string | null;
  grantedScopes: readonly McpAgentScope[];
  now?: Date;
};

export function buildConnectionStatus(
  db: Db,
  options: ConnectionStatusOptions,
): McpConnectionStatus {
  const now = options.now ?? new Date();
  const tools = mcpToolsListPayload();
  const resources = MCP_RESOURCE_DEFINITIONS.map((resource) => ({ ...resource }));

  let resourceReadOk = false;
  let resourceByteLength: number | undefined;
  let resourceReadDetail: string | undefined;
  try {
    const body = readMcpResource(db, WORKSPACE_CONTEXT_URI, {
      grantedScopes: options.grantedScopes,
      now,
    });
    resourceByteLength = new TextEncoder().encode(body.text).length;
    resourceReadOk = resourceByteLength > 0;
  } catch (error) {
    resourceReadDetail = error instanceof Error ? error.message : 'Resource read failed.';
  }

  const checks = {
    toolsList: {
      ok: tools.length > 0,
      toolCount: tools.length,
      ...(tools.length ? {} : { detail: 'tools/list returned no tools.' }),
    },
    resourcesList: {
      ok: resources.length > 0,
      resourceCount: resources.length,
      ...(resources.length ? {} : { detail: 'resources/list returned no resources.' }),
    },
    resourceRead: {
      ok: resourceReadOk,
      uri: WORKSPACE_CONTEXT_URI,
      ...(resourceByteLength !== undefined ? { byteLength: resourceByteLength } : {}),
      ...(resourceReadDetail ? { detail: resourceReadDetail } : {}),
    },
  };

  const ok =
    options.authenticated &&
    checks.toolsList.ok &&
    checks.resourcesList.ok &&
    checks.resourceRead.ok;

  return {
    ok,
    transport: options.transport,
    authenticated: options.authenticated,
    protocolVersion: MCP_PROTOCOL_VERSION,
    agentLabel: options.agentLabel,
    grantedScopes: [...options.grantedScopes],
    storeId: getStoreId(db),
    serverVersion: APP_VERSION,
    capabilityVersion: MCP_CAPABILITY_VERSION,
    serverClock: now.toISOString(),
    checks,
    testedAt: now.toISOString(),
  };
}
