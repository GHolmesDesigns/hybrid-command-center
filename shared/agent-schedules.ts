/**
 * Scheduled agent-run vocabulary (C215 / #601).
 *
 * A schedule is only a durable recipe for posting a normal coordination handoff. It never
 * claims or completes work, and it has no path to publishing, Drive, or another provider.
 */
import { z } from 'zod';
import {
  AGENT_HANDOFF_SUBJECT_TYPES,
  agentHandoffMessageSchema,
  agentHandoffSubjectIdSchema,
  agentLabelSchema,
  type AgentHandoffSubjectType,
} from './agent-coordination.ts';

export const AGENT_SCHEDULE_FAILURE_POLICIES = ['RETRY', 'PAUSE'] as const;
export type AgentScheduleFailurePolicy = (typeof AGENT_SCHEDULE_FAILURE_POLICIES)[number];

export const AGENT_SCHEDULE_RUN_STATUSES = ['SUCCEEDED', 'FAILED'] as const;
export type AgentScheduleRunStatus = (typeof AGENT_SCHEDULE_RUN_STATUSES)[number];

export const AGENT_SCHEDULE_LIMITS = {
  cronExpression: 100,
  dedupeKey: 30,
  error: 500,
} as const;

const isoInstantSchema = z.string().datetime({ offset: true });

/** Five-field UTC cron. The service validates the fields before calculating the next run. */
export const agentScheduleCronSchema = z
  .string()
  .trim()
  .min(1, 'A cron expression is required.')
  .max(AGENT_SCHEDULE_LIMITS.cronExpression)
  .regex(/^[0-9*/,?\-\s]+$/, 'Cron expressions may use numbers, lists, ranges, steps, and *.')
  .refine((value) => isValidCronExpression(value), 'Cron expressions must have five valid fields.');

export const agentScheduleInputSchema = z
  .object({
    ownerAgentLabel: agentLabelSchema,
    cronExpression: agentScheduleCronSchema.nullable().optional(),
    nextRunAt: isoInstantSchema,
    toAgentLabel: agentLabelSchema.nullable().optional(),
    subjectType: z.enum(AGENT_HANDOFF_SUBJECT_TYPES),
    subjectId: agentHandoffSubjectIdSchema.nullable().optional(),
    messageTemplate: agentHandoffMessageSchema,
    dedupeKey: z.string().trim().min(1).max(AGENT_SCHEDULE_LIMITS.dedupeKey),
    paused: z.boolean().optional().default(false),
    failurePolicy: z.enum(AGENT_SCHEDULE_FAILURE_POLICIES).optional().default('RETRY'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.subjectType === 'freeform' && value.subjectId) {
      ctx.addIssue({
        code: 'custom',
        path: ['subjectId'],
        message: 'Freeform subjects have no id.',
      });
    }
  });

export type AgentScheduleInput = z.infer<typeof agentScheduleInputSchema>;

export const agentSchedulePauseSchema = z.object({ paused: z.boolean() }).strict();

export interface AgentSchedule {
  id: string;
  createdAt: string;
  updatedAt: string;
  ownerAgentLabel: string;
  cronExpression: string | null;
  nextRunAt: string | null;
  toAgentLabel: string | null;
  subjectType: AgentHandoffSubjectType;
  subjectId: string | null;
  messageTemplate: string;
  dedupeKey: string;
  paused: boolean;
  failurePolicy: AgentScheduleFailurePolicy;
  lastRunStatus: AgentScheduleRunStatus | null;
  lastRunAt: string | null;
  lastRunWindow: string | null;
  lastHandoffId: string | null;
  lastError: string | null;
}

export interface AgentScheduleRun {
  id: string;
  scheduleId: string;
  runWindow: string;
  status: 'RUNNING' | AgentScheduleRunStatus;
  handoffId: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type CronField = { min: number; max: number; values: Set<number> };

const CRON_RANGES: ReadonlyArray<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseCronField(raw: string, min: number, max: number): CronField | null {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const [rangeText, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    const range = rangeText === '*' || rangeText === '?' ? [min, max] : rangeText.split('-');
    const start = range[0] === '*' || range[0] === '?' ? min : Number(range[0]);
    const end = range.length === 1 ? start : Number(range[1]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < min ||
      end > max ||
      start > end
    )
      return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? { min, max, values } : null;
}

function cronFields(expression: string): CronField[] | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((part, index) => parseCronField(part, ...CRON_RANGES[index]!));
  return fields.every(Boolean) ? (fields as CronField[]) : null;
}

export function isValidCronExpression(expression: string): boolean {
  return cronFields(expression) !== null;
}

function cronMatches(date: Date, fields: CronField[]): boolean {
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  const domRestricted = fields[2]!.values.size !== 31;
  const dowRestricted = fields[4]!.values.size !== 8;
  const dowMatches =
    fields[4]!.values.has(values[4]!) || (values[4] === 0 && fields[4]!.values.has(7));
  const dayMatches =
    (!domRestricted || fields[2]!.values.has(values[2]!)) && (!dowRestricted || dowMatches);
  const standardDayMatch =
    domRestricted && dowRestricted ? fields[2]!.values.has(values[2]!) || dowMatches : dayMatches;
  return (
    fields[0]!.values.has(values[0]!) &&
    fields[1]!.values.has(values[1]!) &&
    standardDayMatch &&
    fields[3]!.values.has(values[3]!)
  );
}

/** Returns the next matching minute after `after`, bounded to one year of minute ticks. */
export function nextCronRun(expression: string, after: Date): Date | null {
  const fields = cronFields(expression);
  if (!fields) return null;
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const limit = candidate.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= limit) {
    if (cronMatches(candidate, fields)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return null;
}

export function scheduleRunWindow(nextRunAt: string): string {
  const date = new Date(nextRunAt);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export const scheduleErrorText = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : 'The scheduled run failed.';
  return raw.trim().slice(0, AGENT_SCHEDULE_LIMITS.error);
};
