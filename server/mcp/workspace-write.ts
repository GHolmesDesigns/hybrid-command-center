/**
 * MCP Class-L workspace and Signal planning writes (C130).
 *
 * Each tool maps to one existing writer or Signal service method. Drive resolve and provider
 * network stay out of this path. Mutations share the session write budget with coordination.
 */
import { z } from 'zod';
import type { Db } from '../db.ts';
import { agentHandoffClientRequestIdSchema } from '../../shared/agent-coordination.ts';
import {
  mcpCoordinationAgentLabelRequired,
  mcpCoordinationInvalidArguments,
  mcpCoordinationNotFound,
  mcpCoordinationRateLimitExceeded,
  mcpCoordinationToolFailed,
  mcpCoordinationUnknownTool,
  mcpWorkspaceConfirmationRequired,
  mcpWorkspaceRevisionConflict,
  type McpCoordinationErrorDetail,
} from '../../shared/mcp-coordination-errors.ts';
import { WORKSPACE_WRITE_TOOLS, type WorkspaceWriteTool } from '../../shared/mcp-agent-events.ts';
import { revisionPrecondition, RevisionConflictError } from '../domain/revisions.ts';
import { DisconnectedDriveMediaProvider } from '../drive/media.ts';
import {
  SignalPostNotFoundError,
  SignalPostRelationshipError,
  SignalPublishTargetError,
  SignalSlotConflictError,
  SignalVariantError,
  SignalMediaError,
  applyPostSlotWithRevision,
  createPost,
  duplicatePost,
  getPost,
  getPostPublishTargets,
  getPostVariants,
  replacePostPublishTargets,
  replacePostVariants,
  signalPostInput,
  signalPostPatch,
  signalPublishTargetsInput,
  signalSlotInput,
  signalVariantsInput,
  updatePostWithRevision,
} from '../signal/service.ts';
import { QueueAlertNotFoundError, acknowledgeQueueAlert } from '../signal/queue-health.ts';
import { getTask } from '../repositories.ts';
import {
  brandingInput,
  checklistAddInput,
  checklistUpdateInput,
  dependencyAddInput,
  projectInput,
  projectPatch,
  taskInput,
  taskUpdateInput,
  viewDefaultsInput,
} from '../workspace/schemas.ts';
import {
  addChecklistItem,
  addDependency,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getProjectById,
  readBranding,
  readViewDefaults,
  removeChecklistItem,
  removeDependency,
  updateBranding,
  updateChecklistItem,
  updateProject,
  updateTask,
  updateViewDefaults,
  WorkspaceConflictError,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
} from '../workspace/writes.ts';
import type { McpToolCallResult } from './coordination.ts';
import { recordMcpAgentEvent } from './events.ts';
import { redactToolResult } from './redact.ts';
import type { McpSession } from './session.ts';
import { findWriteMutation, recordWriteMutation } from './write-mutations.ts';

export type McpWorkspaceWriteDeps = {
  now?: Date;
  /** Override connected accounts for publish-target writes (tests). Default: local SQLite rows. */
  connectedAccounts?: () => Promise<readonly { id: number; platform: string }[]>;
};

const WRITE_TOOLS = new Set<string>(WORKSPACE_WRITE_TOOLS);

const clientRequestIdField = {
  clientRequestId: agentHandoffClientRequestIdSchema,
};

const requireConfirm = (confirm: boolean | undefined, typedId: string, expectedId: string) => {
  if (confirm !== true || typedId !== expectedId) {
    return refused(
      'Destructive writes require confirm: true and a matching entity id.',
      mcpWorkspaceConfirmationRequired(),
    );
  }
  return null;
};

const refused = (
  error: string,
  errorDetail: McpCoordinationErrorDetail,
  retryAfterMs?: number,
): McpToolCallResult => ({
  outcome: 'REFUSED',
  error,
  errorDetail,
  ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
});

const failed = (error: string, errorDetail: McpCoordinationErrorDetail): McpToolCallResult => ({
  outcome: 'FAILURE',
  error,
  errorDetail,
});

const success = (data: unknown): McpToolCallResult => ({
  outcome: 'SUCCESS',
  data: redactToolResult(data),
});

function localConnectedAccounts(db: Db): { id: number; platform: string }[] {
  return db.prepare('SELECT id, platform FROM signal_provider_accounts').all() as {
    id: number;
    platform: string;
  }[];
}

/** Class-L only reads already-resolved local accounts — never a provider refresh. */
function defaultConnectedAccounts(db: Db) {
  return localConnectedAccounts(db);
}

function mapDomainError(error: unknown): McpToolCallResult {
  if (error instanceof RevisionConflictError) {
    return refused(
      error.message,
      mcpWorkspaceRevisionConflict(error.currentRevision, error.changedFields),
    );
  }
  if (error instanceof WorkspaceNotFoundError || error instanceof SignalPostNotFoundError) {
    return failed(error.message, mcpCoordinationNotFound());
  }
  if (error instanceof QueueAlertNotFoundError) {
    return failed('Queue alert not found.', mcpCoordinationNotFound());
  }
  if (
    error instanceof WorkspaceValidationError ||
    error instanceof SignalPostRelationshipError ||
    error instanceof SignalVariantError ||
    error instanceof SignalPublishTargetError ||
    error instanceof SignalMediaError ||
    error instanceof z.ZodError
  ) {
    const message =
      error instanceof z.ZodError
        ? (error.issues[0]?.message ?? 'Invalid arguments.')
        : error.message;
    return refused(message, mcpCoordinationInvalidArguments());
  }
  if (error instanceof WorkspaceConflictError || error instanceof SignalSlotConflictError) {
    return refused(error.message, {
      code: 'COORDINATION_INVALID_STATE',
      retryable: false,
      requiredAction: 'Read the entity again and choose a valid write.',
    });
  }
  return failed(
    error instanceof Error ? error.message : 'Workspace write failed.',
    mcpCoordinationToolFailed(),
  );
}

function finish(
  db: Db,
  session: McpSession,
  tool: string,
  result: McpToolCallResult,
  meta: {
    entityType?: string | null;
    entityId?: string | null;
    summary: string;
    clientRequestId?: string;
    persistIdempotency?: boolean;
  },
): McpToolCallResult {
  if (
    result.outcome === 'SUCCESS' &&
    meta.persistIdempotency &&
    meta.clientRequestId &&
    session.agentLabel
  ) {
    recordWriteMutation(db, {
      agentLabel: session.agentLabel,
      clientRequestId: meta.clientRequestId,
      tool,
      entityType: meta.entityType ?? null,
      entityId: meta.entityId ?? null,
      result: result.data,
    });
  }
  recordMcpAgentEvent(db, {
    agentLabel: session.agentLabel,
    tool,
    outcome: result.outcome,
    summary: meta.summary,
    entityType: meta.entityType,
    entityId: meta.entityId,
  });
  return result;
}

function mutationSummary(
  before: unknown,
  after: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { before, after, ...extra };
}

export async function callWorkspaceWriteTool(
  db: Db,
  session: McpSession,
  tool: string,
  rawArgs: unknown,
  deps: McpWorkspaceWriteDeps = {},
): Promise<McpToolCallResult> {
  if (!WRITE_TOOLS.has(tool)) {
    return finish(
      db,
      session,
      tool,
      failed(`Unknown workspace write tool: ${tool}.`, mcpCoordinationUnknownTool()),
      {
        summary: `Unknown tool ${tool}.`,
      },
    );
  }

  if (!session.agentLabel) {
    return finish(
      db,
      session,
      tool,
      refused(
        'Workspace writes require a non-empty agent_label in MCP initialization (or MCP_AGENT_LABEL).',
        mcpCoordinationAgentLabelRequired(),
      ),
      { summary: 'Refused: missing agent_label.' },
    );
  }

  const now = deps.now ?? new Date();
  if (!session.coordinationWrites.tryConsume(now.getTime())) {
    const retryAfterMs = session.coordinationWrites.retryAfterMs(now.getTime());
    return finish(
      db,
      session,
      tool,
      refused(
        'Write rate limit exceeded (10 per rolling minute).',
        mcpCoordinationRateLimitExceeded(retryAfterMs),
        retryAfterMs,
      ),
      { summary: 'Refused: rate limit.' },
    );
  }

  try {
    const argsRecord =
      rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
    const clientRequestId = agentHandoffClientRequestIdSchema.parse(argsRecord.clientRequestId);
    const prior = findWriteMutation(db, session.agentLabel, clientRequestId, tool);
    if (prior) {
      return finish(db, session, tool, success(prior.result), {
        entityType: prior.entityType,
        entityId: prior.entityId,
        summary: `Idempotent replay of ${tool}.`,
      });
    }

    const drive = new DisconnectedDriveMediaProvider();
    const connectedAccounts = deps.connectedAccounts ?? (async () => defaultConnectedAccounts(db));

    switch (tool as WorkspaceWriteTool) {
      case 'workspace_create_task': {
        const args = taskInput
          .extend(clientRequestIdField)
          .strict()
          .parse(rawArgs ?? {});
        const after = createTask(db, args);
        const data = mutationSummary(null, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Created task ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_update_task': {
        const args = taskUpdateInput
          .extend({
            ...clientRequestIdField,
            taskId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = db.prepare('SELECT id FROM tasks WHERE id=?').get(args.taskId);
        if (!before)
          return finish(db, session, tool, failed('Task not found.', mcpCoordinationNotFound()), {
            summary: 'Task not found.',
          });
        const priorTask = getTask(db, args.taskId);
        const { taskId, revision, clientRequestId: _c, ...patch } = args;
        void _c;
        const after = updateTask(db, taskId, patch, revision);
        const data = mutationSummary(priorTask, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Updated task ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_add_checklist_item': {
        const args = checklistAddInput
          .extend({
            ...clientRequestIdField,
            taskId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getTask(db, args.taskId);
        if (!before)
          return finish(db, session, tool, failed('Task not found.', mcpCoordinationNotFound()), {
            summary: 'Task not found.',
          });
        const after = addChecklistItem(db, args.taskId, args.text, args.revision);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Added checklist item on task ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_update_checklist_item': {
        const args = checklistUpdateInput
          .extend({
            ...clientRequestIdField,
            itemId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const row = db
          .prepare('SELECT task_id FROM checklist_items WHERE id=?')
          .get(args.itemId) as { task_id: string } | undefined;
        if (!row)
          return finish(
            db,
            session,
            tool,
            failed('Checklist item not found.', mcpCoordinationNotFound()),
            { summary: 'Checklist item not found.' },
          );
        const before = getTask(db, row.task_id);
        const after = updateChecklistItem(
          db,
          args.itemId,
          { text: args.text, completed: args.completed, position: args.position },
          args.revision,
        );
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Updated checklist item ${args.itemId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_remove_checklist_item': {
        const args = z
          .object({
            ...clientRequestIdField,
            itemId: z.string().uuid(),
            confirm: z.boolean(),
            confirmItemId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const gate = requireConfirm(args.confirm, args.confirmItemId, args.itemId);
        if (gate)
          return finish(db, session, tool, gate, { summary: 'Refused: confirmation required.' });
        const row = db
          .prepare('SELECT task_id FROM checklist_items WHERE id=?')
          .get(args.itemId) as { task_id: string } | undefined;
        if (!row)
          return finish(
            db,
            session,
            tool,
            failed('Checklist item not found.', mcpCoordinationNotFound()),
            { summary: 'Checklist item not found.' },
          );
        const before = getTask(db, row.task_id);
        const after = removeChecklistItem(db, args.itemId, args.revision);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Removed checklist item ${args.itemId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_add_dependency': {
        const args = dependencyAddInput
          .extend({
            ...clientRequestIdField,
            taskId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getTask(db, args.taskId);
        if (!before)
          return finish(db, session, tool, failed('Task not found.', mcpCoordinationNotFound()), {
            summary: 'Task not found.',
          });
        const after = addDependency(db, args.taskId, args.dependencyId, args.revision);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Added dependency on task ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_remove_dependency': {
        const args = z
          .object({
            ...clientRequestIdField,
            taskId: z.string().uuid(),
            dependencyId: z.string().uuid(),
            confirm: z.boolean(),
            confirmTaskId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const gate = requireConfirm(args.confirm, args.confirmTaskId, args.taskId);
        if (gate)
          return finish(db, session, tool, gate, { summary: 'Refused: confirmation required.' });
        const before = getTask(db, args.taskId);
        if (!before)
          return finish(db, session, tool, failed('Task not found.', mcpCoordinationNotFound()), {
            summary: 'Task not found.',
          });
        const after = removeDependency(db, args.taskId, args.dependencyId, args.revision);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: after.id,
          summary: `Removed dependency on task ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_create_project': {
        const args = projectInput
          .extend(clientRequestIdField)
          .strict()
          .parse(rawArgs ?? {});
        const after = createProject(db, args);
        const data = mutationSummary(null, after);
        return finish(db, session, tool, success(data), {
          entityType: 'project',
          entityId: after.id,
          summary: `Created project ${after.id} (Drive not provisioned).`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_update_project': {
        const args = projectPatch
          .extend({
            ...clientRequestIdField,
            projectId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getProjectById(db, args.projectId);
        if (!before)
          return finish(
            db,
            session,
            tool,
            failed('Project not found.', mcpCoordinationNotFound()),
            { summary: 'Project not found.' },
          );
        const { projectId, revision, clientRequestId: _c, ...patch } = args;
        void _c;
        const after = updateProject(db, projectId, patch, revision);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'project',
          entityId: after.id,
          summary: `Updated project ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_delete_task': {
        const args = z
          .object({
            ...clientRequestIdField,
            taskId: z.string().uuid(),
            confirm: z.boolean(),
            confirmTaskId: z.string().uuid(),
          })
          .strict()
          .parse(rawArgs ?? {});
        const gate = requireConfirm(args.confirm, args.confirmTaskId, args.taskId);
        if (gate)
          return finish(db, session, tool, gate, { summary: 'Refused: confirmation required.' });
        const before = getTask(db, args.taskId);
        const after = deleteTask(db, args.taskId);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'task',
          entityId: args.taskId,
          summary: `Deleted task ${args.taskId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'workspace_delete_project': {
        const args = z
          .object({
            ...clientRequestIdField,
            projectId: z.string().uuid(),
            confirm: z.boolean(),
            confirmProjectId: z.string().uuid(),
          })
          .strict()
          .parse(rawArgs ?? {});
        const gate = requireConfirm(args.confirm, args.confirmProjectId, args.projectId);
        if (gate)
          return finish(db, session, tool, gate, { summary: 'Refused: confirmation required.' });
        const before = getProjectById(db, args.projectId);
        const after = deleteProject(db, args.projectId);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'project',
          entityId: args.projectId,
          summary: `Deleted project ${args.projectId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_create_post': {
        const args = signalPostInput
          .extend(clientRequestIdField)
          .strict()
          .parse(rawArgs ?? {});
        const { clientRequestId: _c, ...input } = args;
        void _c;
        const after = await createPost(db, input, drive);
        const data = mutationSummary(null, after);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: after.id,
          summary: `Created Signal post ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_update_post': {
        const args = signalPostPatch
          .extend({
            ...clientRequestIdField,
            postId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getPost(db, args.postId);
        if (!before)
          return finish(
            db,
            session,
            tool,
            failed('Signal post not found.', mcpCoordinationNotFound()),
            { summary: 'Signal post not found.' },
          );
        const { postId, revision, clientRequestId: _c, ...patch } = args;
        void _c;
        const after = await updatePostWithRevision(db, postId, patch, revision, drive);
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: after.id,
          summary: `Updated Signal post ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_set_slot': {
        const args = signalSlotInput
          .extend({
            ...clientRequestIdField,
            postId: z.string().uuid(),
            revision: revisionPrecondition,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getPost(db, args.postId);
        if (!before)
          return finish(
            db,
            session,
            tool,
            failed('Signal post not found.', mcpCoordinationNotFound()),
            { summary: 'Signal post not found.' },
          );
        const after = applyPostSlotWithRevision(
          db,
          args.postId,
          { date: args.date, time: args.time, from: args.from },
          args.revision,
        );
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: after.id,
          summary: `Set slot on Signal post ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_update_variants': {
        const args = signalVariantsInput
          .extend({
            ...clientRequestIdField,
            postId: z.string().uuid(),
            revision: revisionPrecondition,
            dryRun: z.boolean().optional(),
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getPostVariants(db, args.postId);
        if (args.dryRun) {
          const data = mutationSummary(before, before, { dryRun: true, planned: args.variants });
          return finish(db, session, tool, success(data), {
            entityType: 'signal_post',
            entityId: args.postId,
            summary: `Dry-run variants for Signal post ${args.postId}.`,
          });
        }
        const after = await replacePostVariants(
          db,
          args.postId,
          { variants: args.variants },
          drive,
          new Set(),
          args.revision,
        );
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: args.postId,
          summary: `Updated variants on Signal post ${args.postId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_update_publish_targets': {
        const args = signalPublishTargetsInput
          .extend({
            ...clientRequestIdField,
            postId: z.string().uuid(),
            revision: revisionPrecondition,
            dryRun: z.boolean().optional(),
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = getPostPublishTargets(db, args.postId);
        const connected = await connectedAccounts();
        if (args.dryRun) {
          const data = mutationSummary(before, before, {
            dryRun: true,
            planned: args.targets,
            connectedAccountIds: connected.map((a) => a.id),
          });
          return finish(db, session, tool, success(data), {
            entityType: 'signal_post',
            entityId: args.postId,
            summary: `Dry-run publish targets for Signal post ${args.postId}.`,
          });
        }
        const after = replacePostPublishTargets(
          db,
          args.postId,
          { targets: args.targets },
          connected,
          () => now,
          args.revision,
        );
        const data = mutationSummary(before, after);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: args.postId,
          summary: `Updated publish targets on Signal post ${args.postId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_duplicate_post': {
        const args = z
          .object({
            ...clientRequestIdField,
            postId: z.string().uuid(),
          })
          .strict()
          .parse(rawArgs ?? {});
        const after = duplicatePost(db, args.postId);
        const data = mutationSummary(null, after);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: after.id,
          summary: `Duplicated Signal post ${args.postId} → ${after.id}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_ack_alert': {
        const args = z
          .object({
            ...clientRequestIdField,
            alertId: z.string().trim().min(1).max(200),
          })
          .strict()
          .parse(rawArgs ?? {});
        const after = acknowledgeQueueAlert(db, args.alertId, now);
        const data = mutationSummary(null, after);
        return finish(db, session, tool, success(data), {
          entityType: 'queue_alert',
          entityId: args.alertId,
          summary: `Acknowledged queue alert ${args.alertId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'settings_update_branding': {
        const request = z
          .object({ clientRequestId: agentHandoffClientRequestIdSchema })
          .passthrough()
          .parse(rawArgs ?? {});
        const branding = brandingInput.parse(rawArgs ?? {});
        const before = readBranding(db);
        const after = updateBranding(db, branding);
        const data = mutationSummary(before, after.branding);
        return finish(db, session, tool, success(data), {
          entityType: 'settings',
          entityId: 'branding',
          summary: 'Updated branding settings.',
          clientRequestId: request.clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'settings_update_view_defaults': {
        const args = z
          .object({
            ...clientRequestIdField,
            viewDefaults: viewDefaultsInput,
          })
          .strict()
          .parse(rawArgs ?? {});
        const before = readViewDefaults(db);
        const after = updateViewDefaults(db, args.viewDefaults);
        const data = mutationSummary(before, after.viewDefaults);
        return finish(db, session, tool, success(data), {
          entityType: 'settings',
          entityId: 'view_defaults',
          summary: 'Updated view defaults.',
          clientRequestId,
          persistIdempotency: true,
        });
      }
    }
  } catch (error) {
    const mapped = mapDomainError(error);
    return finish(db, session, tool, mapped, {
      summary: mapped.error ?? 'Workspace write refused.',
    });
  }
}

export function isWorkspaceWriteTool(name: string): name is WorkspaceWriteTool {
  return WRITE_TOOLS.has(name);
}
