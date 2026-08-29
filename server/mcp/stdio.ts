/**
 * Local stdio MCP JSON-RPC adapter for coordination tools (C111).
 *
 * Minimal MCP subset: initialize, tools/*, resources/*, prompts/*, ping, progress, cancellation,
 * and resource subscriptions (C133). The stdin loop lives in `server/scripts/mcp.ts`
 * (`npm run mcp`); set `MCP_AGENT_LABEL` (or pass `_meta.agent_label` on initialize) for writes.
 */
import { getDb, type Db } from '../db.ts';
import { APP_VERSION } from '../../shared/branding.ts';
import { MCP_AGENT_SCOPES, type McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import { negotiateMcpProtocolVersion } from '../../shared/mcp-transport.ts';
import { COORDINATION_INBOX_URI } from '../../shared/mcp-agent-events.ts';
import { COORDINATION_CHANGES_URI, WORKSPACE_CHANGES_URI } from '../../shared/mcp-change-feeds.ts';
import { WORKSPACE_CONTEXT_URI } from '../../shared/mcp-workspace-context.ts';
import { callMcpTool } from './dispatch.ts';
import { mcpToolCallErrorPayload } from './coordination.ts';
import type { McpIntegrationToolDeps } from './integration-tools.ts';
import { MCP_RESOURCE_DEFINITIONS, canonicalMcpResourceUri, readMcpResource } from './resources.ts';
import { mcpToolsListPayload } from './registry.ts';
import { getMcpPrompt, mcpPromptsListPayload } from './prompts.ts';
import { notifyMcpResourceUpdated } from './resource-notifier.ts';
import {
  cancelMcpInFlight,
  clearMcpInFlight,
  mcpRequestCancelled,
  registerMcpInFlight,
  setMcpSessionAgentLabel,
  type McpSession,
} from './session.ts';
import type { McpWorkspaceReadDeps } from './workspace-read.ts';
import type { McpWorkspaceWriteDeps } from './workspace-write.ts';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type McpOutboundMessage = JsonRpcResponse | JsonRpcNotification;

export type McpJsonRpcOptions = {
  grantedScopes?: readonly McpAgentScope[];
  now?: Date;
  transport?: 'stdio' | 'http';
  authenticated?: boolean;
  workspaceReadDeps?: McpWorkspaceReadDeps;
  workspaceWriteDeps?: McpWorkspaceWriteDeps;
  integrationDeps?: McpIntegrationToolDeps;
  /**
   * Optional sink for server notifications (progress, resource updates). Defaults to the same
   * `write` used for responses so stdio clients see them on stdout.
   */
  notify?: (message: JsonRpcNotification) => void;
  /** Test-only: await before tools/call work so a concurrent cancel can land. */
  beforeToolsCall?: (signal: AbortSignal) => Promise<void>;
};

const defaultGrantedScopes = (): readonly McpAgentScope[] => MCP_AGENT_SCOPES;

const RESOURCE_TIP_BY_TOOL: Record<string, readonly string[]> = {
  coordination_post_handoff: [COORDINATION_INBOX_URI, COORDINATION_CHANGES_URI],
  coordination_claim_handoff: [COORDINATION_INBOX_URI, COORDINATION_CHANGES_URI],
  coordination_complete_handoff: [COORDINATION_INBOX_URI, COORDINATION_CHANGES_URI],
  coordination_cancel_handoff: [COORDINATION_INBOX_URI, COORDINATION_CHANGES_URI],
  coordination_add_note: [COORDINATION_INBOX_URI, COORDINATION_CHANGES_URI],
  workspace_create_task: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_update_task: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_delete_task: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_create_project: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_update_project: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_delete_project: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_add_checklist_item: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_update_checklist_item: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_remove_checklist_item: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_add_dependency: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
  workspace_remove_dependency: [WORKSPACE_CHANGES_URI, WORKSPACE_CONTEXT_URI],
};

function agentLabelFromInitialize(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  const meta = record._meta;
  if (meta && typeof meta === 'object') {
    const label = (meta as Record<string, unknown>).agent_label;
    if (typeof label === 'string') return label;
  }
  const clientInfo = record.clientInfo;
  if (clientInfo && typeof clientInfo === 'object') {
    const name = (clientInfo as Record<string, unknown>).name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

function progressTokenFromParams(params: unknown): string | number | null {
  if (!params || typeof params !== 'object') return null;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object') return null;
  const token = (meta as Record<string, unknown>).progressToken;
  if (typeof token === 'string' || typeof token === 'number') return token;
  return null;
}

function cancelRequestId(params: unknown): string | number | null {
  if (!params || typeof params !== 'object') return null;
  const id = (params as Record<string, unknown>).requestId;
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}

function tipResourcesForTool(toolName: string): void {
  const uris = RESOURCE_TIP_BY_TOOL[toolName];
  if (!uris) return;
  for (const uri of uris) notifyMcpResourceUpdated(uri);
}

export async function handleMcpJsonRpc(
  session: McpSession,
  request: JsonRpcRequest,
  write: (message: McpOutboundMessage) => void = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  },
  db: Db = getDb(),
  options: McpJsonRpcOptions = {},
): Promise<void> {
  const { id, method, params } = request;
  const grantedScopes = options.grantedScopes ?? defaultGrantedScopes();
  const now = options.now ?? new Date();
  const notify =
    options.notify ??
    ((message: JsonRpcNotification) => {
      write(message);
    });

  if (!method) {
    if (id !== undefined) {
      write({
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32600, message: 'Invalid Request: method required.' },
      });
    }
    return;
  }

  const reply = (result: unknown) => {
    if (id === undefined) return;
    write({ jsonrpc: '2.0', id, result });
  };
  const fail = (code: number, message: string, data?: unknown) => {
    if (id === undefined) return;
    write({
      jsonrpc: '2.0',
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    });
  };

  try {
    switch (method) {
      case 'initialize': {
        const fromEnv = process.env.MCP_AGENT_LABEL;
        const fromParams = agentLabelFromInitialize(params);
        try {
          setMcpSessionAgentLabel(session, fromEnv ?? fromParams);
        } catch (error) {
          fail(-32602, error instanceof Error ? error.message : 'Invalid agent_label.');
          return;
        }
        const requested =
          params && typeof params === 'object'
            ? (params as Record<string, unknown>).protocolVersion
            : undefined;
        reply({
          protocolVersion: negotiateMcpProtocolVersion(requested),
          capabilities: {
            tools: {},
            resources: { subscribe: true },
            prompts: {},
          },
          serverInfo: { name: 'hybrid-command-center', version: APP_VERSION },
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'notifications/cancelled': {
        const requestId = cancelRequestId(params);
        if (requestId !== null) {
          const reason =
            params && typeof params === 'object'
              ? (params as Record<string, unknown>).reason
              : undefined;
          cancelMcpInFlight(session, requestId, typeof reason === 'string' ? reason : undefined);
        }
        return;
      }
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools: mcpToolsListPayload() });
        return;
      case 'prompts/list':
        reply({ prompts: mcpPromptsListPayload() });
        return;
      case 'prompts/get': {
        const get = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (typeof get.name !== 'string' || !get.name) {
          fail(-32602, 'prompts/get requires a prompt name.');
          return;
        }
        let prompt;
        try {
          prompt = getMcpPrompt(get.name, get.arguments);
        } catch (error) {
          fail(-32602, error instanceof Error ? error.message : 'Invalid prompt arguments.');
          return;
        }
        if (!prompt) {
          fail(-32602, `Unknown prompt: ${get.name}`);
          return;
        }
        reply(prompt);
        return;
      }
      case 'tools/call': {
        const call = (params ?? {}) as { name?: string; arguments?: unknown };
        if (!call.name || typeof call.name !== 'string') {
          fail(-32602, 'tools/call requires a tool name.');
          return;
        }
        if (id === undefined || id === null) {
          fail(-32600, 'tools/call requires a request id.');
          return;
        }

        const abort = registerMcpInFlight(session, id);
        try {
          if (options.beforeToolsCall) {
            await options.beforeToolsCall(abort.signal);
          } else {
            // One turn of the event loop so a concurrent HTTP cancel POST can land.
            await Promise.resolve();
          }
          if (mcpRequestCancelled(abort.signal)) {
            // Spec: do not send a response for a cancelled request.
            return;
          }

          const progressToken = progressTokenFromParams(params);
          if (progressToken !== null) {
            notify({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: 0,
                total: 1,
                message: `Running ${call.name}`,
              },
            });
          }

          const result = await callMcpTool(db, session, call.name, call.arguments ?? {}, {
            grantedScopes,
            now,
            transport: options.transport ?? 'stdio',
            authenticated: options.authenticated ?? true,
            workspaceReadDeps: options.workspaceReadDeps,
            workspaceWriteDeps: options.workspaceWriteDeps,
            integrationDeps: options.integrationDeps,
          });

          if (mcpRequestCancelled(abort.signal)) {
            // Cancel won the race after the tool returned. If the tool wrote, the write was
            // already a full transaction — we still suppress the response so the client does not
            // treat a cancelled call as acknowledged.
            return;
          }

          if (progressToken !== null) {
            notify({
              jsonrpc: '2.0',
              method: 'notifications/progress',
              params: {
                progressToken,
                progress: 1,
                total: 1,
                message: `Finished ${call.name}`,
              },
            });
          }

          if (result.outcome === 'SUCCESS') {
            tipResourcesForTool(call.name);
          }

          const text =
            result.outcome === 'SUCCESS'
              ? JSON.stringify(result.data ?? null)
              : JSON.stringify(mcpToolCallErrorPayload(result));
          reply({
            content: [{ type: 'text', text }],
            isError: result.outcome !== 'SUCCESS',
          });
        } finally {
          clearMcpInFlight(session, id);
        }
        return;
      }
      case 'resources/list':
        reply({
          resources: MCP_RESOURCE_DEFINITIONS.map((resource) => ({ ...resource })),
        });
        return;
      case 'resources/read': {
        const read = (params ?? {}) as { uri?: string };
        if (!read.uri || typeof read.uri !== 'string') {
          fail(-32602, 'resources/read requires a uri.');
          return;
        }
        const body = readMcpResource(db, read.uri, { grantedScopes, now });
        reply({
          contents: [{ uri: body.uri, mimeType: body.mimeType, text: body.text }],
        });
        return;
      }
      case 'resources/subscribe': {
        const sub = (params ?? {}) as { uri?: string };
        if (!sub.uri || typeof sub.uri !== 'string') {
          fail(-32602, 'resources/subscribe requires a uri.');
          return;
        }
        const canonical = canonicalMcpResourceUri(sub.uri);
        if (!canonical) {
          fail(-32602, `Unknown resource: ${sub.uri}`);
          return;
        }
        session.subscriptions.add(canonical);
        reply({});
        return;
      }
      case 'resources/unsubscribe': {
        const sub = (params ?? {}) as { uri?: string };
        if (!sub.uri || typeof sub.uri !== 'string') {
          fail(-32602, 'resources/unsubscribe requires a uri.');
          return;
        }
        const canonical = canonicalMcpResourceUri(sub.uri);
        if (canonical) session.subscriptions.delete(canonical);
        reply({});
        return;
      }
      default:
        fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    fail(-32603, error instanceof Error ? error.message : 'Internal error.');
  }
}
