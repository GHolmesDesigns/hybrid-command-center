/**
 * Bounds for MCP workspace and Signal read tools (C122, C123).
 *
 * Every list response is capped; callers paginate with limit/offset where supported.
 */
import { z } from 'zod';
import { AGENT_HANDOFF_SUBJECT_TYPES } from './agent-coordination.ts';
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

/** Related handoffs included in `workspace_get_subject_context`. */
export const MCP_SUBJECT_CONTEXT_HANDOFF_LIMIT = 10;

/** Integration activity rows included in `workspace_get_subject_context`. */
export const MCP_SUBJECT_CONTEXT_ACTIVITY_LIMIT = 15;

/** Matches per entity kind in `workspace_search`. */
export const MCP_WORKSPACE_SEARCH_PER_TYPE_LIMIT = 5;

/** Hard ceiling on `workspace_search` hits across all kinds. */
export const MCP_WORKSPACE_SEARCH_TOTAL_LIMIT = 20;

/** Minimum trimmed query length for `workspace_search`. */
export const MCP_WORKSPACE_SEARCH_MIN_QUERY_LENGTH = 2;

/** Maximum trimmed query length for `workspace_search`. */
export const MCP_WORKSPACE_SEARCH_MAX_QUERY_LENGTH = 100;

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
    projectId: z.string().trim().min(1).max(200).optional(),
    campaign: z.string().trim().min(1).max(60).optional(),
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

export const mcpSubjectContextArgsSchema = z
  .object({
    subjectType: z.enum(AGENT_HANDOFF_SUBJECT_TYPES),
    subjectId: z.string().trim().min(1).max(200),
  })
  .strict();

export const mcpWorkspaceSearchArgsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(
        MCP_WORKSPACE_SEARCH_MIN_QUERY_LENGTH,
        `A search query must be at least ${MCP_WORKSPACE_SEARCH_MIN_QUERY_LENGTH} characters.`,
      )
      .max(MCP_WORKSPACE_SEARCH_MAX_QUERY_LENGTH),
  })
  .strict();

export type McpSubjectContextArgs = z.infer<typeof mcpSubjectContextArgsSchema>;
export type McpWorkspaceSearchArgs = z.infer<typeof mcpWorkspaceSearchArgsSchema>;
