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

export const AGENT_HANDOFF_LIST_DEFAULT_LIMIT = 50;
export const AGENT_HANDOFF_LIST_MAX_LIMIT = 100;

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
  resultSummary: 2000,
  evidenceItem: 500,
  evidenceItems: 50,
} as const;

export const agentHandoffListFilterSchema = z
  .object({
    state: z.enum(AGENT_HANDOFF_STATES).optional(),
    subjectType: z.enum(AGENT_HANDOFF_SUBJECT_TYPES).optional(),
    subjectId: z.string().trim().min(1).max(AGENT_COORDINATION_LIMITS.subjectId).optional(),
    limit: z.number().int().min(1).max(AGENT_HANDOFF_LIST_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Boolean(value.subjectType) !== Boolean(value.subjectId)) {
      ctx.addIssue({
        code: 'custom',
        message: 'subjectType and subjectId must be supplied together.',
      });
    }
  });

export type AgentHandoffListFilter = z.infer<typeof agentHandoffListFilterSchema>;

export const AGENT_HANDOFF_OUTCOMES = [
  'SUCCEEDED',
  'PARTIALLY_SUCCEEDED',
  'BLOCKED',
  'SUPERSEDED',
] as const;
export type AgentHandoffOutcome = (typeof AGENT_HANDOFF_OUTCOMES)[number];

export const AGENT_IDENTITY_PROVENANCE = ['UNKNOWN', 'ASSERTED', 'VERIFIED'] as const;
export type AgentIdentityProvenance = (typeof AGENT_IDENTITY_PROVENANCE)[number];

export const AGENT_IDENTITY_PROVENANCE_LABEL: Record<AgentIdentityProvenance, string> = {
  UNKNOWN: 'Identity provenance unknown',
  ASSERTED: 'Identity asserted, not scoped-credential verified',
  VERIFIED: 'Identity verified by scoped credential',
};

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

const completionTextSchema = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} must not be empty.`)
    .max(AGENT_COORDINATION_LIMITS.evidenceItem, `${label} is too long.`)
    .superRefine(withoutCredentials(label));

export const agentHandoffCompletionInputSchema = z
  .object({
    resultSummary: z
      .string()
      .trim()
      .min(1, 'A result summary is required.')
      .max(AGENT_COORDINATION_LIMITS.resultSummary)
      .superRefine(withoutCredentials('A result summary')),
    outcome: z.enum(AGENT_HANDOFF_OUTCOMES),
    changedPaths: z
      .array(completionTextSchema('A changed path'))
      .max(AGENT_COORDINATION_LIMITS.evidenceItems)
      .optional(),
    references: z
      .array(completionTextSchema('A reference'))
      .max(AGENT_COORDINATION_LIMITS.evidenceItems)
      .optional(),
    validations: z
      .array(
        z
          .object({
            command: completionTextSchema('A validation command'),
            outcome: completionTextSchema('A validation outcome'),
          })
          .strict(),
      )
      .max(AGENT_COORDINATION_LIMITS.evidenceItems)
      .optional(),
    remainingRisks: z
      .array(completionTextSchema('A remaining risk'))
      .max(AGENT_COORDINATION_LIMITS.evidenceItems)
      .optional(),
  })
  .strict();

export type AgentHandoffCompletionInput = z.infer<typeof agentHandoffCompletionInputSchema>;

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
    fromAgentProvenance: z.enum(AGENT_IDENTITY_PROVENANCE).optional(),
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
    agentProvenance: z.enum(AGENT_IDENTITY_PROVENANCE).optional(),
    body: agentHandoffNoteBodySchema,
  })
  .strict();

export type AgentHandoffNoteInput = z.infer<typeof agentHandoffNoteInputSchema>;

export interface AgentHandoff {
  id: string;
  createdAt: string;
  updatedAt: string;
  fromAgentLabel: string;
  fromAgentProvenance: AgentIdentityProvenance;
  toAgentLabel: string | null;
  subjectType: AgentHandoffSubjectType;
  subjectId: string | null;
  message: string;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  state: AgentHandoffState;
  claimedBy: string | null;
  claimedByProvenance: AgentIdentityProvenance | null;
  claimedAt: string | null;
  completedAt: string | null;
  completedByProvenance: AgentIdentityProvenance | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  clientRequestId: string | null;
  outcome?: AgentHandoffOutcome | null;
  resultSummary?: string | null;
  changedPaths?: string[];
  references?: string[];
  validations?: Array<{ command: string; outcome: string }>;
  remainingRisks?: string[];
}

export interface AgentHandoffPage {
  handoffs: AgentHandoff[];
  limit: number;
  offset: number;
  truncated: boolean;
}

export interface AgentHandoffNote {
  id: string;
  handoffId: string;
  agentLabel: string;
  agentProvenance: AgentIdentityProvenance;
  body: string;
  at: string;
}

export interface AgentHandoffDetail extends AgentHandoff {
  notes: AgentHandoffNote[];
}

/** OPEN handoffs older than this surface a stale warning in the operator inbox (C112). */
export const AGENT_HANDOFF_OPEN_TTL_DAYS = 30;

/** Completed and cancelled rows the operator inbox shows by default (C112). */
export const AGENT_HANDOFF_HISTORY_DAYS = 7;

export const AGENT_HANDOFF_INBOX_GROUPS = ['open', 'claimed', 'completed', 'cancelled'] as const;
export type AgentHandoffInboxGroup = (typeof AGENT_HANDOFF_INBOX_GROUPS)[number];

export const AGENT_HANDOFF_INBOX_GROUP_LABEL: Record<AgentHandoffInboxGroup, string> = {
  open: 'Open',
  claimed: 'Claimed',
  completed: 'Completed (7d)',
  cancelled: 'Cancelled (7d)',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (earlierIso: string, now: Date): number => {
  const earlier = Date.parse(earlierIso);
  if (Number.isNaN(earlier)) return 0;
  return (now.getTime() - earlier) / MS_PER_DAY;
};

/** True when an OPEN handoff has sat longer than the OPEN TTL without a claim. */
export function isStaleOpenHandoff(handoff: AgentHandoff, now: Date = new Date()): boolean {
  return (
    handoff.state === 'OPEN' && daysBetween(handoff.createdAt, now) > AGENT_HANDOFF_OPEN_TTL_DAYS
  );
}

/**
 * Whether a terminal handoff belongs in the inbox's recent history groups.
 * OPEN and CLAIMED are always in their live groups; completed/cancelled need a recent stamp.
 */
export function handoffInInboxHistory(handoff: AgentHandoff, now: Date = new Date()): boolean {
  if (handoff.state === 'COMPLETED') {
    return Boolean(
      handoff.completedAt && daysBetween(handoff.completedAt, now) <= AGENT_HANDOFF_HISTORY_DAYS,
    );
  }
  if (handoff.state === 'CANCELLED') {
    return Boolean(
      handoff.cancelledAt && daysBetween(handoff.cancelledAt, now) <= AGENT_HANDOFF_HISTORY_DAYS,
    );
  }
  return true;
}

/** Groups handoffs the way the operator inbox lists them — live open/claimed, then 7-day history. */
export function groupHandoffsForInbox(
  handoffs: AgentHandoff[],
  now: Date = new Date(),
): Record<AgentHandoffInboxGroup, AgentHandoff[]> {
  const groups: Record<AgentHandoffInboxGroup, AgentHandoff[]> = {
    open: [],
    claimed: [],
    completed: [],
    cancelled: [],
  };
  for (const handoff of handoffs) {
    if (handoff.state === 'OPEN') groups.open.push(handoff);
    else if (handoff.state === 'CLAIMED') groups.claimed.push(handoff);
    else if (handoff.state === 'COMPLETED' && handoffInInboxHistory(handoff, now))
      groups.completed.push(handoff);
    else if (handoff.state === 'CANCELLED' && handoffInInboxHistory(handoff, now))
      groups.cancelled.push(handoff);
  }
  return groups;
}

/** Short message preview for list rows; full text stays on the detail view. */
export function handoffMessageExcerpt(message: string, max = 140): string {
  const trimmed = message.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * In-app path for a bound subject, or null when freeform / unbound / unresolved.
 * Tasks need a project id from the workspace; without one there is nowhere useful to go.
 */
export function handoffSubjectPath(
  handoff: Pick<AgentHandoff, 'subjectType' | 'subjectId'>,
  tasks: ReadonlyArray<{ id: string; projectId: string }> = [],
): string | null {
  const id = handoff.subjectId;
  if (!id) return null;
  switch (handoff.subjectType) {
    case 'client':
      return `/clients/${id}`;
    case 'project':
      return `/projects/${id}`;
    case 'signal_post':
      return `/signal?post=${encodeURIComponent(id)}`;
    case 'task': {
      const task = tasks.find((candidate) => candidate.id === id);
      return task ? `/tasks/${encodeURIComponent(task.id)}` : null;
    }
    case 'freeform':
      return null;
  }
}

export const AGENT_HANDOFF_SUBJECT_TYPE_LABEL: Record<AgentHandoffSubjectType, string> = {
  task: 'Task',
  signal_post: 'Signal post',
  project: 'Project',
  client: 'Client',
  freeform: 'Note',
};
