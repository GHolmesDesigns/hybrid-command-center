import { describe, expect, it } from 'vitest';
import { MCP_BEARER_PLACEHOLDER, buildMcpClientConfig } from './mcp-client-config.ts';

describe('buildMcpClientConfig', () => {
  it('generates Cursor stdio config without a secret', () => {
    const result = buildMcpClientConfig({
      platform: 'cursor',
      transport: 'stdio',
      agentLabel: 'cursor-planning',
      origin: 'https://hcc.example.com',
    });
    expect(result.filename).toBe('.cursor/mcp.json');
    expect(result.secretEmbedded).toBe(false);
    expect(result.content).toContain('"MCP_AGENT_LABEL": "cursor-planning"');
    expect(result.content).toContain('${workspaceFolder}');
    expect(result.content).not.toContain(MCP_BEARER_PLACEHOLDER);
  });

  it('generates Claude stdio config without a secret', () => {
    const result = buildMcpClientConfig({
      platform: 'claude',
      transport: 'stdio',
      agentLabel: 'claude-review',
      origin: 'https://hcc.example.com',
    });
    expect(result.filename).toBe('.mcp.json');
    expect(result.content).toContain('${CLAUDE_PROJECT_DIR:-.}');
    expect(result.content).toContain('"type": "stdio"');
  });

  it('generates Codex stdio config with an absolute repository path', () => {
    const result = buildMcpClientConfig({
      platform: 'codex',
      transport: 'stdio',
      agentLabel: 'codex-release',
      origin: 'https://hcc.example.com',
      repoPath: 'C:\\Users\\you\\hybrid-command-center',
    });
    expect(result.format).toBe('toml');
    expect(result.content).toContain('C:\\\\Users\\\\you\\\\hybrid-command-center');
    expect(result.content).toContain('MCP_AGENT_LABEL = "codex-release"');
  });

  it('requires a repository path for Codex stdio', () => {
    expect(() =>
      buildMcpClientConfig({
        platform: 'codex',
        transport: 'stdio',
        agentLabel: 'codex-release',
        origin: 'https://hcc.example.com',
      }),
    ).toThrow(/repository path/i);
  });

  it('generates hosted HTTPS config with a placeholder when no secret is embedded', () => {
    const result = buildMcpClientConfig({
      platform: 'cursor',
      transport: 'http',
      agentLabel: 'cursor-planning',
      origin: 'https://hcc.example.com/',
    });
    expect(result.content).toContain('"url": "https://hcc.example.com/api/mcp"');
    expect(result.content).toContain(`Bearer ${MCP_BEARER_PLACEHOLDER}`);
    expect(result.content).toContain('"x-agent-label": "cursor-planning"');
    expect(result.secretEmbedded).toBe(false);
  });

  it('embeds the bearer only when explicitly requested for ephemeral copy', () => {
    const result = buildMcpClientConfig({
      platform: 'claude',
      transport: 'http',
      agentLabel: 'claude-review',
      origin: 'https://hcc.example.com',
      bearerToken: 'hcc_mcp_test-token',
      embedSecret: true,
    });
    expect(result.content).toContain('Bearer hcc_mcp_test-token');
    expect(result.content).not.toContain(MCP_BEARER_PLACEHOLDER);
    expect(result.secretEmbedded).toBe(true);
  });

  it('requires an origin for HTTP transport', () => {
    expect(() =>
      buildMcpClientConfig({
        platform: 'cursor',
        transport: 'http',
        agentLabel: 'cursor-planning',
        origin: '   ',
      }),
    ).toThrow(/origin/i);
  });

  it('rejects unsupported platform values at runtime', () => {
    expect(() =>
      buildMcpClientConfig({
        platform: 'unknown' as import('./mcp-client-config.ts').McpClientPlatform,
        transport: 'stdio',
        agentLabel: 'cursor-planning',
        origin: 'https://hcc.example.com',
      }),
    ).toThrow(/unsupported platform/i);
  });
});
