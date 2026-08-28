/**
 * Unified async MCP tool dispatch (C122).
 *
 * Routes `tools/call` through the registry so coordination reads, workspace reads, and
 * system_capabilities share one entry point. Scope checks run here for stdio; HTTP repeats
 * credential scope checks before calling in.
 */
import type { Db } from '../db.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import {
  mcpCoordinationScopeRequired,
  mcpCoordinationUnknownTool,
  mcpWorkspaceScopeRequired,
} from '../../shared/mcp-coordination-errors.ts';
import { callCoordinationTool, type McpToolCallResult } from './coordination.ts';
import { buildWorkspaceContextDescriptor } from './workspace-context.ts';
import {
  mcpToolAvailable,
  mcpToolRegistryEntry,
  workspaceContextFiltersFromToolArgs,
  type McpToolRegistryEntry,
} from './registry.ts';
import { callWorkspaceReadTool, type McpWorkspaceReadDeps } from './workspace-read.ts';
import { redactToolResult } from './redact.ts';
import type { McpSession } from './session.ts';
import { buildConnectionStatus } from './connection-status.ts';

export type McpToolDispatchOptions = {
  grantedScopes: readonly McpAgentScope[];
  now?: Date;
  workspaceReadDeps?: McpWorkspaceReadDeps;
  transport?: 'stdio' | 'http';
  authenticated?: boolean;
};

const refused = (
  error: string,
  errorDetail: ReturnType<typeof mcpCoordinationScopeRequired>,
): McpToolCallResult => ({
  outcome: 'REFUSED',
  error,
  errorDetail,
});

function scopeRefusal(entry: McpToolRegistryEntry): McpToolCallResult {
  const scope = entry.requiredScope!;
  if (scope.startsWith('workspace:')) {
    return refused(
      `Credential lacks ${scope}.`,
      mcpWorkspaceScopeRequired(scope as 'workspace:read' | 'workspace:write'),
    );
  }
  return refused(
    `Credential lacks ${scope}.`,
    mcpCoordinationScopeRequired(scope as 'coordination:read' | 'coordination:write'),
  );
}

export async function callMcpTool(
  db: Db,
  session: McpSession,
  tool: string,
  rawArgs: unknown,
  options: McpToolDispatchOptions,
): Promise<McpToolCallResult> {
  const entry = mcpToolRegistryEntry(tool);
  if (!entry) {
    return {
      outcome: 'FAILURE',
      error: `Unknown tool: ${tool}.`,
      errorDetail: mcpCoordinationUnknownTool(),
    };
  }

  if (entry.requiredScope && !mcpToolAvailable(entry, options.grantedScopes)) {
    return scopeRefusal(entry);
  }

  const now = options.now ?? new Date();

  switch (entry.handler) {
    case 'coordination':
      return callCoordinationTool(db, session, tool, rawArgs, now);
    case 'workspace_read':
      return callWorkspaceReadTool(db, tool, rawArgs, {
        ...options.workspaceReadDeps,
        now,
      });
    case 'system_capabilities': {
      const payload = buildWorkspaceContextDescriptor(db, {
        grantedScopes: options.grantedScopes,
        filters: workspaceContextFiltersFromToolArgs(rawArgs),
        now,
      });
      return { outcome: 'SUCCESS', data: redactToolResult(payload) };
    }
    case 'system_connection_status': {
      const payload = buildConnectionStatus(db, {
        transport: options.transport ?? 'stdio',
        authenticated: options.authenticated ?? true,
        agentLabel: session.agentLabel,
        grantedScopes: options.grantedScopes,
        now,
      });
      return { outcome: 'SUCCESS', data: redactToolResult(payload) };
    }
  }
}
