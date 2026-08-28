/**
 * MCP client configuration generation (C127).
 *
 * Produces copy-ready snippets for Cursor, Claude Code, and Codex. Tracked repository files
 * never receive a bearer token; callers pass `embedSecret: true` only for ephemeral UI copy.
 */
import { MCP_AGENT_LABEL_HEADER, MCP_HTTP_PATH } from './mcp-network.ts';

export const MCP_CLIENT_PLATFORMS = ['cursor', 'claude', 'codex'] as const;
export type McpClientPlatform = (typeof MCP_CLIENT_PLATFORMS)[number];

export const MCP_CLIENT_TRANSPORTS = ['stdio', 'http'] as const;
export type McpClientTransport = (typeof MCP_CLIENT_TRANSPORTS)[number];

/** Placeholder used in tracked configs and skill examples — never a real secret. */
export const MCP_BEARER_PLACEHOLDER = '<paste-credential-here>';

export type McpClientConfigInput = {
  platform: McpClientPlatform;
  transport: McpClientTransport;
  agentLabel: string;
  /** Required for HTTP transport when `embedSecret` is true. */
  bearerToken?: string;
  /** API origin without a trailing slash, e.g. `https://hcc.example.com`. */
  origin: string;
  /** Absolute repository path — required for Codex stdio. */
  repoPath?: string;
  /** When true, substitute the bearer for copy-paste into client secret storage. */
  embedSecret?: boolean;
};

export type McpClientConfigResult = {
  format: 'json' | 'toml';
  filename: string;
  content: string;
  secretEmbedded: boolean;
  notes: readonly string[];
};

const bearerValue = (input: McpClientConfigInput): string => {
  if (input.embedSecret && input.bearerToken) return input.bearerToken;
  return MCP_BEARER_PLACEHOLDER;
};

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, '');

const jsonBlock = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const stdioCursor = (agentLabel: string): McpClientConfigResult => ({
  format: 'json',
  filename: '.cursor/mcp.json',
  content: jsonBlock({
    mcpServers: {
      'hybrid-command-center': {
        command: 'npm.cmd',
        args: ['--prefix', '${workspaceFolder}', 'run', 'mcp'],
        env: { MCP_AGENT_LABEL: agentLabel },
      },
    },
  }),
  secretEmbedded: false,
  notes: [
    'Commit this file in the repository. Cursor expands ${workspaceFolder} to the project root.',
    'Restart or reload MCP servers after saving.',
  ],
});

const stdioClaude = (agentLabel: string): McpClientConfigResult => ({
  format: 'json',
  filename: '.mcp.json',
  content: jsonBlock({
    mcpServers: {
      'hybrid-command-center': {
        type: 'stdio',
        command: 'npm.cmd',
        args: ['--prefix', '${CLAUDE_PROJECT_DIR:-.}', 'run', 'mcp'],
        env: { MCP_AGENT_LABEL: agentLabel },
      },
    },
  }),
  secretEmbedded: false,
  notes: [
    'Commit this file at the repository root. Start Claude Code from the repository root.',
    'Restart or reload MCP servers after saving.',
  ],
});

const stdioCodex = (agentLabel: string, repoPath: string): McpClientConfigResult => ({
  format: 'toml',
  filename: '~/.codex/config.toml',
  content: `[mcp_servers."hybrid-command-center"]
command = "npm.cmd"
args = ["--prefix", ${JSON.stringify(repoPath)}, "run", "mcp"]
startup_timeout_sec = 60

[mcp_servers."hybrid-command-center".env]
MCP_AGENT_LABEL = ${JSON.stringify(agentLabel)}
`,
  secretEmbedded: false,
  notes: [
    'This file is machine-local and never committed. Replace the prefix path if you move the checkout.',
    'Restart Codex after saving.',
  ],
});

const httpConfig = (input: McpClientConfigInput): McpClientConfigResult => {
  const origin = normalizeOrigin(input.origin);
  const token = bearerValue(input);
  const secretEmbedded = input.embedSecret === true && Boolean(input.bearerToken);
  const payload = {
    url: `${origin}${MCP_HTTP_PATH}`,
    headers: {
      Authorization: `Bearer ${token}`,
      [MCP_AGENT_LABEL_HEADER]: input.agentLabel,
    },
  };
  const platformNote: Record<McpClientPlatform, string> = {
    cursor: 'Paste into Cursor MCP settings or a local secrets file — never commit the bearer.',
    claude:
      'Paste into Claude Code MCP settings or a local secrets file — never commit the bearer.',
    codex: 'Paste into ~/.codex/config.toml under [mcp_servers] — never commit the bearer.',
  };
  return {
    format: 'json',
    filename:
      input.platform === 'codex'
        ? '~/.codex/config.toml (HTTP section)'
        : `${input.platform}-mcp-http.json`,
    content: jsonBlock(payload),
    secretEmbedded,
    notes: [
      platformNote[input.platform],
      `Every request must include the ${MCP_AGENT_LABEL_HEADER} header.`,
      secretEmbedded
        ? 'Copy this now — the credential is shown once and cannot be recovered.'
        : `Replace ${MCP_BEARER_PLACEHOLDER} with the credential issued in Settings.`,
    ],
  };
};

export function buildMcpClientConfig(input: McpClientConfigInput): McpClientConfigResult {
  if (input.transport === 'http') {
    if (!input.origin.trim()) {
      throw new Error('Origin is required for HTTP transport.');
    }
    return httpConfig(input);
  }

  switch (input.platform) {
    case 'cursor':
      return stdioCursor(input.agentLabel);
    case 'claude':
      return stdioClaude(input.agentLabel);
    case 'codex': {
      const repoPath = input.repoPath?.trim();
      if (!repoPath) {
        throw new Error('Repository path is required for Codex stdio transport.');
      }
      return stdioCodex(input.agentLabel, repoPath);
    }
    default: {
      const _exhaustive: never = input.platform;
      throw new Error(`Unsupported platform: ${String(_exhaustive)}`);
    }
  }
}

export const MCP_CLIENT_PLATFORM_LABEL: Record<McpClientPlatform, string> = {
  cursor: 'Cursor',
  claude: 'Claude Code',
  codex: 'Codex',
};

export const MCP_CLIENT_TRANSPORT_LABEL: Record<McpClientTransport, string> = {
  stdio: 'Local stdio (repository checkout)',
  http: 'Hosted HTTPS (network MCP)',
};
