import { describe, expect, it } from 'vitest';
import { MCP_BEARER_PLACEHOLDER } from './mcp-client-config.ts';
import { buildMcpClientGuide } from './mcp-client-guide.ts';

describe('buildMcpClientGuide', () => {
  it.each(['cursor', 'claude', 'codex'] as const)(
    'documents credential-bound identity without emitting a label header for %s',
    (platform) => {
      const guide = buildMcpClientGuide({
        platform,
        agentLabel: 'agent-one',
        origin: 'https://hcc.example.com',
        bearerToken: 'hcc_mcp_test-token',
      });
      expect(guide.copyFields.find((field) => field.id === 'setup')?.value).not.toContain(
        'x-agent-label',
      );
      expect(guide.headerHint).toContain('Authorization: Bearer');
      expect(guide.headerHint).toContain('agent label is bound to the credential');
      expect(guide.headerHint).toContain('do not add x-agent-label by hand');
    },
  );

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
    expect(setup?.value).not.toContain('x-agent-label');
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
    expect(
      guide.steps.some(
        (step) => /Connect and approve/i.test(step.title) || /Connect and approve/i.test(step.body),
      ),
    ).toBe(true);
    expect(guide.copyFields.map((field) => field.id)).toEqual(['serverUrl', 'agentLabel']);
    expect(guide.headerHint).toMatch(/MCP OAuth/i);
  });

  it('emits a complete mcpServers document for JSON clients', () => {
    for (const platform of ['cursor', 'claude'] as const) {
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

  it('offers Codex a TOML server section with bearer authorization', () => {
    const guide = buildMcpClientGuide({
      platform: 'codex',
      agentLabel: 'codex-test',
      origin: 'https://hcc.example.com',
      bearerToken: 'hcc_mcp_test-token',
    });
    const setup = guide.copyFields.find((field) => field.id === 'setup');
    expect(setup?.secret).toBe(true);
    expect(setup?.value).toContain('[mcp_servers."hybrid-command-center"]');
    expect(setup?.value).toContain('Authorization = "Bearer hcc_mcp_test-token"');
    expect(setup?.value).not.toContain('mcpServers');
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
