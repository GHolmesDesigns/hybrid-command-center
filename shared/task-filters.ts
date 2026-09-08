import { z } from 'zod';
import { TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from './types.ts';

export const TASK_FOCUS_FLAGS = [
  'overdue',
  'today',
  'week',
  'none',
  'blocked',
  'completed',
] as const;
export type TaskFocusFlag = (typeof TASK_FOCUS_FLAGS)[number];

export const taskFilterSchema = z
  .object({
    clients: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    projects: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    priorities: z.array(z.enum(TASK_PRIORITIES)).max(TASK_PRIORITIES.length).default([]),
    statuses: z.array(z.enum(TASK_STATUSES)).max(TASK_STATUSES.length).default([]),
    types: z
      .array(z.union([z.enum(TASK_TYPES), z.literal('none')]))
      .max(TASK_TYPES.length + 1)
      .default([]),
    focus: z.array(z.enum(TASK_FOCUS_FLAGS)).max(TASK_FOCUS_FLAGS.length).default([]),
    tags: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    search: z.string().trim().max(200).default(''),
  })
  .transform((value) => ({
    clients: [...new Set(value.clients)].sort(),
    projects: [...new Set(value.projects)].sort(),
    priorities: [...new Set(value.priorities)].sort(),
    statuses: [...new Set(value.statuses)].sort(),
    types: [...new Set(value.types)].sort(),
    focus: [...new Set(value.focus)].sort(),
    tags: [...new Set(value.tags)].sort(),
    search: value.search,
  }));

export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const taskPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: taskFilterSchema,
  scope: z.enum(['shared', 'operator']).default('shared'),
});
export type TaskPresetInput = z.infer<typeof taskPresetInputSchema>;

export interface TaskFilterPreset extends TaskPresetInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const taskFiltersFromQuery = (query: Record<string, unknown>): TaskFilter =>
  taskFilterSchema.parse({
    clients: String(query.client ?? '')
      .split(',')
      .filter(Boolean),
    projects: String(query.project ?? '')
      .split(',')
      .filter(Boolean),
    priorities: String(query.priority ?? '')
      .split(',')
      .filter(Boolean),
    statuses: String(query.status ?? '')
      .split(',')
      .filter(Boolean),
    types: String(query.type ?? '')
      .split(',')
      .filter(Boolean),
    focus: String(query.filter ?? '')
      .split(',')
      .filter(Boolean),
    tags: String(query.tags ?? '')
      .split(',')
      .filter(Boolean),
    search: query.search ?? '',
  });
