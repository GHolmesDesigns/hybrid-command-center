import { z } from 'zod';
import { agentLabelSchema } from './agent-coordination.ts';

export const MCP_AGENT_SCOPES = [
  'coordination:read',
  'coordination:write',
  'workspace:read',
  'workspace:write',
] as const;
export type McpAgentScope = (typeof MCP_AGENT_SCOPES)[number];

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
