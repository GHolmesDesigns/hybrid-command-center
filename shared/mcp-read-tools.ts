/**
 * Bounds for MCP workspace and Signal read tools (C122).
 *
 * Every list response is capped; callers paginate with limit/offset where supported.
 */
import { z } from 'zod';
import { SIGNAL_LIFECYCLE_FILTERS } from './signal.ts';
import { TASK_PRIORITIES, TASK_STATUSES } from './types.ts';

/** Default and maximum page size for `workspace_list_tasks`. */
export const MCP_TASK_LIST_DEFAULT_LIMIT = 50;
export const MCP_TASK_LIST_MAX_LIMIT = 100;

/** Maximum tasks returned in each dashboard bucket over MCP. */
export const MCP_DASHBOARD_TASK_LIMIT = 25;

/** Maximum recent projects in `workspace_dashboard_summary`. */
export const MCP_DASHBOARD_PROJECT_LIMIT = 5;

/** Unscheduled posts included in `signal_queue_snapshot`. */
export const MCP_QUEUE_UNSCHEDULED_LIMIT = 100;

/** Default upcoming window for `signal_queue_snapshot` when `to` is omitted (days). */
export const MCP_QUEUE_UPCOMING_DAYS = 30;

export const mcpTaskListArgsSchema = z
  .object({
    projectId: z.string().trim().min(1).max(200).optional(),
    clientId: z.string().trim().min(1).max(200).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    limit: z.number().int().min(1).max(MCP_TASK_LIST_MAX_LIMIT).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const mcpSignalListPostsArgsSchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lifecycle: z.enum(SIGNAL_LIFECYCLE_FILTERS).optional(),
  })
  .strict();

export const mcpSignalQueueSnapshotArgsSchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    lifecycle: z.enum(SIGNAL_LIFECYCLE_FILTERS).optional(),
  })
  .strict();

export const mcpSignalPublishPreviewArgsSchema = z
  .object({
    postId: z.string().trim().min(1).max(200),
    driveOverride: z.boolean().optional(),
  })
  .strict();

export type McpTaskListArgs = z.infer<typeof mcpTaskListArgsSchema>;
export type McpSignalListPostsArgs = z.infer<typeof mcpSignalListPostsArgsSchema>;
export type McpSignalQueueSnapshotArgs = z.infer<typeof mcpSignalQueueSnapshotArgsSchema>;
export type McpSignalPublishPreviewArgs = z.infer<typeof mcpSignalPublishPreviewArgsSchema>;
