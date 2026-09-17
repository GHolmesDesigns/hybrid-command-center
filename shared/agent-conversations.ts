import { z } from 'zod';
import {
  agentHandoffClientRequestIdSchema,
  agentLabelSchema,
  type AgentHandoffState,
  type AgentIdentityProvenance,
} from './agent-coordination.ts';
import {
  COMMAND_AI_PAGE_CONTEXT_SUBJECT_TYPES,
  type CommandAiPageContext,
} from './command-ai-page-context.ts';

export const CONVERSATION_SCOPE_TYPES = ['client', 'project', 'task', 'freeform'] as const;
export type ConversationScopeType = (typeof CONVERSATION_SCOPE_TYPES)[number];
export const CONVERSATION_STATES = ['ACTIVE', 'ARCHIVED'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];
export const CONVERSATION_SENDER_KINDS = ['operator', 'agent', 'assistant'] as const;
export type ConversationSenderKind = (typeof CONVERSATION_SENDER_KINDS)[number];
const optionalBooleanQuery = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean().optional(),
);
export const conversationScopeSchema = z
  .object({
    type: z.enum(CONVERSATION_SCOPE_TYPES),
    id: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type !== 'freeform' && !value.id)
      ctx.addIssue({ code: 'custom', message: 'A scoped conversation requires an id.' });
  });
export const createConversationSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    scope: conversationScopeSchema,
    participantLabels: z.array(agentLabelSchema).max(50).default([]),
    /** When true on a scoped thread, create a non-canonical sibling instead of the scope default. */
    secondary: z.boolean().optional(),
  })
  .strict();
export const messageSchema = z.string().trim().min(1).max(4000);
export const thoughtSummarySchema = z.string().trim().min(1).max(4000);

export const commandAiPageContextSchema = z
  .object({
    pathname: z.string().max(500),
    search: z.string().max(2000),
    label: z.string().max(500),
    subjectType: z.enum(COMMAND_AI_PAGE_CONTEXT_SUBJECT_TYPES).nullable(),
    subjectId: z.string().max(200).nullable(),
    capturedAt: z.string().datetime(),
  })
  .strict();

export const postMessageInputSchema = z
  .object({
    body: messageSchema,
    thoughtSummary: thoughtSummarySchema.optional(),
    confirmHandoffs: z.array(agentLabelSchema).max(50).default([]),
    clientRequestId: agentHandoffClientRequestIdSchema.optional(),
    pageContext: commandAiPageContextSchema.optional(),
  })
  .strict();
export const conversationDecisionSchema = z
  .object({ outcome: z.string().trim().max(500).optional() })
  .strict();
export type PostMessageInput = z.infer<typeof postMessageInputSchema>;
export type { CommandAiPageContext };
export const scopedConversationResolutionSchema = z
  .object({
    scopeType: z.enum(['client', 'project', 'task']),
    scopeId: z.string().trim().min(1).max(200),
  })
  .strict();

export const conversationListSchema = z
  .object({
    state: z.enum(CONVERSATION_STATES).optional(),
    isDecision: optionalBooleanQuery,
    scopeType: z.enum(CONVERSATION_SCOPE_TYPES).optional(),
    scopeId: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!!value.scopeType !== !!value.scopeId)
      ctx.addIssue({ code: 'custom', message: 'scopeType and scopeId must be supplied together.' });
    if (value.scopeType === 'freeform')
      ctx.addIssue({ code: 'custom', message: 'A detail discussion must have a workspace scope.' });
  });
export const messageListSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(500).optional(),
    direction: z.enum(['forward', 'before']).default('forward'),
  })
  .strict();
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type AgentConversation = {
  id: string;
  title: string;
  scope: { type: ConversationScopeType; id: string | null };
  state: ConversationState;
  /** True for the one canonical active thread per scoped subject; always false for freeform. */
  isCanonical: boolean;
  isDecision: boolean;
  decisionOutcome: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  participants: string[];
  messageCount: number;
};

export type ScopedConversationResolution = {
  scope: { type: Exclude<ConversationScopeType, 'freeform'>; id: string };
  canonicalId: string | null;
  secondaryThreads: AgentConversation[];
};
export type MessageLinkedHandoff = {
  id: string;
  toAgentLabel: string;
  state: AgentHandoffState;
};

export type AgentConversationMessage = {
  id: string;
  conversationId: string;
  senderLabel: string;
  senderKind: ConversationSenderKind;
  sentAt: string;
  body: string;
  thoughtSummary: string | null;
  provenance: AgentIdentityProvenance;
  linkedHandoffs: MessageLinkedHandoff[];
};

export type AgentHandoffSource = {
  conversationId: string;
  messageId: string;
};
export type CursorPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
