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
  agentHandoffMessageSchema,
  agentHandoffNoteBodySchema,
  agentHandoffSubjectIdSchema,
  agentLabelSchema,
  type AgentHandoffState,
  type AgentHandoffSubjectType,
  AGENT_HANDOFF_SUBJECT_TYPES,
} from '../../shared/agent-coordination.ts';
import {
  COORDINATION_TOOLS,
  COORDINATION_WRITE_TOOLS,
  type CoordinationTool,
  type McpAgentEventOutcome,
} from '../../shared/mcp-agent-events.ts';
import { recordMcpAgentEvent } from './events.ts';
import { redactToolResult } from './redact.ts';
import type { McpSession } from './session.ts';

export interface McpToolCallResult {
  outcome: McpAgentEventOutcome;
  /** Structured payload for SUCCESS; omitted on refuse/failure. */
  data?: unknown;
  /** Plain-language error for REFUSED / FAILURE; already scrubbed. */
  error?: string;
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

const completeArgsSchema = claimArgsSchema;

const cancelArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
    reason: agentHandoffCancelReasonSchema,
  })
  .strict();

const noteArgsSchema = z
  .object({
    handoffId: z.string().trim().min(1).max(200),
    body: agentHandoffNoteBodySchema,
  })
  .strict();

const WRITE_TOOLS = new Set<string>(COORDINATION_WRITE_TOOLS);

const isCoordinationTool = (name: string): name is CoordinationTool =>
  (COORDINATION_TOOLS as readonly string[]).includes(name);

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
    return finish(db, session, tool, {
      outcome: 'FAILURE',
      error: `Unknown coordination tool: ${tool}.`,
    });
  }

  if (WRITE_TOOLS.has(tool)) {
    if (!session.agentLabel) {
      return finish(db, session, tool, {
        outcome: 'REFUSED',
        error:
          'Coordination writes require a non-empty agent_label in MCP initialization (or MCP_AGENT_LABEL).',
      });
    }
    if (!session.coordinationWrites.tryConsume(now.getTime())) {
      return finish(db, session, tool, {
        outcome: 'REFUSED',
        error: 'Coordination write rate limit exceeded (10 per rolling minute).',
        retryAfterMs: session.coordinationWrites.retryAfterMs(now.getTime()),
      });
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
          return finish(db, session, tool, {
            outcome: 'REFUSED',
            error: 'from_agent_label must match the MCP session agent_label.',
          });
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
        const data = completeHandoff(db, args.handoffId, session.agentLabel!, now);
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
      return finish(
        db,
        session,
        tool,
        { outcome, error: error.message },
        {
          summary: error.message,
        },
      );
    }
    if (error instanceof z.ZodError) {
      const message = error.issues.map((issue) => issue.message).join(' ') || 'Invalid arguments.';
      return finish(
        db,
        session,
        tool,
        { outcome: 'FAILURE', error: message },
        {
          summary: message,
          audit: WRITE_TOOLS.has(tool),
        },
      );
    }
    const message = error instanceof Error ? error.message : 'Coordination tool failed.';
    return finish(
      db,
      session,
      tool,
      { outcome: 'FAILURE', error: message },
      {
        summary: message,
        audit: WRITE_TOOLS.has(tool),
      },
    );
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

/** Tool descriptors for MCP `tools/list` (stdio adapter). */
export const COORDINATION_TOOL_DEFINITIONS: ReadonlyArray<{
  name: CoordinationTool;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
  {
    name: 'coordination_list_handoffs',
    description: 'List agent handoffs, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: [...AGENT_HANDOFF_STATES] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'coordination_get_handoff',
    description: 'Get one handoff and its notes.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
      },
      required: ['handoffId'],
      additionalProperties: false,
    },
  },
  {
    name: 'coordination_post_handoff',
    description:
      'Create an OPEN handoff. from_agent_label is the MCP session agent_label; optional client_request_id is idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        fromAgentLabel: { type: 'string' },
        toAgentLabel: { type: ['string', 'null'] },
        subjectType: { type: 'string', enum: [...AGENT_HANDOFF_SUBJECT_TYPES] },
        subjectId: { type: ['string', 'null'] },
        message: { type: 'string' },
        clientRequestId: { type: 'string' },
      },
      required: ['subjectType', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'coordination_claim_handoff',
    description: 'Claim an OPEN handoff (directed label or open-pool first claim).',
    inputSchema: {
      type: 'object',
      properties: { handoffId: { type: 'string' } },
      required: ['handoffId'],
      additionalProperties: false,
    },
  },
  {
    name: 'coordination_complete_handoff',
    description: 'Complete a CLAIMED handoff as the claimer. Never publishes or contacts Drive.',
    inputSchema: {
      type: 'object',
      properties: { handoffId: { type: 'string' } },
      required: ['handoffId'],
      additionalProperties: false,
    },
  },
  {
    name: 'coordination_cancel_handoff',
    description: 'Cancel an OPEN or CLAIMED handoff as the poster or claimer.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['handoffId', 'reason'],
      additionalProperties: false,
    },
  },
  {
    name: 'coordination_add_note',
    description: 'Append a note to a non-cancelled handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['handoffId', 'body'],
      additionalProperties: false,
    },
  },
];
