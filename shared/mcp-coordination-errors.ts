/**
 * Structured MCP coordination refusals and failures (C117).
 *
 * Closed error codes and the envelope agents read beside the plain-language `error` string.
 * Mapping lives here so stdio, HTTP, and tests share one vocabulary.
 */
import type { AgentHandoffState } from './agent-coordination.ts';

export const MCP_COORDINATION_ERROR_CODES = [
  'COORDINATION_AGENT_LABEL_REQUIRED',
  'COORDINATION_SESSION_LABEL_MISMATCH',
  'COORDINATION_CREDENTIAL_LABEL_MISMATCH',
  'COORDINATION_SCOPE_REQUIRED',
  'WORKSPACE_SCOPE_REQUIRED',
  'MCP_SCOPE_REQUIRED',
  'DRIVE_SCOPE_REQUIRED',
  'WORKSPACE_REVISION_CONFLICT',
  'WORKSPACE_CONFIRMATION_REQUIRED',
  'COORDINATION_RATE_LIMIT_EXCEEDED',
  'COORDINATION_UNAUTHORIZED',
  'COORDINATION_INVALID_STATE',
  'COORDINATION_NOT_FOUND',
  'COORDINATION_INVALID_ARGUMENTS',
  'COORDINATION_UNKNOWN_TOOL',
  'COORDINATION_TOOL_FAILED',
] as const;

export type McpCoordinationErrorCode = (typeof MCP_COORDINATION_ERROR_CODES)[number];

export interface McpCoordinationErrorDetail {
  code: McpCoordinationErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  currentState?: AgentHandoffState;
  requiredAction?: string;
  /** Present on WORKSPACE_REVISION_CONFLICT (C129/C130). */
  currentRevision?: number;
  changedFields?: string[];
}

export const mcpCoordinationErrorDetail = (
  detail: McpCoordinationErrorDetail,
): McpCoordinationErrorDetail => detail;

export const mcpCoordinationAgentLabelRequired = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_AGENT_LABEL_REQUIRED',
    retryable: false,
    requiredAction: 'Set a non-empty agent_label in MCP initialization or MCP_AGENT_LABEL.',
  });

export const mcpCoordinationSessionLabelMismatch = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_SESSION_LABEL_MISMATCH',
    retryable: false,
    requiredAction: 'Omit from_agent_label or set it to the MCP session agent_label.',
  });

export const mcpCoordinationCredentialLabelMismatch = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_CREDENTIAL_LABEL_MISMATCH',
    retryable: false,
    requiredAction: 'Use the label bound to this credential or omit x-agent-label.',
  });

export const mcpCoordinationScopeRequired = (
  scope: 'coordination:read' | 'coordination:write',
): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_SCOPE_REQUIRED',
    retryable: false,
    requiredAction: `Ask the operator to issue a credential with ${scope}.`,
  });

export const mcpWorkspaceScopeRequired = (
  scope: 'workspace:read' | 'workspace:write',
): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'WORKSPACE_SCOPE_REQUIRED',
    retryable: false,
    requiredAction: `Ask the operator to issue a credential with ${scope}.`,
  });

export const mcpScopeRequired = (scope: string): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'MCP_SCOPE_REQUIRED',
    retryable: false,
    requiredAction: `Ask the operator to issue a credential with ${scope}.`,
  });

export const mcpDriveScopeRequired = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'DRIVE_SCOPE_REQUIRED',
    retryable: false,
    requiredAction: 'Ask the operator to issue a credential with drive:write-request.',
  });

export const mcpWorkspaceRevisionConflict = (
  currentRevision: number,
  changedFields: string[],
): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'WORKSPACE_REVISION_CONFLICT',
    retryable: false,
    currentRevision,
    changedFields,
    requiredAction: 'Read the entity again and re-plan the write with the current revision.',
  });

export const mcpWorkspaceConfirmationRequired = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'WORKSPACE_CONFIRMATION_REQUIRED',
    retryable: false,
    requiredAction:
      'Pass confirm: true and the matching entity id to perform this destructive write.',
  });

export const mcpCoordinationRateLimitExceeded = (
  retryAfterMs: number,
): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_RATE_LIMIT_EXCEEDED',
    retryable: true,
    retryAfterMs,
    requiredAction: 'Wait for retryAfterMs, then retry the same request.',
  });

export const mcpCoordinationNotFound = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_NOT_FOUND',
    retryable: false,
  });

export const mcpCoordinationInvalidArguments = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_INVALID_ARGUMENTS',
    retryable: false,
    requiredAction: 'Fix the tool arguments and retry.',
  });

export const mcpCoordinationUnknownTool = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_UNKNOWN_TOOL',
    retryable: false,
  });

export const mcpCoordinationToolFailed = (): McpCoordinationErrorDetail =>
  mcpCoordinationErrorDetail({
    code: 'COORDINATION_TOOL_FAILED',
    retryable: false,
  });

/** Map domain refusal prose to structured codes without changing the message text. */
export function mcpCoordinationErrorFromMessage(
  message: string,
  status: 400 | 404 | 409,
  currentState?: AgentHandoffState,
): McpCoordinationErrorDetail {
  if (status === 404) return mcpCoordinationNotFound();
  if (status === 400) return mcpCoordinationInvalidArguments();

  if (
    /Only the agent that claimed|Only the posting agent|Only .* may claim|may cancel this handoff/i.test(
      message,
    )
  ) {
    return mcpCoordinationErrorDetail({
      code: 'COORDINATION_UNAUTHORIZED',
      retryable: false,
      ...(currentState ? { currentState } : {}),
      requiredAction: 'Act as an authorized agent for this handoff or choose different work.',
    });
  }

  if (
    /Only an OPEN|Only a CLAIMED|cannot be cancelled|Notes cannot be added|Another agent claimed/i.test(
      message,
    )
  ) {
    return mcpCoordinationErrorDetail({
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
      ...(currentState ? { currentState } : {}),
      requiredAction: 'Read the handoff again and choose an action valid for its current state.',
    });
  }

  if (/could not be completed|could not be cancelled/i.test(message)) {
    return mcpCoordinationErrorDetail({
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
      ...(currentState ? { currentState } : {}),
    });
  }

  return mcpCoordinationErrorDetail({
    code: 'COORDINATION_INVALID_STATE',
    retryable: false,
    ...(currentState ? { currentState } : {}),
  });
}
