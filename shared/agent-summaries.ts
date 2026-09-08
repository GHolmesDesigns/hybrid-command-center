import { z } from 'zod';
import { agentLabelSchema } from './agent-coordination.ts';

export const PRESENCE_STATES = ['AVAILABLE', 'BUSY', 'AWAY', 'OFFLINE'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];
export const presenceInputSchema = z
  .object({
    state: z.enum(PRESENCE_STATES),
    availability: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const summaryListSchema = z
  .object({
    agentLabel: agentLabelSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export const notificationListSchema = z
  .object({
    unreadOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type AgentPresence = {
  agentLabel: string;
  state: PresenceState;
  availability: string | null;
  verifiedAt: string;
  lastActivityAt: string | null;
};
export type AgentSummary = {
  id: string;
  agentLabel: string;
  text: string;
  generatedAt: string;
  evidence: string[];
};
export type AgentNotification = {
  id: string;
  incidentKey: string;
  kind: string;
  agentLabel: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
};
