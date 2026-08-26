/**
 * Spawn entry for local stdio MCP (`npm run mcp`).
 *
 * Reads newline-delimited JSON-RPC from stdin until EOF. Process wiring lives here so coverage
 * measures the JSON-RPC handler in `server/mcp/stdio.ts` rather than this stdin loop.
 */
import { createInterface } from 'node:readline';
import { createMcpSession } from '../mcp/session.ts';
import { handleMcpJsonRpc } from '../mcp/stdio.ts';

async function main(): Promise<void> {
  const session = createMcpSession({ agentLabel: process.env.MCP_AGENT_LABEL });
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let request: {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: unknown;
    };
    try {
      request = JSON.parse(trimmed) as typeof request;
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        })}\n`,
      );
      continue;
    }
    await handleMcpJsonRpc(session, request);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
