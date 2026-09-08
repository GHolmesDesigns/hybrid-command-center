import { z } from 'zod';
import { agentLabelSchema, containsCredentialShape } from './agent-coordination.ts';

export const AGENT_MEMORY_SCOPES = ['workspace', 'client', 'project', 'task'] as const;
export const AGENT_MEMORY_STATES = ['SUGGESTED', 'APPROVED', 'ARCHIVED'] as const;
export type AgentMemoryScope = (typeof AGENT_MEMORY_SCOPES)[number];
export type AgentMemoryState = (typeof AGENT_MEMORY_STATES)[number];
export const AGENT_MEMORY_LIMITS = {
  key: 120,
  value: 4000,
  source: 200,
  retentionDays: 3650,
} as const;
const scopeSchema = z
  .object({
    type: z.enum(AGENT_MEMORY_SCOPES),
    id: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.type !== 'workspace' && !v.id)
      c.addIssue({ code: 'custom', message: 'A scoped memory record requires an id.' });
  });
const safeText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .superRefine((v, c) => {
      if (containsCredentialShape(v))
        c.addIssue({
          code: 'custom',
          message: `${label} must not contain credentials or API keys.`,
        });
    });
export const agentMemoryInputSchema = z
  .object({
    key: safeText('A memory key', AGENT_MEMORY_LIMITS.key),
    value: safeText('A memory value', AGENT_MEMORY_LIMITS.value),
    scope: scopeSchema,
    source: safeText('A memory source', AGENT_MEMORY_LIMITS.source),
    retentionDays: z.number().int().min(1).max(AGENT_MEMORY_LIMITS.retentionDays).optional(),
  })
  .strict();
export const agentMemoryPatchSchema = z
  .object({
    key: safeText('A memory key', AGENT_MEMORY_LIMITS.key).optional(),
    value: safeText('A memory value', AGENT_MEMORY_LIMITS.value).optional(),
    scope: scopeSchema.optional(),
    retentionDays: z.number().int().min(1).max(AGENT_MEMORY_LIMITS.retentionDays).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'A correction is required.');
export const agentMemoryListSchema = z
  .object({
    scope: z.enum(AGENT_MEMORY_SCOPES).optional(),
    scopeId: z.string().trim().min(1).max(200).optional(),
    state: z.enum(AGENT_MEMORY_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type AgentMemoryInput = z.infer<typeof agentMemoryInputSchema>;
export type AgentMemory = {
  id: string;
  key: string;
  value: string;
  scope: { type: AgentMemoryScope; id: string | null };
  state: AgentMemoryState;
  source: string;
  suggestedBy: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};
export const memoryAgentLabel = agentLabelSchema;
