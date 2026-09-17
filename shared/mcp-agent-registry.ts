import { z } from 'zod';
import { agentLabelSchema } from './agent-coordination.ts';

export const MCP_AGENT_SCOPES = [
  'coordination:read',
  'coordination:write',
  'workspace:read',
  'workspace:write',
  'signal:write',
  'settings:write',
  'import:write',
  'drive:sync',
  'drive:write-request',
] as const;
export type McpAgentScope = (typeof MCP_AGENT_SCOPES)[number];

/** Scopes split from `workspace:write` — granted to every credential that already held it. */
export const WORKSPACE_WRITE_SPLIT_SCOPES = [
  'signal:write',
  'settings:write',
  'import:write',
  'drive:sync',
] as const satisfies readonly McpAgentScope[];

export const ASSISTANT_AGENT_LABEL = 'command-ai';

export const ASSISTANT_DEFAULT_SCOPES: McpAgentScope[] = ['workspace:read', 'workspace:write'];

/** True when the label names the reserved Command AI assistant identity (case/whitespace insensitive). */
export const isReservedAssistantLabel = (raw: string): boolean =>
  raw.trim().toLowerCase() === ASSISTANT_AGENT_LABEL;

export const mcpAgentScopeSchema = z.enum(MCP_AGENT_SCOPES);
export const mcpAgentScopesSchema = z
  .array(mcpAgentScopeSchema)
  .min(1)
  .max(MCP_AGENT_SCOPES.length);

export const createMcpAgentCredentialSchema = z.object({
  label: agentLabelSchema,
  scopes: mcpAgentScopesSchema,
  expiresAt: z.string().datetime(),
});

export const createAssistantMcpCredentialSchema = z.object({
  scopes: mcpAgentScopesSchema,
  expiresAt: z.string().datetime(),
});

export const updateMcpAgentRegistrationSchema = z.object({ label: agentLabelSchema });

export type McpAgentCredentialSummary = {
  id: string;
  agentId: string;
  label: string;
  scopes: McpAgentScope[];
  issuedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastOrigin: string | null;
  revokedAt: string | null;
};

export type McpAgentCredentialList = { credentials: McpAgentCredentialSummary[] };

/** Renew the saved lifetime from the rotation preview, independent of the issue form. */
export const rotatedCredentialExpiryIso = (
  credential: Pick<McpAgentCredentialSummary, 'issuedAt' | 'expiresAt'>,
  nowMs: number,
): string =>
  new Date(
    nowMs + Date.parse(credential.expiresAt) - Date.parse(credential.issuedAt),
  ).toISOString();
