/**
 * MCP workspace and Signal read tools (C122).
 *
 * Each tool maps to exactly one existing service function. Domain rules stay in their owner modules;
 * this module validates MCP-facing args, enforces caps, and redacts results.
 */
import { addDays, format } from 'date-fns';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { buildBoundedDashboardSummary } from '../domain/dashboard.ts';
import { DisconnectedDriveMediaProvider } from '../drive/media.ts';
import { PublishService, PublishRequestError } from '../publish/service.ts';
import { UnavailablePublishProvider } from '../publish/provider.ts';
import { listClients, listTasksPage } from '../repositories.ts';
import { getOperatorTimer } from '../operator-timer.ts';
import {
  listProjectTimeCategories,
  projectTimeSummary,
  ProjectTimeError,
} from '../project-time.ts';
import { filterWorkspaceTimeEntries, listWorkspaceTimeEntries } from '../workspace-time.ts';
import { listPostsInRange, signalProvider } from '../signal/read.ts';
import { readQueueHealth } from '../signal/queue-health.ts';
import { listQueuePage } from '../signal/service.ts';
import type { DashboardData } from '../../shared/types.ts';
import {
  mcpCoordinationInvalidArguments,
  mcpCoordinationNotFound,
  mcpCoordinationToolFailed,
  type McpCoordinationErrorDetail,
} from '../../shared/mcp-coordination-errors.ts';
import {
  MCP_DASHBOARD_TASK_LIMIT,
  MCP_QUEUE_UNSCHEDULED_LIMIT,
  MCP_QUEUE_UPCOMING_DAYS,
  MCP_TASK_LIST_DEFAULT_LIMIT,
  mcpClientGetArgsSchema,
  mcpClientListArgsSchema,
  mcpSignalListPostsArgsSchema,
  mcpSignalPublishPreviewArgsSchema,
  mcpSignalQueueSnapshotArgsSchema,
  mcpSubjectContextArgsSchema,
  mcpTaskListArgsSchema,
  mcpWorkspaceSearchArgsSchema,
} from '../../shared/mcp-read-tools.ts';
import {
  mcpTimeActiveArgsSchema,
  mcpTimeListCategoriesArgsSchema,
  mcpTimeListEntriesArgsSchema,
  mcpTimeProjectSummaryArgsSchema,
} from '../../shared/mcp-time-tools.ts';
import type { McpToolCallResult } from './coordination.ts';
import { redactToolResult } from './redact.ts';
import { buildSubjectContext, buildWorkspaceSearch } from './workspace-subject-context.ts';

export type McpWorkspaceReadDeps = {
  previewPublisher?: PublishService;
  now?: Date;
};

const success = (data: unknown): McpToolCallResult => ({
  outcome: 'SUCCESS',
  data: redactToolResult(data),
});

function withProjectTimeTotal<T extends { id: string }>(
  db: Db,
  project: T,
): T & { loggedSeconds: number } {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(duration_seconds),0) logged_seconds FROM time_entries WHERE project_id=?',
    )
    .get(project.id) as { logged_seconds: number };
  return { ...project, loggedSeconds: Number(row.logged_seconds) };
}

const failed = (error: string, errorDetail: McpCoordinationErrorDetail): McpToolCallResult => ({
  outcome: 'FAILURE',
  error,
  errorDetail,
});

function mcpClient(client: ReturnType<typeof listClients>[number]) {
  return {
    id: client.id,
    name: client.name,
    slug: client.slug,
    contactName: client.contactName ?? null,
    email: client.email ?? null,
    phone: client.phone ?? null,
    website: client.website ?? null,
    notes: client.notes ?? null,
    status: client.status,
    driveStatus: client.driveStatus,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    revision: client.revision,
  };
}

/** Flatten assignment identity on the MCP boundary while keeping the shared Signal shape intact. */
const mcpSignalPosts = <
  T extends { client?: { id: string; name: string }; projectName?: string | null },
>(
  posts: T[],
) =>
  posts.map((post) => ({
    ...post,
    clientId: post.client?.id ?? null,
    clientName: post.client?.name ?? null,
    projectName: post.projectName ?? null,
  }));

function listActiveTasksForMcp(
  db: Db,
  args: z.infer<typeof mcpTaskListArgsSchema>,
): { tasks: DashboardData['overdueTasks']; limit: number; offset: number; truncated: boolean } {
  const limit = args.limit ?? MCP_TASK_LIST_DEFAULT_LIMIT;
  const offset = args.offset ?? 0;
  const clauses = ["p.status<>'ARCHIVED'", "c.status<>'ARCHIVED'"];
  const params: string[] = [];
  if (args.projectId) {
    clauses.push('t.project_id=?');
    params.push(args.projectId);
  }
  if (args.clientId) {
    clauses.push('p.client_id=?');
    params.push(args.clientId);
  }
  if (args.status) {
    clauses.push('t.status=?');
    params.push(args.status);
  }
  if (args.priority) {
    clauses.push('t.priority=?');
    params.push(args.priority);
  }
  const page = listTasksPage(db, `WHERE ${clauses.join(' AND ')}`, params, limit, offset);
  return {
    tasks: page.tasks,
    limit,
    offset,
    truncated: page.truncated,
  };
}

function defaultPreviewPublisher(db: Db, now: Date): PublishService {
  return new PublishService(
    db,
    signalProvider(db),
    new UnavailablePublishProvider(),
    'America/New_York',
    () => now,
    new DisconnectedDriveMediaProvider(),
  );
}

export async function callWorkspaceReadTool(
  db: Db,
  tool: string,
  rawArgs: unknown,
  deps: McpWorkspaceReadDeps = {},
): Promise<McpToolCallResult> {
  const now = deps.now ?? new Date();
  try {
    switch (tool) {
      case 'workspace_list_clients': {
        const args = mcpClientListArgsSchema.parse(rawArgs ?? {});
        const clients = listClients(db).filter(
          (client) => args.status === 'ALL' || client.status === args.status,
        );
        return success({
          clients: clients.slice(0, args.limit).map(mcpClient),
          limit: args.limit,
          total: clients.length,
          truncated: clients.length > args.limit,
        });
      }
      case 'workspace_get_client': {
        const args = mcpClientGetArgsSchema.parse(rawArgs ?? {});
        const client = listClients(db).find((candidate) => candidate.id === args.id);
        return client
          ? success(mcpClient(client))
          : failed('Client not found.', mcpCoordinationNotFound());
      }
      case 'time_list_entries': {
        const args = mcpTimeListEntriesArgsSchema.parse(rawArgs ?? {});
        const entries = filterWorkspaceTimeEntries(listWorkspaceTimeEntries(db), args);
        return success({
          entries: entries.slice(args.offset, args.offset + args.limit),
          limit: args.limit,
          offset: args.offset,
          total: entries.length,
          truncated: args.offset + args.limit < entries.length,
        });
      }
      case 'time_project_summary': {
        const args = mcpTimeProjectSummaryArgsSchema.parse(rawArgs ?? {});
        return success(projectTimeSummary(db, args.projectId));
      }
      case 'time_list_categories': {
        const args = mcpTimeListCategoriesArgsSchema.parse(rawArgs ?? {});
        const categories = listProjectTimeCategories(db, args.projectId)
          .filter((category) => category.selectable)
          .map((category) => ({
            id: category.id,
            name: category.name,
            scope: category.projectId ? 'project' : 'global',
          }));
        return success({ projectId: args.projectId, categories });
      }
      case 'time_get_active':
        mcpTimeActiveArgsSchema.parse(rawArgs ?? {});
        return success(getOperatorTimer(db));
      case 'workspace_dashboard_summary': {
        const summary = buildBoundedDashboardSummary(db, now, MCP_DASHBOARD_TASK_LIMIT);
        return success({
          ...summary,
          recentProjects: summary.recentProjects.map((project) =>
            withProjectTimeTotal(db, project),
          ),
        });
      }
      case 'workspace_list_tasks': {
        const args = mcpTaskListArgsSchema.parse(rawArgs ?? {});
        return success(listActiveTasksForMcp(db, args));
      }
      case 'signal_list_posts': {
        const args = mcpSignalListPostsArgsSchema.parse(rawArgs ?? {});
        if (args.from > args.to) {
          return failed('The range ends before it starts.', mcpCoordinationInvalidArguments());
        }
        const range = listPostsInRange(db, args.from, args.to, args.lifecycle ?? 'active', {
          projectIds: args.projectId ? [args.projectId] : undefined,
          clientIds: args.clientId ? [args.clientId] : undefined,
          campaignName: args.campaign,
        });
        return success({ ...range, posts: mcpSignalPosts(range.posts) });
      }
      case 'signal_queue_health':
        return success(readQueueHealth(db, now));
      case 'signal_queue_snapshot': {
        const args = mcpSignalQueueSnapshotArgsSchema.parse(rawArgs ?? {});
        const from = args.from ?? format(now, 'yyyy-MM-dd');
        const to = args.to ?? format(addDays(now, MCP_QUEUE_UPCOMING_DAYS), 'yyyy-MM-dd');
        if (from > to) {
          return failed('The range ends before it starts.', mcpCoordinationInvalidArguments());
        }
        const lifecycle = args.lifecycle ?? 'active';
        const unscheduledPage = listQueuePage(db, lifecycle, MCP_QUEUE_UNSCHEDULED_LIMIT);
        const upcoming = listPostsInRange(db, from, to, lifecycle);
        return success({
          from,
          to,
          unscheduled: mcpSignalPosts(unscheduledPage.posts),
          upcoming: mcpSignalPosts(upcoming.posts),
          truncated: {
            unscheduled: unscheduledPage.truncated,
            upcoming: upcoming.truncated,
          },
        });
      }
      case 'signal_publish_preview': {
        const args = mcpSignalPublishPreviewArgsSchema.parse(rawArgs ?? {});
        const exists = db.prepare('SELECT id FROM signal_posts WHERE id=?').get(args.postId);
        if (!exists) {
          return failed('Signal post not found.', mcpCoordinationNotFound());
        }
        const publisher = deps.previewPublisher ?? defaultPreviewPublisher(db, now);
        const preview = await publisher.preview(args.postId, []);
        return success(preview);
      }
      case 'workspace_get_subject_context': {
        const args = mcpSubjectContextArgsSchema.parse(rawArgs ?? {});
        const context = buildSubjectContext(db, args);
        if (!context) {
          return failed('Subject not found.', mcpCoordinationNotFound());
        }
        return success({
          ...context,
          ...(context.subjectType === 'project' && 'id' in context.entity
            ? { entity: withProjectTimeTotal(db, context.entity) }
            : {}),
          ...(context.parents.project
            ? {
                parents: {
                  ...context.parents,
                  project: withProjectTimeTotal(db, context.parents.project),
                },
              }
            : {}),
        });
      }
      case 'workspace_search': {
        const args = mcpWorkspaceSearchArgsSchema.parse(rawArgs ?? {});
        return success(buildWorkspaceSearch(db, args));
      }
      default:
        return failed(`Unknown workspace read tool: ${tool}.`, mcpCoordinationToolFailed());
    }
  } catch (error) {
    if (error instanceof ProjectTimeError) {
      return failed(error.message, mcpCoordinationNotFound());
    }
    if (error instanceof PublishRequestError) {
      const errorDetail =
        error.status === 404 ? mcpCoordinationNotFound() : mcpCoordinationInvalidArguments();
      return failed(error.message, errorDetail);
    }
    if (error instanceof z.ZodError) {
      const message = error.issues.map((issue) => issue.message).join(' ') || 'Invalid arguments.';
      return failed(message, mcpCoordinationInvalidArguments());
    }
    const message = error instanceof Error ? error.message : 'Workspace read tool failed.';
    return failed(message, mcpCoordinationToolFailed());
  }
}
