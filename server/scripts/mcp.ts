import { runMcpStdio } from '../mcp/stdio.ts';

runMcpStdio().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
