import { z } from 'zod';

export const MCP_TIME_ENTRY_LIST_MAX_LIMIT = 100;

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD dates.')
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
    'Use a valid calendar date.',
  );
const idSchema = z.string().uuid();
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid IANA time zone.');

export const mcpTimeListEntriesArgsSchema = z
  .object({
    projectId: idSchema.optional(),
    taskId: idSchema.optional(),
    categoryId: idSchema.optional(),
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    timeZone: timeZoneSchema.default('UTC'),
    limit: z.number().int().min(1).max(MCP_TIME_ENTRY_LIST_MAX_LIMIT).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from && value.to && value.from > value.to) {
      context.addIssue({ code: 'custom', path: ['to'], message: 'to must be on or after from.' });
    }
  });

export const mcpTimeProjectSummaryArgsSchema = z.object({ projectId: idSchema }).strict();
export const mcpTimeActiveArgsSchema = z.object({}).strict();

const mcpTimeEntryInput = z.object({
  projectId: idSchema,
  categoryId: idSchema,
  taskId: idSchema.nullable().optional(),
  startDate: dateSchema,
  startTime: z.string().min(1).max(20),
  endDate: dateSchema.optional(),
  endTime: z.string().min(1).max(20),
  timeZone: timeZoneSchema,
  startAmbiguity: z.enum(['earlier', 'later']).optional(),
  endAmbiguity: z.enum(['earlier', 'later']).optional(),
  notes: z.string().max(2000).default(''),
});

export const mcpTimeCreateEntryArgsSchema = mcpTimeEntryInput
  .extend({ clientRequestId: z.string().trim().min(1).max(200) })
  .strict();

export const mcpTimeUpdateEntryArgsSchema = mcpTimeEntryInput
  .extend({
    entryId: idSchema,
    revision: z.number().int().min(1),
    clientRequestId: z.string().trim().min(1).max(200),
  })
  .strict();

export const mcpTimeDeleteEntryArgsSchema = z
  .object({
    entryId: idSchema,
    revision: z.number().int().min(1),
    clientRequestId: z.string().trim().min(1).max(200),
  })
  .strict();
