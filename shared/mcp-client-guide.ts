/**
 * Plain-language MCP connection guides for non-technical operators (C136 / #420).
 *
 * The primary path is hosted HTTPS: copy values (or one ready-to-paste setup) into the client's
 * own Settings UI. No PowerShell and no hand-editing of repository JSON/TOML files.
 */
import { MCP_AGENT_LABEL_HEADER, MCP_HTTP_PATH } from './mcp-network.ts';
import {
  MCP_CLIENT_PLATFORM_LABEL,
  buildMcpClientConfig,
  type McpClientPlatform,
} from './mcp-client-config.ts';

export type McpGuideCopyField = {
  id: 'serverUrl' | 'agentLabel' | 'credential' | 'setup';
  label: string;
  value: string;
  /** When true, treat as a one-time secret in the UI. */
  secret?: boolean;
};

export type McpGuideStep = {
  title: string;
  body: string;
};

export type McpClientGuide = {
  platform: McpClientPlatform;
  platformLabel: string;
  serverUrl: string;
  agentLabel: string;
  steps: readonly McpGuideStep[];
  copyFields: readonly McpGuideCopyField[];
};

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, '');

const STEPS: Record<McpClientPlatform, readonly McpGuideStep[]> = {
  cursor: [
    {
      title: 'Open Cursor Settings',
      body: 'In Cursor, open Settings, then open the MCP (or Tools & MCP) section.',
    },
    {
      title: 'Add or edit Hybrid Command Center',
      body: 'Choose Add MCP server (or edit the existing Hybrid Command Center entry). Stay in Cursor Settings — do not open a code editor or terminal.',
    },
    {
      title: 'Paste the ready-to-paste setup',
      body: 'Click Copy ready-to-paste setup below, then paste it where Cursor asks for the server configuration. Save or reload MCP when Cursor offers it.',
    },
    {
      title: 'Confirm in Hybrid Command Center',
      body: 'Return here and run the connection diagnostic. After your agent’s first successful call, Last used updates for this label.',
    },
  ],
  claude: [
    {
      title: 'Open Claude Code MCP settings',
      body: 'In Claude Code, open MCP / connector settings for this project. Stay in the app settings — do not edit project files by hand.',
    },
    {
      title: 'Add Hybrid Command Center',
      body: 'Add a remote HTTPS MCP server named Hybrid Command Center (or edit the existing entry).',
    },
    {
      title: 'Paste the ready-to-paste setup',
      body: 'Click Copy ready-to-paste setup below and paste it into Claude’s MCP configuration field. Reload MCP if prompted.',
    },
    {
      title: 'Confirm in Hybrid Command Center',
      body: 'Return here and run the connection diagnostic. Last used updates after the agent’s first successful call.',
    },
  ],
  codex: [
    {
      title: 'Open Codex MCP settings',
      body: 'In Codex, open the MCP servers settings. Prefer the settings UI over editing config.toml in a text editor.',
    },
    {
      title: 'Add Hybrid Command Center',
      body: 'Create or edit the Hybrid Command Center HTTPS MCP entry.',
    },
    {
      title: 'Paste the ready-to-paste setup',
      body: 'Click Copy ready-to-paste setup below and paste it into Codex’s MCP configuration field. Restart or reload MCP if prompted.',
    },
    {
      title: 'Confirm in Hybrid Command Center',
      body: 'Return here and run the connection diagnostic. Last used updates after the agent’s first successful call.',
    },
  ],
};

export type McpClientGuideInput = {
  platform: McpClientPlatform;
  agentLabel: string;
  origin: string;
  bearerToken: string;
};

/**
 * Builds numbered UI steps and copy fields for one HTTPS MCP connection.
 * Always embeds the bearer in the ready-to-paste setup — callers must treat that as one-time.
 */
export function buildMcpClientGuide(input: McpClientGuideInput): McpClientGuide {
  const origin = normalizeOrigin(input.origin);
  if (!origin.trim()) {
    throw new Error('Origin is required for the connection guide.');
  }
  if (!input.bearerToken.trim()) {
    throw new Error('Credential is required for the connection guide.');
  }
  const serverUrl = `${origin}${MCP_HTTP_PATH}`;
  const setup = buildMcpClientConfig({
    platform: input.platform,
    transport: 'http',
    agentLabel: input.agentLabel,
    origin,
    bearerToken: input.bearerToken,
    embedSecret: true,
  });
  return {
    platform: input.platform,
    platformLabel: MCP_CLIENT_PLATFORM_LABEL[input.platform],
    serverUrl,
    agentLabel: input.agentLabel,
    steps: STEPS[input.platform],
    copyFields: [
      {
        id: 'setup',
        label: `Copy ready-to-paste setup for ${MCP_CLIENT_PLATFORM_LABEL[input.platform]}`,
        value: setup.content,
        secret: true,
      },
      { id: 'serverUrl', label: 'Copy server URL', value: serverUrl },
      { id: 'agentLabel', label: 'Copy agent label', value: input.agentLabel },
      {
        id: 'credential',
        label: 'Copy credential only',
        value: input.bearerToken,
        secret: true,
      },
    ],
  };
}

export const MCP_GUIDE_HEADER_HINT = `Every request must send Authorization: Bearer … and ${MCP_AGENT_LABEL_HEADER}.`;
