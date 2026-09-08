import { z } from 'zod';
import { agentLabelSchema } from './agent-coordination.ts';

export const CONVERSATION_SCOPE_TYPES = ['client', 'project', 'task', 'freeform'] as const;
export type ConversationScopeType = (typeof CONVERSATION_SCOPE_TYPES)[number];
export const CONVERSATION_STATES = ['ACTIVE', 'ARCHIVED'] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];
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
  })
  .strict();
export const messageSchema = z.string().trim().min(1).max(4000);
export const conversationListSchema = z
  .object({
    state: z.enum(CONVERSATION_STATES).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(500).optional(),
  })
  .strict();
export const messageListSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(500).optional(),
  })
  .strict();
export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type AgentConversation = {
  id: string;
  title: string;
  scope: { type: ConversationScopeType; id: string | null };
  state: ConversationState;
  createdAt: string;
  updatedAt: string;
  participants: string[];
  messageCount: number;
};
export type AgentConversationMessage = {
  id: string;
  conversationId: string;
  senderLabel: string;
  sentAt: string;
  body: string;
};
export type CursorPage<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
