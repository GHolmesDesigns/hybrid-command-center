/**
 * MCP client configuration generation (C127).
 *
 * Produces copy-ready snippets for Cursor, Claude Code, Claude Desktop / claude.ai, and Codex.
 * Tracked repository files never receive a bearer token; callers pass `embedSecret: true` only for
 * ephemeral UI copy.
 */
import { MCP_HTTP_PATH } from './mcp-network.ts';

export const MCP_CLIENT_PLATFORMS = ['cursor', 'claude', 'claude-desktop', 'codex'] as const;
export type McpClientPlatform = (typeof MCP_CLIENT_PLATFORMS)[number];

/** Server name used wherever a client stores this connection under a key. */
export const MCP_CLIENT_SERVER_NAME = 'hybrid-command-center';

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
  format: 'json' | 'toml' | 'fields';
  filename: string;
  content: string;
  secretEmbedded: boolean;
  /**
   * Where the content is meant to go. `file` content is a complete document for a config file or a
   * settings field that accepts one. `fields` content is a labelled list for a client whose UI asks
   * for each value separately — it must never be presented as something to paste whole.
   */
  pasteTarget: 'file' | 'fields';
  notes: readonly string[];
};

const bearerValue = (input: McpClientConfigInput): string => {
  if (input.embedSecret && input.bearerToken) return input.bearerToken;
  return MCP_BEARER_PLACEHOLDER;
};

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, '');

const jsonBlock = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const HTTP_PLATFORM_NOTE: Record<McpClientPlatform, string> = {
  cursor: 'Paste into Cursor MCP settings or a local secrets file — never commit the bearer.',
  claude: 'Paste into Claude Code MCP settings or a local secrets file — never commit the bearer.',
  'claude-desktop': 'Fill the connector fields in claude.ai settings — never commit the bearer.',
  codex:
    'Paste this server section into ~/.codex/config.toml, replacing any existing hybrid-command-center section — never commit the bearer.',
};

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
  pasteTarget: 'file',
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
  pasteTarget: 'file',
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
  pasteTarget: 'file',
  notes: [
    'This file is machine-local and never committed. Replace the prefix path if you move the checkout.',
    'Restart Codex after saving.',
  ],
});

const httpConfig = (input: McpClientConfigInput): McpClientConfigResult => {
  const origin = normalizeOrigin(input.origin);
  const token = bearerValue(input);
  const secretEmbedded = input.embedSecret === true && Boolean(input.bearerToken);
  const serverUrl = `${origin}${MCP_HTTP_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  const secretNote = secretEmbedded
    ? 'Copy this now — the credential is shown once and cannot be recovered.'
    : `Replace ${MCP_BEARER_PLACEHOLDER} with the credential issued on Agents.`;

  /**
   * Claude Desktop, claude.ai chat, and Cowork add this as an account-level custom connector and
   * ask for each value in its own field. There is no file and nothing to paste whole, so emit a
   * labelled list rather than a document that would imply otherwise (#422).
   */
  if (input.platform === 'claude-desktop') {
    return {
      format: 'fields',
      filename: 'claude.ai connector settings (no file)',
      content: [`Name: ${MCP_CLIENT_SERVER_NAME}`, `Server URL: ${serverUrl}`].join('\n'),
      secretEmbedded: false,
      pasteTarget: 'fields',
      notes: [
        'Add under Settings → Connectors → Add custom connector. Paste the server URL, then click Connect and approve OAuth in the browser.',
        'Do not paste a bearer token into OAuth client ID or client secret — Claude registers automatically and receives a token after you approve.',
      ],
    };
  }

  const codex = input.platform === 'codex';
  return {
    format: codex ? 'toml' : 'json',
    filename: codex ? '~/.codex/config.toml (HTTP section)' : `${input.platform}-mcp-http.json`,
    // A complete document, not a fragment: the filename above says "file", so the content must be
    // one. A bare `{url, headers}` object is not valid anywhere it would be pasted (#422).
    content: codex
      ? `[mcp_servers."${MCP_CLIENT_SERVER_NAME}"]
url = ${JSON.stringify(serverUrl)}

[mcp_servers."${MCP_CLIENT_SERVER_NAME}".http_headers]
Authorization = ${JSON.stringify(headers.Authorization)}
`
      : jsonBlock({
          mcpServers: { [MCP_CLIENT_SERVER_NAME]: { type: 'http', url: serverUrl, headers } },
        }),
    secretEmbedded,
    pasteTarget: 'file',
    notes: [
      HTTP_PLATFORM_NOTE[input.platform],
      'The agent label is bound to the credential; do not add an agent label header.',
      secretNote,
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
    case 'claude-desktop':
      // Desktop, chat, and Cowork reach MCP only through hosted HTTPS connectors — there is no
      // local command for them to run, so there is no stdio configuration to emit.
      throw new Error('Claude Desktop and claude.ai connect over hosted HTTPS, not local stdio.');
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
  'claude-desktop': 'Claude Desktop / claude.ai',
  codex: 'Codex',
};

export const MCP_CLIENT_TRANSPORT_LABEL: Record<McpClientTransport, string> = {
  stdio: 'Local stdio (repository checkout)',
  http: 'Hosted HTTPS (network MCP)',
};
