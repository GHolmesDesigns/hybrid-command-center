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
