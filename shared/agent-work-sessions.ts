import { z } from 'zod';

export const AGENT_WORK_SESSION_STATES = [
  'PLANNED',
  'CLAIMED',
  'IN_PROGRESS',
  'NEEDS_INPUT',
  'BLOCKED',
  'COMPLETED',
  'ABANDONED',
] as const;
export const AGENT_WORK_SESSION_LIST_DEFAULT_LIMIT = 50;
export const AGENT_WORK_SESSION_LIST_MAX_LIMIT = 100;
export const AGENT_WORK_SESSION_WAITING_STATES = ['NEEDS_INPUT', 'BLOCKED'] as const;
export type AgentWorkSessionWaitingState = (typeof AGENT_WORK_SESSION_WAITING_STATES)[number];
export type AgentWorkSessionState = (typeof AGENT_WORK_SESSION_STATES)[number];
export const workSessionIdSchema = z.string().trim().min(1).max(200);
export const workSessionStepSchema = z.string().trim().min(1).max(500);
export const workSessionTextSchema = z.string().trim().min(1).max(2000);
export const workSessionJsonSchema = z.record(z.string(), z.unknown());
export const workSessionStartSchema = z
  .object({
    handoffId: workSessionIdSchema,
    leaseSeconds: z.number().int().min(30).max(86400).default(900),
    baseRevision: z.string().trim().min(1).max(200),
    branch: z.string().trim().max(500).optional(),
    worktree: z.string().trim().max(500).optional(),
    currentStep: workSessionStepSchema.optional(),
    clientRequestId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export const workSessionMutationSchema = z
  .object({
    sessionId: workSessionIdSchema,
    currentStep: workSessionStepSchema.optional(),
    evidence: workSessionJsonSchema.optional(),
    validations: z.array(workSessionJsonSchema).max(50).optional(),
    leaseSeconds: z.number().int().min(30).max(86400).optional(),
    clientRequestId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export const workSessionReleaseSchema = z
  .object({
    sessionId: workSessionIdSchema,
    reason: workSessionTextSchema,
    clientRequestId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type AgentWorkSession = {
  id: string;
  handoffId: string;
  subjectType: string;
  subjectId: string | null;
  agentLabel: string;
  state: AgentWorkSessionState;
  waitingSince: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  baseRevision: string;
  branch: string | null;
  worktree: string | null;
  currentStep: string | null;
  checkpoints: unknown[];
  evidence: Record<string, unknown>;
  validations: unknown[];
  createdAt: string;
  updatedAt: string;
  abandonedAt: string | null;
  abandonReason: string | null;
};
