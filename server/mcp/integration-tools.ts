/**
 * MCP preview, import/merge commit, Files browse, and integration-write tools (C131).
 *
 * Class R reads preview and list; Class L commits share the coordination write budget; Class I
 * writes use the separate integration budget. Provider publish stays unreachable.
 */
import { z } from 'zod';
import type { Db } from '../db.ts';
import { agentHandoffClientRequestIdSchema } from '../../shared/agent-coordination.ts';
import { type ClientMergeSelections } from '../../shared/client-merge.ts';
import { DRIVE_PAGE_SIZE_MAX } from '../../shared/drive.ts';
import { INTEGRATION_EVENT_LIMIT, INTEGRATION_SOURCES } from '../../shared/integration-log.ts';
import {
  INTEGRATION_LOCAL_WRITE_TOOLS,
  INTEGRATION_READ_TOOLS,
  INTEGRATION_WRITE_TOOLS,
  type IntegrationLocalWriteTool,
  type IntegrationReadTool,
  type IntegrationWriteTool,
} from '../../shared/mcp-agent-events.ts';
import {
  mcpCoordinationAgentLabelRequired,
  mcpCoordinationInvalidArguments,
  mcpCoordinationNotFound,
  mcpCoordinationRateLimitExceeded,
  mcpCoordinationToolFailed,
  mcpCoordinationUnknownTool,
  type McpCoordinationErrorDetail,
} from '../../shared/mcp-coordination-errors.ts';
import { previewClientMerge, commitClientMerge } from '../client-merge.ts';
import { ClientMergeError } from '../domain/client-merge.ts';
import { DriveScopeError, listProjectFiles } from '../drive/browse.ts';
import {
  DriveMediaError,
  driveMediaProvider,
  resolveDriveMedia,
  type DriveMediaProvider,
} from '../drive/media.ts';
import { driveProvider, syncAllToDrive } from '../drive/service.ts';
import type { DriveProvider } from '../drive/provider.ts';
import { ImportInputError, commitPlaybook, playbookInput, previewPlaybook } from '../import.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { AnalyticsWindowService, analyticsWindowQuery } from '../publish/analytics-window.ts';
import { UnavailableAnalyticsWindowProvider } from '../publish/analytics-window-provider.ts';
import { BufferAccountsService } from '../publish/buffer-accounts.ts';
import { UnavailableBufferReadProvider } from '../publish/buffer/read-provider.ts';
import { ProviderInventoryService } from '../publish/inventory.ts';
import { UnavailableProviderInventoryProvider } from '../publish/inventory-provider.ts';
import {
  SIGNAL_IMPORT_CONTENT_BASE64_MAX,
  SIGNAL_IMPORT_TEXT_MAX,
  commitSignalImport,
  previewSignalImport,
} from '../signal/import.ts';
import {
  SignalMediaError,
  SignalPostNotFoundError,
  recheckPostMedia,
  recheckVariantMedia,
  signalVariantMediaRecheckInput,
} from '../signal/service.ts';
import type { McpToolCallResult } from './coordination.ts';
import { recordMcpAgentEvent } from './events.ts';
import { redactToolResult } from './redact.ts';
import type { McpSession } from './session.ts';
import { findWriteMutation, recordWriteMutation } from './write-mutations.ts';

export type McpIntegrationToolDeps = {
  now?: Date;
  inventory?: ProviderInventoryService;
  analyticsWindow?: AnalyticsWindowService;
  bufferAccounts?: BufferAccountsService;
  driveMedia?: DriveMediaProvider | ((db: Db) => DriveMediaProvider);
  drive?: DriveProvider | ((db: Db) => DriveProvider);
};

const READ_TOOLS = new Set<string>(INTEGRATION_READ_TOOLS);
const LOCAL_WRITE_TOOLS = new Set<string>(INTEGRATION_LOCAL_WRITE_TOOLS);
const INTEGRATION_TOOLS = new Set<string>(INTEGRATION_WRITE_TOOLS);
const ALL_TOOLS = new Set<string>([...READ_TOOLS, ...LOCAL_WRITE_TOOLS, ...INTEGRATION_TOOLS]);

const clientRequestIdField = {
  clientRequestId: agentHandoffClientRequestIdSchema,
};

const mergeFieldChoice = z.union([
  z.object({ choice: z.enum(['DESTINATION', 'SOURCE']) }),
  z.object({
    choice: z.literal('CUSTOM'),
    value: z
      .string()
      .trim()
      .transform((v) => v || null),
  }),
]);

const mergeFieldsSchema = z
  .object({
    name: mergeFieldChoice,
    contactName: mergeFieldChoice,
    email: mergeFieldChoice,
    phone: mergeFieldChoice,
    website: mergeFieldChoice,
    notes: mergeFieldChoice,
  })
  .partial()
  .default({});

const mergePreviewArgs = z
  .object({
    sourceId: z.string().uuid(),
    destinationId: z.string().uuid(),
    fields: mergeFieldsSchema,
  })
  .strict();

const mergeCommitArgs = mergePreviewArgs
  .extend({
    planHash: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]+$/i),
    ...clientRequestIdField,
  })
  .strict();

const playbookPreviewArgs = playbookInput;
const playbookCommitArgs = playbookInput.and(
  z.object({
    fingerprint: z.string().trim().max(128).optional(),
    ...clientRequestIdField,
  }),
);

const signalImportBody = z
  .object({
    filename: z.string().trim().max(255).optional(),
    contentBase64: z.string().max(SIGNAL_IMPORT_CONTENT_BASE64_MAX).optional(),
    text: z.string().max(SIGNAL_IMPORT_TEXT_MAX).optional(),
  })
  .refine((value) => Boolean(value.contentBase64) !== Boolean(value.text), {
    message: 'Provide either a workbook file or pasted Signal tabs.',
  });

const signalImportPreviewArgs = signalImportBody;
const signalImportCommitArgs = signalImportBody.and(
  z.object({
    fingerprint: z.string().trim().max(128).optional(),
    ...clientRequestIdField,
  }),
);

const resolveDriveMediaArgs = z
  .object({
    link: z.string().trim().min(1),
    ...clientRequestIdField,
  })
  .strict();

const recheckPostMediaArgs = z
  .object({
    postId: z.string().uuid(),
    driveFileId: z.string().trim().min(1),
    ...clientRequestIdField,
  })
  .strict();

const recheckVariantMediaArgs = signalVariantMediaRecheckInput
  .extend({
    postId: z.string().uuid(),
    ...clientRequestIdField,
  })
  .strict();

const clientRequestOnlyArgs = z.object(clientRequestIdField).strict();

const refreshAnalyticsArgs = analyticsWindowQuery.extend(clientRequestIdField).strict();

const filesBrowseArgs = z
  .object({
    projectId: z.string().uuid(),
    folderId: z.string().trim().min(1).optional(),
    pageToken: z.string().trim().min(1).optional(),
    pageSize: z.number().int().min(1).max(DRIVE_PAGE_SIZE_MAX).optional(),
  })
  .strict();

const integrationListArgs = z
  .object({
    source: z.enum(INTEGRATION_SOURCES).optional(),
    correlationId: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(INTEGRATION_EVENT_LIMIT).optional(),
  })
  .strict();

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

function resolveDriveMediaDep(db: Db, deps: McpIntegrationToolDeps): DriveMediaProvider {
  if (!deps.driveMedia) return driveMediaProvider(db);
  return typeof deps.driveMedia === 'function' ? deps.driveMedia(db) : deps.driveMedia;
}

function resolveDriveDep(db: Db, deps: McpIntegrationToolDeps): DriveProvider {
  if (!deps.drive) return driveProvider(db);
  return typeof deps.drive === 'function' ? deps.drive(db) : deps.drive;
}

function resolveInventory(
  db: Db,
  deps: McpIntegrationToolDeps,
  now: Date,
): ProviderInventoryService {
  return (
    deps.inventory ??
    new ProviderInventoryService(db, new UnavailableProviderInventoryProvider(), () => now)
  );
}

function resolveAnalyticsWindow(
  db: Db,
  deps: McpIntegrationToolDeps,
  now: Date,
): AnalyticsWindowService {
  return (
    deps.analyticsWindow ??
    new AnalyticsWindowService(db, new UnavailableAnalyticsWindowProvider(), () => now)
  );
}

function resolveBufferAccounts(
  db: Db,
  deps: McpIntegrationToolDeps,
  now: Date,
): BufferAccountsService {
  return (
    deps.bufferAccounts ??
    new BufferAccountsService(db, new UnavailableBufferReadProvider(), () => now)
  );
}

function mapDomainError(error: unknown): McpToolCallResult {
  if (error instanceof ClientMergeError) {
    if (error.status === 404) return failed(error.message, mcpCoordinationNotFound());
    return refused(error.message, mcpCoordinationInvalidArguments());
  }
  if (error instanceof ImportInputError || error instanceof DriveMediaError) {
    return refused(error.message, mcpCoordinationInvalidArguments());
  }
  if (error instanceof DriveScopeError) {
    return refused(error.message, mcpCoordinationInvalidArguments());
  }
  if (error instanceof SignalPostNotFoundError) {
    return failed(error.message, mcpCoordinationNotFound());
  }
  if (error instanceof SignalMediaError || error instanceof z.ZodError) {
    const message =
      error instanceof z.ZodError
        ? (error.issues[0]?.message ?? 'Invalid arguments.')
        : error.message;
    return refused(message, mcpCoordinationInvalidArguments());
  }
  if (error instanceof Error) {
    const msg = error.message;
    if (
      msg.includes('changed since it was previewed') ||
      msg.includes('preview expired') ||
      msg.includes('Review the new preview')
    ) {
      return refused(msg, mcpCoordinationInvalidArguments());
    }
  }
  return failed(
    error instanceof Error ? error.message : 'Integration tool failed.',
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
    recordEvent?: boolean;
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
  if (meta.recordEvent !== false && !READ_TOOLS.has(tool)) {
    recordMcpAgentEvent(db, {
      agentLabel: session.agentLabel,
      tool,
      outcome: result.outcome,
      summary: meta.summary,
      entityType: meta.entityType,
      entityId: meta.entityId,
    });
  }
  return result;
}

async function runWrite(
  db: Db,
  session: McpSession,
  tool: string,
  rawArgs: unknown,
  deps: McpIntegrationToolDeps,
  budget: 'coordination' | 'integration',
): Promise<McpToolCallResult> {
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
  const limiter = budget === 'integration' ? session.integrationWrites : session.coordinationWrites;
  const limitLabel = budget === 'integration' ? '6' : '10';
  if (!limiter.tryConsume(now.getTime())) {
    const retryAfterMs = limiter.retryAfterMs(now.getTime());
    return finish(
      db,
      session,
      tool,
      refused(
        `Write rate limit exceeded (${limitLabel} per rolling minute).`,
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

    const media = resolveDriveMediaDep(db, deps);
    const drive = resolveDriveDep(db, deps);

    switch (tool as IntegrationLocalWriteTool | IntegrationWriteTool) {
      case 'workspace_merge_clients_commit': {
        const args = mergeCommitArgs.parse(rawArgs ?? {});
        const data = commitClientMerge(
          db,
          args.sourceId,
          args.destinationId,
          args.fields as ClientMergeSelections,
          args.planHash,
        );
        return finish(db, session, tool, success(data), {
          entityType: 'client',
          entityId: data.destination.id,
          summary: `Merged client ${args.sourceId} into ${args.destinationId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'import_playbook_commit': {
        const args = playbookCommitArgs.parse(rawArgs ?? {});
        const { clientRequestId: _id, ...input } = args;
        void _id;
        const data = commitPlaybook(db, input);
        return finish(db, session, tool, success(data), {
          entityType: 'import_receipt',
          entityId: data.receipt.id,
          summary: `Playbook import ${data.receipt.outcome}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'import_signal_commit': {
        const args = signalImportCommitArgs.parse(rawArgs ?? {});
        const { clientRequestId: _id, ...input } = args;
        void _id;
        const data = await commitSignalImport(db, input, media);
        return finish(db, session, tool, success(data), {
          entityType: 'import_receipt',
          entityId: data.receipt.id,
          summary: `Signal import ${data.receipt.outcome}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_resolve_drive_media': {
        const args = resolveDriveMediaArgs.parse(rawArgs ?? {});
        const data = await resolveDriveMedia({ link: args.link, provider: media });
        return finish(db, session, tool, success(data), {
          entityType: 'drive_file',
          entityId: data.driveFileId,
          summary: 'Resolved Drive media metadata.',
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_recheck_post_media': {
        const args = recheckPostMediaArgs.parse(rawArgs ?? {});
        const data = await recheckPostMedia(db, args.postId, args.driveFileId, media);
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: args.postId,
          summary: `Rechecked post media ${args.driveFileId}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_recheck_variant_media': {
        const args = recheckVariantMediaArgs.parse(rawArgs ?? {});
        const data = await recheckVariantMedia(
          db,
          args.postId,
          { platform: args.platform, accountId: args.accountId, role: args.role },
          media,
        );
        return finish(db, session, tool, success(data), {
          entityType: 'signal_post',
          entityId: args.postId,
          summary: `Rechecked variant ${args.role} media.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'drive_sync': {
        clientRequestOnlyArgs.parse(rawArgs ?? {});
        const data = await syncAllToDrive(db, drive);
        return finish(db, session, tool, success(data), {
          summary: data.message,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_refresh_provider_inventory': {
        clientRequestOnlyArgs.parse(rawArgs ?? {});
        const inventory = resolveInventory(db, deps, now);
        const priorEntries = inventory.read().entries;
        const data = await inventory.refresh();
        return finish(db, session, tool, success(data), {
          summary: data.reason
            ? `Provider inventory refresh did not replace: ${data.reason}`
            : `Refreshed provider inventory (${data.entries.length} posts; prior generation had ${priorEntries.length}).`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_refresh_analytics_window': {
        const args = refreshAnalyticsArgs.parse(rawArgs ?? {});
        const analyticsWindow = resolveAnalyticsWindow(db, deps, now);
        const data = await analyticsWindow.refresh(args.platform, args.timeframe);
        return finish(db, session, tool, success(data), {
          summary: data.reason
            ? `Analytics window refresh did not replace: ${data.reason}`
            : `Refreshed analytics window ${args.platform}/${args.timeframe}.`,
          clientRequestId,
          persistIdempotency: true,
        });
      }
      case 'signal_refresh_buffer_accounts': {
        clientRequestOnlyArgs.parse(rawArgs ?? {});
        const bufferAccounts = resolveBufferAccounts(db, deps, now);
        const data = await bufferAccounts.refresh();
        return finish(db, session, tool, success(data), {
          summary: data.reason
            ? `Buffer accounts refresh did not replace: ${data.reason}`
            : 'Refreshed Buffer accounts.',
          clientRequestId,
          persistIdempotency: true,
        });
      }
      default:
        return finish(
          db,
          session,
          tool,
          failed(`Unknown integration write tool: ${tool}.`, mcpCoordinationUnknownTool()),
          { summary: `Unknown tool ${tool}.` },
        );
    }
  } catch (error) {
    return finish(db, session, tool, mapDomainError(error), {
      summary: error instanceof Error ? error.message.slice(0, 200) : 'Integration write failed.',
    });
  }
}

async function runRead(
  db: Db,
  tool: string,
  rawArgs: unknown,
  deps: McpIntegrationToolDeps,
): Promise<McpToolCallResult> {
  try {
    const media = resolveDriveMediaDep(db, deps);
    const drive = resolveDriveDep(db, deps);

    switch (tool as IntegrationReadTool) {
      case 'workspace_merge_clients_preview': {
        const args = mergePreviewArgs.parse(rawArgs ?? {});
        return success(
          previewClientMerge(
            db,
            args.sourceId,
            args.destinationId,
            args.fields as ClientMergeSelections,
          ),
        );
      }
      case 'import_playbook_preview': {
        const args = playbookPreviewArgs.parse(rawArgs ?? {});
        return success(previewPlaybook(db, args));
      }
      case 'import_signal_preview': {
        const args = signalImportPreviewArgs.parse(rawArgs ?? {});
        return success(await previewSignalImport(db, args, media));
      }
      case 'files_browse_project': {
        const args = filesBrowseArgs.parse(rawArgs ?? {});
        const listing = await listProjectFiles(db, args.projectId, {
          folderId: args.folderId,
          pageToken: args.pageToken,
          pageSize: args.pageSize,
          provider: drive,
        });
        if (!listing) {
          return failed('Project not found.', mcpCoordinationNotFound());
        }
        return success(listing);
      }
      case 'integration_list_activity': {
        const args = integrationListArgs.parse(rawArgs ?? {});
        return success(listIntegrationEvents(db, args));
      }
      default:
        return failed(`Unknown integration read tool: ${tool}.`, mcpCoordinationUnknownTool());
    }
  } catch (error) {
    return mapDomainError(error);
  }
}

export async function callIntegrationTool(
  db: Db,
  session: McpSession,
  tool: string,
  rawArgs: unknown,
  deps: McpIntegrationToolDeps = {},
): Promise<McpToolCallResult> {
  if (!ALL_TOOLS.has(tool)) {
    return finish(
      db,
      session,
      tool,
      failed(`Unknown integration tool: ${tool}.`, mcpCoordinationUnknownTool()),
      { summary: `Unknown tool ${tool}.`, recordEvent: true },
    );
  }

  if (READ_TOOLS.has(tool)) {
    return runRead(db, tool, rawArgs, deps);
  }

  if (LOCAL_WRITE_TOOLS.has(tool)) {
    return runWrite(db, session, tool, rawArgs, deps, 'coordination');
  }

  return runWrite(db, session, tool, rawArgs, deps, 'integration');
}
