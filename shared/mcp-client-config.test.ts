import { describe, expect, it } from 'vitest';
import {
  MCP_BEARER_PLACEHOLDER,
  MCP_CLIENT_SERVER_NAME,
  buildMcpClientConfig,
} from './mcp-client-config.ts';

describe('buildMcpClientConfig', () => {
  it.each([
    ['cursor', 'stdio', 'json', '.cursor/mcp.json', 'file'],
    ['claude', 'stdio', 'json', '.mcp.json', 'file'],
    ['codex', 'stdio', 'toml', '~/.codex/config.toml', 'file'],
    ['cursor', 'http', 'json', 'cursor-mcp-http.json', 'file'],
    ['claude', 'http', 'json', 'claude-mcp-http.json', 'file'],
    ['codex', 'http', 'toml', '~/.codex/config.toml (HTTP section)', 'file'],
    ['claude-desktop', 'http', 'fields', 'claude.ai connector settings (no file)', 'fields'],
  ] as const)(
    'matches the advertised target for %s %s',
    (platform, transport, format, filename, pasteTarget) => {
      const result = buildMcpClientConfig({
        platform,
        transport,
        agentLabel: 'test-agent',
        origin: 'https://hcc.example.com/',
        repoPath: 'C:\\test\\hcc',
      });
      expect(result).toMatchObject({ format, filename, pasteTarget, secretEmbedded: false });
      if (format === 'json') {
        const server = JSON.parse(result.content).mcpServers[MCP_CLIENT_SERVER_NAME];
        if (transport === 'http') {
          expect(server).toEqual({
            type: 'http',
            url: 'https://hcc.example.com/api/mcp',
            headers: {
              Authorization: `Bearer ${MCP_BEARER_PLACEHOLDER}`,
              'x-agent-label': 'test-agent',
            },
          });
        } else {
          expect(server.command).toBe('npm.cmd');
          expect(server.env).toEqual({ MCP_AGENT_LABEL: 'test-agent' });
        }
      } else if (format === 'fields') {
        expect(result.content).toBe(
          'Name: hybrid-command-center\nServer URL: https://hcc.example.com/api/mcp',
        );
      } else {
        expect(result.content).toContain('[mcp_servers."hybrid-command-center"]');
      }
    },
  );

  it.each([
    {
      embedSecret: true,
      bearerToken: 'hcc_mcp_test-token',
      expected: 'hcc_mcp_test-token',
      embedded: true,
    },
    {
      embedSecret: false,
      bearerToken: 'hcc_mcp_test-token',
      expected: MCP_BEARER_PLACEHOLDER,
      embedded: false,
    },
    {
      embedSecret: true,
      bearerToken: undefined,
      expected: MCP_BEARER_PLACEHOLDER,
      embedded: false,
    },
  ])(
    'preserves Codex bearer authorization and explicit secret opt-in: $embedSecret / $bearerToken',
    ({ embedSecret, bearerToken, expected, embedded }) => {
      const result = buildMcpClientConfig({
        platform: 'codex',
        transport: 'http',
        agentLabel: 'codex-test',
        origin: 'https://hcc.example.com///',
        embedSecret,
        bearerToken,
      });
      expect(result.format).toBe('toml');
      expect(result.content).toContain(`Authorization = "Bearer ${expected}"`);
      expect(result.content).toContain('url = "https://hcc.example.com/api/mcp"');
      expect(result.content).toContain('x-agent-label = "codex-test"');
      expect(result.secretEmbedded).toBe(embedded);
      if (!embedded) expect(result.content).not.toContain('hcc_mcp_test-token');
    },
  );

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

  it('refuses stdio for Claude Desktop, which only connects over hosted HTTPS', () => {
    expect(() =>
      buildMcpClientConfig({
        platform: 'claude-desktop',
        transport: 'stdio',
        agentLabel: 'claude-cowork',
        origin: 'https://hcc.example.com',
      }),
    ).toThrow(/hosted HTTPS, not local stdio/i);
  });

  it('emits connector fields rather than a document for Claude Desktop over HTTPS', () => {
    const config = buildMcpClientConfig({
      platform: 'claude-desktop',
      transport: 'http',
      agentLabel: 'claude-cowork',
      origin: 'https://hcc.example.com',
      bearerToken: 'hcc_mcp_test-token',
      embedSecret: true,
    });
    expect(config.format).toBe('fields');
    expect(config.pasteTarget).toBe('fields');
    expect(config.content).toContain('Server URL: https://hcc.example.com/api/mcp');
    expect(config.content).not.toContain('Authorization:');
    expect(config.secretEmbedded).toBe(false);
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
