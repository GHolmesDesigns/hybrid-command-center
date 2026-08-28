/**
 * Coordination MCP tools (C111).
 *
 * Each tool maps to exactly one method on `server/agent-coordination/service.ts`. Domain rules
 * stay in `server/domain/agent-coordination.ts` — this module validates MCP-facing args, enforces
 * init `agent_label` and the coordination write rate limit, records `mcp_agent_events`, and
 * redacts tool results. It never re-implements claim or complete authorization.
 */
import { z } from 'zod';
import type { Db } from '../db.ts';
import { AgentCoordinationError } from '../domain/agent-coordination.ts';
import {
  addHandoffNote,
  cancelHandoffAsAgent,
  claimHandoff,
  completeHandoff,
  getHandoff,
  listHandoffs,
  postHandoff,
} from '../agent-coordination/service.ts';
import {
  AGENT_HANDOFF_STATES,
  agentHandoffCancelReasonSchema,
  agentHandoffClientRequestIdSchema,
  agentHandoffCompletionInputSchema,
  agentHandoffMessageSchema,
  agentHandoffNoteBodySchema,
  agentHandoffSubjectIdSchema,
  agentLabelSchema,
  type AgentHandoffState,
  type AgentHandoffSubjectType,
  AGENT_HANDOFF_SUBJECT_TYPES,
} from '../../shared/agent-coordination.ts';
import {
  mcpCoordinationAgentLabelRequired,
  mcpCoordinationErrorFromMessage,
  mcpCoordinationInvalidArguments,
  mcpCoordinationRateLimitExceeded,
  mcpCoordinationSessionLabelMismatch,
  mcpCoordinationToolFailed,
  mcpCoordinationUnknownTool,
  type McpCoordinationErrorDetail,
} from '../../shared/mcp-coordination-errors.ts';
import {
  COORDINATION_WRITE_TOOLS,
  type McpAgentEventOutcome,
} from '../../shared/mcp-agent-events.ts';
import { recordMcpAgentEvent } from './events.ts';
import { isCoordinationTool } from './registry.ts';
import { redactToolResult } from './redact.ts';
import type { McpSession } from './session.ts';

export interface McpToolCallResult {
  outcome: McpAgentEventOutcome;
  /** Structured payload for SUCCESS; omitted on refuse/failure. */
  data?: unknown;
  /** Plain-language error for REFUSED / FAILURE; already scrubbed. */
  error?: string;
  /** Structured refusal/failure beside the plain error string (C117). */
  errorDetail?: McpCoordinationErrorDetail;
  /** Set only on the coordination-write rate-limit refusal path (C116). */
  retryAfterMs?: number;
}

const listArgsSchema = z
  .object({
    state: z.enum(AGENT_HANDOFF_STATES).optional(),
  })
  .strict();

const getArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
  })
  .strict();

const postArgsSchema = z
  .object({
    fromAgentLabel: agentLabelSchema.optional(),
    toAgentLabel: agentLabelSchema.nullable().optional(),
    subjectType: z.enum(AGENT_HANDOFF_SUBJECT_TYPES),
    subjectId: agentHandoffSubjectIdSchema.nullable().optional(),
    message: agentHandoffMessageSchema,
    clientRequestId: agentHandoffClientRequestIdSchema.optional(),
  })
  .strict();

const claimArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
  })
  .strict();

const completeArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
    clientRequestId: agentHandoffClientRequestIdSchema.optional(),
    ...agentHandoffCompletionInputSchema.shape,
  })
  .strict();

const cancelArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
    reason: agentHandoffCancelReasonSchema,
    clientRequestId: agentHandoffClientRequestIdSchema.optional(),
  })
  .strict();

const noteArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
    body: agentHandoffNoteBodySchema,
    clientRequestId: agentHandoffClientRequestIdSchema.optional(),
  })
  .strict();

const WRITE_TOOLS = new Set<string>(COORDINATION_WRITE_TOOLS);

const refused = (
  error: string,
  errorDetail: McpCoordinationErrorDetail,
  retryAfterMs?: number,
): McpToolCallResult => ({
  outcome: 'REFUSED',
  error,
  errorDetail,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

const failed = (error: string, errorDetail: McpCoordinationErrorDetail): McpToolCallResult => ({
  outcome: 'FAILURE',
  error,
  errorDetail,
});

/** Flatten structured error fields for MCP tool text payloads and JSON-RPC error.data. */
export function mcpToolCallErrorPayload(result: McpToolCallResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    error: result.error,
    ...(result.errorDetail?.code ? { code: result.errorDetail.code } : {}),
    ...(result.errorDetail?.retryable !== undefined
      ? { retryable: result.errorDetail.retryable }
      : {}),
    ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
    ...(result.errorDetail?.retryAfterMs !== undefined && result.retryAfterMs === undefined
      ? { retryAfterMs: result.errorDetail.retryAfterMs }
      : {}),
    ...(result.errorDetail?.currentState ? { currentState: result.errorDetail.currentState } : {}),
    ...(result.errorDetail?.requiredAction
      ? { requiredAction: result.errorDetail.requiredAction }
      : {}),
  };
}

/**
 * Dispatch one coordination tool. Reads skip label and rate-limit checks; writes require both.
 */
export function callCoordinationTool(
  db: Db,
  session: McpSession,
  tool: string,
  rawArgs: unknown,
  now: Date = new Date(),
): McpToolCallResult {
  if (!isCoordinationTool(tool)) {
    return finish(
      db,
      session,
      tool,
      failed(`Unknown coordination tool: ${tool}.`, mcpCoordinationUnknownTool()),
    );
  }

  if (WRITE_TOOLS.has(tool)) {
    if (!session.agentLabel) {
      return finish(
        db,
        session,
        tool,
        refused(
          'Coordination writes require a non-empty agent_label in MCP initialization (or MCP_AGENT_LABEL).',
          mcpCoordinationAgentLabelRequired(),
        ),
      );
    }
    if (!session.coordinationWrites.tryConsume(now.getTime())) {
      const retryAfterMs = session.coordinationWrites.retryAfterMs(now.getTime());
      const errorDetail = mcpCoordinationRateLimitExceeded(retryAfterMs);
      return finish(
        db,
        session,
        tool,
        refused(
          'Coordination write rate limit exceeded (10 per rolling minute).',
          errorDetail,
          retryAfterMs,
        ),
      );
    }
  }

  try {
    switch (tool) {
      case 'coordination_list_handoffs': {
        const args = listArgsSchema.parse(rawArgs ?? {});
        const data = listHandoffs(db, args.state ? { state: args.state as AgentHandoffState } : {});
        return finish(db, session, tool, { outcome: 'SUCCESS', data }, { audit: false });
      }
      case 'coordination_get_handoff': {
        const args = getArgsSchema.parse(rawArgs ?? {});
        const data = getHandoff(db, args.handoffId);
        return finish(db, session, tool, { outcome: 'SUCCESS', data }, { audit: false });
      }
      case 'coordination_post_handoff': {
        const args = postArgsSchema.parse(rawArgs ?? {});
        const label = session.agentLabel!;
        if (args.fromAgentLabel !== undefined && args.fromAgentLabel !== label) {
          return finish(
            db,
            session,
            tool,
            refused(
              'from_agent_label must match the MCP session agent_label.',
              mcpCoordinationSessionLabelMismatch(),
            ),
          );
        }
        const data = postHandoff(
          db,
          {
            fromAgentLabel: label,
            toAgentLabel: args.toAgentLabel,
            subjectType: args.subjectType as AgentHandoffSubjectType,
            subjectId: args.subjectId,
            message: args.message,
            clientRequestId: args.clientRequestId,
          },
          now,
        );
        return finish(
          db,
          session,
          tool,
          { outcome: 'SUCCESS', data },
          {
            entityType: 'agent_handoff',
            entityId: data.id,
            summary: `Posted handoff ${data.id}.`,
          },
        );
      }
      case 'coordination_claim_handoff': {
        const args = claimArgsSchema.parse(rawArgs ?? {});
        const data = claimHandoff(db, args.handoffId, session.agentLabel!, now);
        return finish(
          db,
          session,
          tool,
          { outcome: 'SUCCESS', data },
          {
            entityType: 'agent_handoff',
            entityId: data.id,
            summary: `Claimed handoff ${data.id}.`,
          },
        );
      }
      case 'coordination_complete_handoff': {
        const args = completeArgsSchema.parse(rawArgs ?? {});
        const data = completeHandoff(
          db,
          args.handoffId,
          session.agentLabel!,
          {
            resultSummary: args.resultSummary,
            outcome: args.outcome,
            changedPaths: args.changedPaths,
            references: args.references,
            validations: args.validations,
            remainingRisks: args.remainingRisks,
          },
          now,
          {
            clientRequestId: args.clientRequestId,
            mutationTool: 'coordination_complete_handoff',
          },
        );
        return finish(
          db,
          session,
          tool,
          { outcome: 'SUCCESS', data },
          {
            entityType: 'agent_handoff',
            entityId: data.id,
            summary: `Completed handoff ${data.id}.`,
          },
        );
      }
      case 'coordination_cancel_handoff': {
        const args = cancelArgsSchema.parse(rawArgs ?? {});
        const data = cancelHandoffAsAgent(
          db,
          args.handoffId,
          session.agentLabel!,
          { reason: args.reason },
          now,
          {
            clientRequestId: args.clientRequestId,
            mutationTool: 'coordination_cancel_handoff',
          },
        );
        return finish(
          db,
          session,
          tool,
          { outcome: 'SUCCESS', data },
          {
            entityType: 'agent_handoff',
            entityId: data.id,
            summary: `Cancelled handoff ${data.id}.`,
          },
        );
      }
      case 'coordination_add_note': {
        const args = noteArgsSchema.parse(rawArgs ?? {});
        const data = addHandoffNote(
          db,
          args.handoffId,
          { agentLabel: session.agentLabel!, body: args.body },
          now,
          {
            clientRequestId: args.clientRequestId,
            mutationTool: 'coordination_add_note',
          },
        );
        return finish(
          db,
          session,
          tool,
          { outcome: 'SUCCESS', data },
          {
            entityType: 'agent_handoff_note',
            entityId: data.id,
            summary: `Added note on handoff ${data.handoffId}.`,
          },
        );
      }
    }
  } catch (error) {
    if (error instanceof AgentCoordinationError) {
      const outcome: McpAgentEventOutcome = error.status === 409 ? 'REFUSED' : 'FAILURE';
      const errorDetail = mcpCoordinationErrorFromMessage(error.message, error.status);
      return finish(
        db,
        session,
        tool,
        { outcome, error: error.message, errorDetail },
        {
          summary: error.message,
        },
      );
    }
    if (error instanceof z.ZodError) {
      const message = error.issues.map((issue) => issue.message).join(' ') || 'Invalid arguments.';
      return finish(db, session, tool, failed(message, mcpCoordinationInvalidArguments()), {
        summary: message,
        audit: WRITE_TOOLS.has(tool),
      });
    }
    const message = error instanceof Error ? error.message : 'Coordination tool failed.';
    return finish(db, session, tool, failed(message, mcpCoordinationToolFailed()), {
      summary: message,
      audit: WRITE_TOOLS.has(tool),
    });
  }
}

interface FinishOptions {
  audit?: boolean;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string;
}

function finish(
  db: Db,
  session: McpSession,
  tool: string,
  result: McpToolCallResult,
  options: FinishOptions = {},
): McpToolCallResult {
  const shouldAudit = options.audit ?? WRITE_TOOLS.has(tool);
  const scrubbed: McpToolCallResult = {
    outcome: result.outcome,
    ...(result.data !== undefined ? { data: redactToolResult(result.data) } : {}),
    ...(result.error !== undefined ? { error: redactToolResult(result.error) } : {}),
    ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
    ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
  };
  if (shouldAudit) {
    recordMcpAgentEvent(db, {
      agentLabel: session.agentLabel,
      tool,
      outcome: scrubbed.outcome,
      summary:
        options.summary ??
        scrubbed.error ??
        (scrubbed.outcome === 'SUCCESS' ? `${tool} succeeded.` : `${tool} ${scrubbed.outcome}.`),
      entityType: options.entityType ?? null,
      entityId: options.entityId ?? null,
    });
  }
  return scrubbed;
}
