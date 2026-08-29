/**
 * Local stdio MCP JSON-RPC adapter for coordination tools (C111).
 *
 * Minimal MCP subset: initialize, tools/*, resources/*, and ping. Workspace and Signal tools
 * remain MCP-C106–C108. The stdin loop lives in `server/scripts/mcp.ts` (`npm run mcp`); set
 * `MCP_AGENT_LABEL` (or pass `_meta.agent_label` on initialize) for writes.
 */
import { getDb, type Db } from '../db.ts';
import { APP_VERSION } from '../../shared/branding.ts';
import { MCP_AGENT_SCOPES, type McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import { callMcpTool } from './dispatch.ts';
import { mcpToolCallErrorPayload } from './coordination.ts';
import type { McpIntegrationToolDeps } from './integration-tools.ts';
import { MCP_RESOURCE_DEFINITIONS, readMcpResource } from './resources.ts';
import { mcpToolsListPayload } from './registry.ts';
import { getMcpPrompt, mcpPromptsListPayload } from './prompts.ts';
import { setMcpSessionAgentLabel, type McpSession } from './session.ts';
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

export type McpJsonRpcOptions = {
  grantedScopes?: readonly McpAgentScope[];
  now?: Date;
  transport?: 'stdio' | 'http';
  authenticated?: boolean;
  workspaceReadDeps?: McpWorkspaceReadDeps;
  workspaceWriteDeps?: McpWorkspaceWriteDeps;
  integrationDeps?: McpIntegrationToolDeps;
};

const PROTOCOL_VERSION = '2024-11-05';

const defaultGrantedScopes = (): readonly McpAgentScope[] => MCP_AGENT_SCOPES;

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

export async function handleMcpJsonRpc(
  session: McpSession,
  request: JsonRpcRequest,
  write: (message: JsonRpcResponse) => void = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  },
  db: Db = getDb(),
  options: McpJsonRpcOptions = {},
): Promise<void> {
  const { id, method, params } = request;
  const grantedScopes = options.grantedScopes ?? defaultGrantedScopes();
  const now = options.now ?? new Date();
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
        reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {} },
          serverInfo: { name: 'hybrid-command-center', version: APP_VERSION },
        });
        return;
      }
      case 'notifications/initialized':
      case 'initialized':
        return;
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
        const result = await callMcpTool(db, session, call.name, call.arguments ?? {}, {
          grantedScopes,
          now,
          transport: options.transport ?? 'stdio',
          authenticated: options.authenticated ?? true,
          workspaceReadDeps: options.workspaceReadDeps,
          workspaceWriteDeps: options.workspaceWriteDeps,
          integrationDeps: options.integrationDeps,
        });
        const text =
          result.outcome === 'SUCCESS'
            ? JSON.stringify(result.data ?? null)
            : JSON.stringify(mcpToolCallErrorPayload(result));
        reply({
          content: [{ type: 'text', text }],
          isError: result.outcome !== 'SUCCESS',
        });
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
      default:
        fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    fail(-32603, error instanceof Error ? error.message : 'Internal error.');
  }
}
