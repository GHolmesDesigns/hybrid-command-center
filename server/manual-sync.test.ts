import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_REGISTRY } from './mcp/registry.ts';
import { MCP_RESOURCE_DEFINITIONS } from './mcp/resources.ts';
import { createMcpPromptRegistry } from './mcp/prompts.ts';

const manual = fs.readFileSync(
  path.resolve('docs/manual/hybrid-command-center-manual.html'),
  'utf8',
);

describe('HTML manual capability synchronization', () => {
  it('tracks the canonical MCP surface instead of a historical fixed subset', () => {
    expect(manual).toContain(`${MCP_TOOL_REGISTRY.length} scoped tools`);
    expect(manual).toContain(`${MCP_RESOURCE_DEFINITIONS.length} resources`);
    expect(manual).toContain(`${createMcpPromptRegistry().length} workflow prompts`);

    for (const prompt of createMcpPromptRegistry()) expect(manual).toContain(prompt.name);
  });

  it('states the current hosted identity and write boundaries', () => {
    expect(manual).toContain('do <strong>not</strong> add <code>x-agent-label</code> by hand');
    expect(manual).toContain('Provider outcome is uncertain');
    expect(manual).toContain('20 requests and 50 MiB');
    expect(manual).toContain('one-hour lease');
    expect(manual).toMatch(/Provider\s+publishing tools are excluded by design/);
  });
});
