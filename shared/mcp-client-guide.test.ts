import { describe, expect, it } from 'vitest';
import { MCP_BEARER_PLACEHOLDER } from './mcp-client-config.ts';
import { buildMcpClientGuide } from './mcp-client-guide.ts';

describe('buildMcpClientGuide', () => {
  it('builds Cursor HTTPS steps with a ready-to-paste setup that embeds the credential', () => {
    const guide = buildMcpClientGuide({
      platform: 'cursor',
      agentLabel: 'cursor-planning',
      origin: 'https://hcc.example.com/',
      bearerToken: 'hcc_mcp_test-token',
    });
    expect(guide.platformLabel).toBe('Cursor');
    expect(guide.serverUrl).toBe('https://hcc.example.com/api/mcp');
    expect(guide.steps).toHaveLength(4);
    expect(guide.steps[0]?.title).toMatch(/Cursor Settings/i);
    const setup = guide.copyFields.find((field) => field.id === 'setup');
    expect(setup?.secret).toBe(true);
    expect(setup?.value).toContain('Bearer hcc_mcp_test-token');
    expect(setup?.value).toContain('"x-agent-label": "cursor-planning"');
    expect(setup?.value).not.toContain(MCP_BEARER_PLACEHOLDER);
  });

  it('gives Claude Desktop connector steps and no paste-whole blob', () => {
    const guide = buildMcpClientGuide({
      platform: 'claude-desktop',
      agentLabel: 'claude-cowork',
      origin: 'https://hcc.example.com',
      bearerToken: 'hcc_mcp_test-token',
    });
    expect(guide.platformLabel).toBe('Claude Desktop / claude.ai');
    // The defect this covers: connector surfaces were shown Claude Code's per-project steps.
    expect(guide.steps[0]?.body).toMatch(/Connectors/i);
    expect(guide.steps.map((step) => step.body).join(' ')).not.toMatch(/this project/i);
    // No combined blob — every value goes into its own field.
    expect(guide.copyFields.map((field) => field.id)).toEqual([
      'serverUrl',
      'credential',
      'agentLabel',
    ]);
    expect(guide.headerHint).toMatch(/do not add x-agent-label/i);
  });

  it('emits a complete mcpServers document for file-based clients', () => {
    for (const platform of ['cursor', 'claude', 'codex'] as const) {
      const guide = buildMcpClientGuide({
        platform,
        agentLabel: 'agent-one',
        origin: 'https://hcc.example.com',
        bearerToken: 'hcc_mcp_test-token',
      });
      const setup = guide.copyFields.find((field) => field.id === 'setup');
      expect(setup, `${platform} should still offer a setup blob`).toBeDefined();
      // The defect this covers: a bare {url, headers} fragment was emitted under a .json filename.
      const parsed = JSON.parse(setup?.value ?? '{}') as {
        mcpServers?: Record<string, { url?: string; type?: string }>;
      };
      expect(parsed.mcpServers?.['hybrid-command-center']?.url).toBe(
        'https://hcc.example.com/api/mcp',
      );
      expect(parsed.mcpServers?.['hybrid-command-center']?.type).toBe('http');
    }
  });

  it('requires origin and credential', () => {
    expect(() =>
      buildMcpClientGuide({
        platform: 'claude',
        agentLabel: 'claude-review',
        origin: '   ',
        bearerToken: 'hcc_mcp_test-token',
      }),
    ).toThrow(/origin/i);
    expect(() =>
      buildMcpClientGuide({
        platform: 'claude',
        agentLabel: 'claude-review',
        origin: 'https://hcc.example.com',
        bearerToken: '  ',
      }),
    ).toThrow(/credential/i);
  });
});
