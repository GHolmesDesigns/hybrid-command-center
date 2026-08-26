/**
 * Local stdio MCP JSON-RPC adapter for coordination tools (C111).
 *
 * Minimal MCP subset: initialize, tools/*, resources/*, and ping. Workspace and Signal tools
 * remain MCP-C106–C108. The stdin loop lives in `server/scripts/mcp.ts` (`npm run mcp`); set
 * `MCP_AGENT_LABEL` (or pass `_meta.agent_label` on initialize) for writes.
 */
import { getDb, type Db } from '../db.ts';
import { APP_VERSION } from '../../shared/branding.ts';
import { callCoordinationTool, COORDINATION_TOOL_DEFINITIONS } from './coordination.ts';
import { COORDINATION_RESOURCE_DEFINITIONS, readCoordinationResource } from './resources.ts';
import { setMcpSessionAgentLabel, type McpSession } from './session.ts';

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

const PROTOCOL_VERSION = '2024-11-05';

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
): Promise<void> {
  const { id, method, params } = request;
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
          capabilities: { tools: {}, resources: {} },
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
        reply({
          tools: COORDINATION_TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;
      case 'tools/call': {
        const call = (params ?? {}) as { name?: string; arguments?: unknown };
        if (!call.name || typeof call.name !== 'string') {
          fail(-32602, 'tools/call requires a tool name.');
          return;
        }
        const result = callCoordinationTool(db, session, call.name, call.arguments ?? {});
        const text =
          result.outcome === 'SUCCESS'
            ? JSON.stringify(result.data ?? null)
            : JSON.stringify({ outcome: result.outcome, error: result.error });
        reply({
          content: [{ type: 'text', text }],
          isError: result.outcome !== 'SUCCESS',
        });
        return;
      }
      case 'resources/list':
        reply({
          resources: COORDINATION_RESOURCE_DEFINITIONS.map((resource) => ({ ...resource })),
        });
        return;
      case 'resources/read': {
        const read = (params ?? {}) as { uri?: string };
        if (!read.uri || typeof read.uri !== 'string') {
          fail(-32602, 'resources/read requires a uri.');
          return;
        }
        const body = readCoordinationResource(db, read.uri);
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
