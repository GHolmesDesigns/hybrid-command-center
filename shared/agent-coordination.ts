/**
 * Agent handoff queue vocabulary (C110).
 *
 * Shared types, bounds, and Zod schemas for the coordination hub. Domain transition rules live in
 * `server/domain/agent-coordination.ts`; persistence in `server/agent-coordination/service.ts`.
 * Completing a handoff never publishes, syncs Drive, or imports — coordination is metadata beside
 * the workspace.
 *
 * `agentLabelSchema` is the label contract MCP-C106 is expected to reuse for init validation.
 */
import { z } from 'zod';

export const AGENT_HANDOFF_STATES = ['OPEN', 'CLAIMED', 'COMPLETED', 'CANCELLED'] as const;
export type AgentHandoffState = (typeof AGENT_HANDOFF_STATES)[number];

export const AGENT_HANDOFF_SUBJECT_TYPES = [
  'task',
  'signal_post',
  'project',
  'client',
  'freeform',
] as const;
export type AgentHandoffSubjectType = (typeof AGENT_HANDOFF_SUBJECT_TYPES)[number];

/** Bounds settled in docs/agent-coordination-plan.md §4.2. */
export const AGENT_COORDINATION_LIMITS = {
  agentLabel: 64,
  clientRequestId: 64,
  message: 2000,
  noteBody: 2000,
  cancelReason: 500,
  subjectId: 200,
} as const;

/**
 * Portable agent label: non-empty, trimmed, max 64, letters/digits plus `.` `_` `-`.
 * MCP-C106 owns init wiring; this is the charset both layers share.
 */
export const AGENT_LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/;

const CREDENTIAL_WORD =
  '(?:access_?token|refresh_?token|id_?token|client_?secret|api[-_]?key|auth(?:orization)?|token|secret|password|passwd|credential|private_?key|signature)';

const CREDENTIAL_PATTERNS: RegExp[] = [
  /\bbearer\s+[\w.\-+/=]+/i,
  new RegExp(`\\b${CREDENTIAL_WORD}"?\\s*[:=]\\s*"?[^\\s"',;)}\\]]+`, 'i'),
  /\bya29\.[\w.\-+/=]+/,
  /\b1\/\/[\w.\-+/=]{10,}/,
  /\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+/,
];

/** True when free text looks like it embeds a credential rather than ordinary prose or a URL. */
export function containsCredentialShape(text: string): boolean {
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(text));
}

const withoutCredentials = (field: string) => (value: string, context: z.RefinementCtx) => {
  if (containsCredentialShape(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must not contain credentials or API keys.`,
    });
  }
};

export const agentLabelSchema = z
  .string()
  .trim()
  .min(1, 'An agent label is required.')
  .max(
    AGENT_COORDINATION_LIMITS.agentLabel,
    `An agent label must be at most ${AGENT_COORDINATION_LIMITS.agentLabel} characters.`,
  )
  .regex(
    AGENT_LABEL_PATTERN,
    'An agent label may only use letters, digits, and . _ - , and must start and end with a letter or digit.',
  );

export const agentHandoffMessageSchema = z
  .string()
  .trim()
  .min(1, 'A handoff message is required.')
  .max(
    AGENT_COORDINATION_LIMITS.message,
    `A handoff message must be at most ${AGENT_COORDINATION_LIMITS.message} characters.`,
  )
  .superRefine(withoutCredentials('A handoff message'));

export const agentHandoffNoteBodySchema = z
  .string()
  .trim()
  .min(1, 'A note body is required.')
  .max(
    AGENT_COORDINATION_LIMITS.noteBody,
    `A note body must be at most ${AGENT_COORDINATION_LIMITS.noteBody} characters.`,
  )
  .superRefine(withoutCredentials('A note body'));

export const agentHandoffCancelReasonSchema = z
  .string()
  .trim()
  .min(1, 'A cancel reason is required.')
  .max(
    AGENT_COORDINATION_LIMITS.cancelReason,
    `A cancel reason must be at most ${AGENT_COORDINATION_LIMITS.cancelReason} characters.`,
  )
  .superRefine(withoutCredentials('A cancel reason'));

export const agentHandoffClientRequestIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(
    AGENT_COORDINATION_LIMITS.clientRequestId,
    `A client request id must be at most ${AGENT_COORDINATION_LIMITS.clientRequestId} characters.`,
  );

export const agentHandoffSubjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(
    AGENT_COORDINATION_LIMITS.subjectId,
    `A subject id must be at most ${AGENT_COORDINATION_LIMITS.subjectId} characters.`,
  );

export const agentHandoffPostInputSchema = z
  .object({
    fromAgentLabel: agentLabelSchema,
    toAgentLabel: agentLabelSchema.nullable().optional(),
    subjectType: z.enum(AGENT_HANDOFF_SUBJECT_TYPES),
    subjectId: agentHandoffSubjectIdSchema.nullable().optional(),
    message: agentHandoffMessageSchema,
    clientRequestId: agentHandoffClientRequestIdSchema.optional(),
  })
  .strict();

export type AgentHandoffPostInput = z.infer<typeof agentHandoffPostInputSchema>;

export const agentHandoffCancelInputSchema = z
  .object({
    reason: agentHandoffCancelReasonSchema,
  })
  .strict();

export type AgentHandoffCancelInput = z.infer<typeof agentHandoffCancelInputSchema>;

export const agentHandoffNoteInputSchema = z
  .object({
    agentLabel: agentLabelSchema,
    body: agentHandoffNoteBodySchema,
  })
  .strict();

export type AgentHandoffNoteInput = z.infer<typeof agentHandoffNoteInputSchema>;

export interface AgentHandoff {
  id: string;
  createdAt: string;
  updatedAt: string;
  fromAgentLabel: string;
  toAgentLabel: string | null;
  subjectType: AgentHandoffSubjectType;
  subjectId: string | null;
  message: string;
  state: AgentHandoffState;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  clientRequestId: string | null;
}

export interface AgentHandoffNote {
  id: string;
  handoffId: string;
  agentLabel: string;
  body: string;
  at: string;
}

export interface AgentHandoffDetail extends AgentHandoff {
  notes: AgentHandoffNote[];
}
