import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp, { stdSerializers } from 'pino-http';
import type { DestinationStream } from 'pino';
import { z } from 'zod';
import type { Db } from './db.ts';
import { getDb, getStoreId, transaction } from './db.ts';
import { config, publishConfigured, bufferConfigured, authenticationConfigured } from './config.ts';
import { createAuthMiddleware, type AuthedRequest } from './auth/middleware.ts';
import {
  authStatus,
  changePassword,
  login as operatorLogin,
  logout as operatorLogout,
} from './auth/service.ts';
import { buildSessionCookie, clearSessionCookie } from './auth/cookies.ts';
import { clientAddress, type AddressRequest } from './auth/client-address.ts';
import { purgeExpiredSessions } from './auth/sessions.ts';
import { createMcpBearer } from './auth/mcp-bearers.ts';
import {
  createMcpAgentCredential,
  getMcpAgentCredential,
  listMcpAgentCredentials,
  McpAgentLabelTakenError,
  renameMcpAgentRegistration,
  revokeMcpAgentCredential,
  rotateMcpAgentCredential,
} from './auth/mcp-agent-credentials.ts';
import { MCP_BEARER_ISSUE_PATH, MCP_HTTP_PATH } from '../shared/mcp-network.ts';
import {
  createMcpAgentCredentialSchema,
  updateMcpAgentRegistrationSchema,
} from '../shared/mcp-agent-registry.ts';
import { createMcpHttpHandler, McpHttpSessionRegistry } from './mcp/http.ts';
import { createMcpOAuthRouter, MCP_OAUTH_AUTHORIZE_PAGE_STYLE_HASH } from './mcp/oauth-routes.ts';
import { MCP_OAUTH_ALLOWED_REDIRECT_URIS } from '../shared/mcp-oauth.ts';
import { setMcpResourceUpdateBridge } from './mcp/resource-notifier.ts';
import { buildMcpHealthPanel } from './mcp/health-panel.ts';
import { buildConnectionStatus } from './mcp/connection-status.ts';
import { workspaceDataChecksum } from './mcp/workspace-checksum.ts';
import { buildAppHealth } from './app-health.ts';
import { MCP_AGENT_SCOPES } from '../shared/mcp-agent-registry.ts';
import {
  mcpHealthDiagnosticCredentialSchema,
  mcpHealthTestInputSchema,
  type McpCredentialVerification,
} from '../shared/mcp-health.ts';
import { McpWriteLimiterRegistry } from './mcp/write-limiter-registry.ts';
import { INTEGRATION_WRITE_LIMIT_PER_MINUTE } from '../shared/mcp-agent-events.ts';
import { DRIVE_OAUTH_SCOPE } from '../shared/drive-oauth.ts';
import {
  getCategory,
  getTag,
  getTask,
  listCategories,
  listClients,
  listProjects,
  listTags,
  listTasksFiltered,
} from './repositories.ts';
import { listTaskPresets, saveTaskPreset, deleteTaskPreset } from './task-presets.ts';
import { taskFiltersFromQuery, taskPresetInputSchema } from '../shared/task-filters.ts';
import { commitClientMerge, isMergedSource, previewClientMerge } from './client-merge.ts';
import { ClientMergeError } from './domain/client-merge.ts';
import { touchProjectActivity, touchProjectRecord } from './domain/activity.ts';
import { buildDashboardSummary } from './domain/dashboard.ts';
import { buildClientSlug } from './domain/client-slugs.ts';
import {
  advanceRevision,
  requireRevision,
  revisionPrecondition,
  RevisionConflictError,
} from './domain/revisions.ts';
import {
  driveProvider,
  driveWriteProvider,
  getSetting,
  provisionClient,
  provisionProject,
  setSetting,
  syncAllToDrive,
} from './drive/service.ts';
import {
  DriveScopeError,
  driveConfigured,
  drivePickerConfigured,
  listProjectFiles,
} from './drive/browse.ts';
import {
  DriveMediaError,
  driveMediaProvider,
  resolveDriveMedia,
  type DriveMediaProvider,
} from './drive/media.ts';
import { resolveDriveMediaBatch } from './drive/media-batch.ts';
import {
  commitDriveWrite,
  DriveWriteConfirmationError,
  previewDriveFolderCreate,
  previewDriveUpload,
  driveWritePlanSchema,
  type DriveWriteProvider,
} from './drive/write.ts';
import {
  decideDriveWrite,
  listDriveWriteRequests,
  summarizeDriveWriteRequests,
} from './drive/agent-write.ts';
import {
  SignalMediaError,
  SignalPostNotFoundError,
  SignalPostRelationshipError,
  SignalPostProtectedError,
  SignalPublishTargetError,
  SignalVariantError,
  SignalSlotConflictError,
  applyPostSlotWithRevision,
  createPost,
  deletePost,
  duplicatePost,
  getPost,
  getPostPublishTargets,
  getPostVariants,
  listQueue,
  recheckPostMedia,
  recheckVariantMedia,
  replacePostPublishTargets,
  replacePostVariants,
  retirePost,
  signalPostFiltersFromQuery,
  signalPostInput,
  signalPostPatch,
  signalQueueQuery,
  signalRangeQuery,
  signalVariantMediaRecheckInput,
  signalPublishTargetsInput,
  signalVariantsInput,
  signalSlotFromQuery,
  signalSlotInput,
  suggestPostSlot,
  updatePostWithRevision,
} from './signal/service.ts';
import { listPostsInRange, signalProvider } from './signal/read.ts';
import { readCalendarRange } from './calendar.ts';
import {
  QueueAlertNotFoundError,
  acknowledgeQueueAlert,
  queueHealthConfigInput,
  readQueueHealth,
  restoreQueueAlert,
  writeQueueHealthConfig,
} from './signal/queue-health.ts';
import { readCardDeliveries } from './signal/card-delivery.ts';
import {
  SignalCampaignInUseError,
  SignalCampaignNameTakenError,
  SignalCampaignNotFoundError,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  signalCampaignInput,
  signalCampaignPatch,
  updateCampaign,
} from './signal/campaigns.ts';
import {
  readSignalCampaignAnalytics,
  signalCampaignAnalyticsQuery,
} from './publish/campaign-analytics.ts';
import type { DriveProvider } from './drive/provider.ts';
import type { PublishProvider } from './publish/provider.ts';
import { UnavailablePublishProvider } from './publish/provider.ts';
import {
  PostBridgeAnalyticsProvider,
  PostBridgeInventoryProvider,
  PostBridgeAnalyticsWindowProvider,
  PostBridgeProvider,
} from './publish/post-bridge.ts';
import { PublishAnalyticsService } from './publish/analytics.ts';
import {
  UnavailableAnalyticsProvider,
  type AnalyticsProvider,
} from './publish/analytics-provider.ts';
import { ProviderInventoryService } from './publish/inventory.ts';
import { AnalyticsWindowService, analyticsWindowQuery } from './publish/analytics-window.ts';
import {
  UnavailableAnalyticsWindowProvider,
  type AnalyticsWindowProvider,
} from './publish/analytics-window-provider.ts';
import type { AnalyticsWindow } from '../shared/publish-analytics-window.ts';
import {
  UnavailableProviderInventoryProvider,
  type ProviderInventoryProvider,
} from './publish/inventory-provider.ts';
import { PublishRequestError, PublishService } from './publish/service.ts';
import { BufferAccountsService } from './publish/buffer-accounts.ts';
import { BufferReadClient } from './publish/buffer/client.ts';
import { BufferWriteClient } from './publish/buffer/write-client.ts';
import type { BufferWriteProvider } from './publish/buffer/write-provider.ts';
import { UnavailableBufferWriteProvider } from './publish/buffer/write-provider.ts';
import { BUFFER_WRITE_EVIDENCE } from '../shared/buffer.ts';
import {
  UnavailableBufferReadProvider,
  type BufferReadProvider,
} from './publish/buffer/read-provider.ts';
import { resolvePublishingTargets } from './publish/targets.ts';
import { PROVIDER_ACTIONS } from '../shared/publish.ts';
import {
  OAuthStateError,
  beginAuthorization,
  consumeAuthorization,
  createGoogleOAuthClient,
  purgeExpiredAuthorizations,
  type OAuthAuthorizationClient,
  type OAuthCredentials,
} from './drive/oauth.ts';
import { encryptJson } from './drive/tokens.ts';
import { DRIVE_PAGE_SIZE, DRIVE_PAGE_SIZE_MAX } from '../shared/drive.ts';
import {
  IMPORT_BODY_LIMIT_BYTES,
  ImportInputError,
  SAMPLE_PLAYBOOK_CONTENT_TYPE,
  SAMPLE_PLAYBOOK_DIRECTORY,
  commitPlaybook,
  getReceipt,
  listReceipts,
  playbookInput,
  previewPlaybook,
} from './import.ts';
import {
  SIGNAL_IMPORT_CONTENT_BASE64_MAX,
  SIGNAL_IMPORT_TEXT_MAX,
  SAMPLE_SIGNAL_DIRECTORY,
  commitSignalImport,
  listSignalImportReceipts,
  previewSignalImport,
} from './signal/import.ts';
import {
  AUTH_LOGIN_BUDGET,
  AUTH_ROUTE_BUDGET,
  DRIVE_BUDGET,
  DRIVE_OAUTH_BUDGET,
  DRIVE_SYNC_BUDGET,
  MCP_HEALTH_BUDGET,
  HEALTH_DASHBOARD_BUDGET,
  MANUAL_BUDGET,
  MCP_OAUTH_BUDGET,
  IMPORT_BUDGET,
  IMPORT_BUSY_MESSAGE,
  IMPORT_CONCURRENCY,
  SAMPLE_PLAYBOOK_BUDGET,
  SAMPLE_SIGNAL_BUDGET,
  concurrencyGate,
  postsOnly,
  requestBudget,
} from './budgets.ts';
import { rateLimit } from 'express-rate-limit';
import { SAMPLE_PLAYBOOK_DOWNLOAD_PATH, SAMPLE_PLAYBOOK_FILENAME } from '../shared/playbook.ts';
import { SAMPLE_SIGNAL_DOWNLOAD_PATH, SAMPLE_SIGNAL_FILENAME } from '../shared/signal-import.ts';
import { MANUAL_FILENAME, MANUAL_ROUTE, manualUrlForVersion } from '../shared/manual.ts';
import { listIntegrationEvents } from './integration-log.ts';
import {
  APP_VERSION,
  brandingInput,
  projectInput,
  projectPatch,
  taskInput,
  taskPatch,
  viewDefaultsInput,
} from './workspace/schemas.ts';
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
} from './workspace/writes.ts';
import {
  AGENT_HANDOFF_LIST_MAX_LIMIT,
  AGENT_HANDOFF_STATES,
  agentHandoffCancelInputSchema,
  agentHandoffPostInputSchema,
} from '../shared/agent-coordination.ts';
import { AgentCoordinationError } from './domain/agent-coordination.ts';
import {
  cancelHandoffAsOperator,
  getHandoff,
  listHandoffs,
  postHandoff,
} from './agent-coordination/service.ts';
import { reclaimableWorkSessions, reclaimWorkSession } from './agent-coordination/work-sessions.ts';
import { listAgentDirectory } from './agent-directory.ts';
import {
  archiveMemory,
  correctMemory,
  deleteMemory,
  getMemory,
  listMemory,
  suggestMemory,
} from './agent-memory.ts';
import { agentMemoryListSchema } from '../shared/agent-memory.ts';
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  postMessage,
  setConversationState,
} from './agent-conversations.ts';
import {
  conversationListSchema,
  messageListSchema,
  createConversationSchema,
} from '../shared/agent-conversations.ts';
import { INTEGRATION_EVENT_PAGE_MAX, INTEGRATION_SOURCES } from '../shared/integration-log.ts';
import { clientBrandingIssues } from '../shared/branding.ts';
import { normalizeHex } from '../shared/contrast.ts';
import { normalizeCategoryName, normalizeTagName } from '../shared/types.ts';
import {
  getPresence,
  listNotifications,
  listPresence,
  listSummaries,
  markNotificationRead,
  notify,
  setPresence,
} from './agent-summaries.ts';

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
/**
 * What a 500 says, in place of the internal message. Exported so the test asserts the same
 * string the handler sends rather than a copy of it.
 */
export const SERVER_ERROR_MESSAGE = 'Something went wrong on the server.';
const isProductionRuntime = () =>
  process.env.NODE_ENV === 'production' || process.argv.includes('--production');

const productionContentSecurityPolicy = {
  directives: {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    // GIS token client and Picker talk to Google from the browser; stored refresh tokens never do.
    connectSrc: ["'self'", 'https://accounts.google.com', 'https://www.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    formAction: ["'self'", ...MCP_OAUTH_ALLOWED_REDIRECT_URIS.map((uri) => new URL(uri).origin)],
    frameAncestors: ["'none'"],
    // Google Picker opens in an iframe on docs.google.com / drive.google.com.
    frameSrc: [
      'https://docs.google.com',
      'https://drive.google.com',
      'https://accounts.google.com',
    ],
    // `https:` is what makes a Settings-supplied logo load. Branding references a logo by
    // address rather than storing an uploaded file (README, "Sidebar branding"), so the
    // policy has to permit the host the user names, and the host is not known in advance.
    // Only images widen: no other directive accepts a remote origin for arbitrary hosts.
    imgSrc: ["'self'", 'data:', 'https:'],
    manifestSrc: ["'self'"],
    // Media widens for the same reason images do, and for one screen: the publishing preview
    // renders the video a post already references, from the public URL the post carries, so the
    // host is the user's and is not known in advance. The browser fetches it and the server never
    // does. The rule recorded on signal_post_media and in docs/publishing-integration.md section
    // 3.3 is narrower than it once read: this app stores no media files, serves no media bytes,
    // and holds none at rest. The one decided exception is not built and would not widen this
    // policy if it were -- C74 and C75 in docs/post-bridge-integrations-plan.md put a single
    // server-side stream from a selected Drive file to the provider behind a confirmed submit,
    // and no browser request is involved, so no directive here changes for it.
    mediaSrc: ["'self'", 'https:'],
    objectSrc: ["'none'"],
    // Google Identity Services + Picker loader (C52). Inline script stays forbidden.
    scriptSrc: ["'self'", 'https://apis.google.com', 'https://accounts.google.com'],
    scriptSrcAttr: ["'none'"],
    styleSrc: [
      "'self'",
      'https://fonts.googleapis.com',
      `'${MCP_OAUTH_AUTHORIZE_PAGE_STYLE_HASH}'`,
    ],
    styleSrcAttr: ["'unsafe-inline'"],
    workerSrc: ["'self'"],
    // The production app is intentionally served over loopback HTTP by default.
    upgradeInsecureRequests: null,
  },
} as const;

const manualContentSecurityPolicy = (html: string): string => {
  const hashesFor = (tag: 'style' | 'script') =>
    Array.from(
      html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')),
      ([, body]) => `'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`,
    );

  return [
    "default-src 'none'",
    `style-src ${hashesFor('style').join(' ')} https://fonts.googleapis.com`,
    "style-src-attr 'none'",
    'font-src https://fonts.gstatic.com',
    `script-src ${hashesFor('script').join(' ')}`,
    "script-src-attr 'none'",
    'img-src data: https:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
};

export type AppOptions = {
  production?: boolean;
  /**
   * Force operator auth without the full §5.1 checklist (tests). Production derives
   * `authRequired` from `authenticationConfigured` — complete checklist means auth is on, even
   * when `HOST` stays loopback behind the proxy. Incomplete local checklist stays passwordless.
   */
  enforceAuth?: boolean;
  /**
   * Override `APP_ORIGIN` for checklist evaluation in tests (production-shaped loopback). Does
   * not change CORS; use only when proving auth turns on from the checklist alone.
   */
  appOrigin?: string;
  /** Override auth config for tests (session secret, password hash, proxy hops, Secure cookies). */
  auth?: {
    sessionSecret?: string;
    operatorPasswordHash?: string;
    trustedProxyHops?: number;
    secureCookies?: boolean;
    productionTlsTerminated?: boolean;
    trustedProxyHopsConfigured?: boolean;
  };
  /**
   * The Drive provider the read-only browsing routes use. Tests supply a mock one so a
   * listing can be exercised without credentials and without contacting real Drive; in
   * every other case this resolves to the encrypted-token provider as usual.
   */
  drive?: (db: Db) => DriveProvider;
  /**
   * The Drive **metadata** capability the Signal media routes use, for the same reason and with
   * the same rule: tests supply a mock so a Drive reference can be resolved without credentials.
   *
   * A separate option because it is a separate capability. Handing the browsing routes a mock must
   * not hand the media routes one, and vice versa — the two interfaces are the boundary C74 drew,
   * and one option covering both would quietly erase it here.
   */
  driveMedia?: (db: Db) => DriveMediaProvider;
  /** Test-only confirmed Drive write capability; never used by Files browsing. */
  driveWrite?: (db: Db) => DriveWriteProvider;
  /** Test-only publishing provider; automated tests never contact the real service. */
  publish?: PublishProvider;
  /**
   * Test-only analytics provider. Separate from `publish` because the interfaces are separate: the
   * figures path is handed something that cannot submit, update, or cancel a post, and a suite that
   * wants to rehearse a rate-limited synchronisation sets only this one.
   */
  analytics?: AnalyticsProvider;
  /**
   * Test-only inventory provider, separate again for the same reason: what the orphan panel is handed
   * can list the provider's posts and cannot submit, update, cancel, or measure anything. A suite
   * rehearsing a multi-page walk or a page failure sets only this one.
   */
  inventory?: ProviderInventoryProvider;
  /**
   * Test-only Buffer read provider. Separate from `publish` because this path lists organizations,
   * channels, and posts and cannot submit, edit, delete, upload, or measure anything.
   */
  bufferRead?: BufferReadProvider;
  /** Test-only Buffer write provider. Production stays behind BUFFER_WRITE_EVIDENCE. */
  bufferWrite?: BufferWriteProvider;
  /**
   * Test-only window provider, separate again for the same reason: what the window panel is handed can
   * list provider rows for one platform and window, and cannot sync, submit, update, or cancel
   * anything. A suite rehearsing a multi-page walk, an unmapped row, or a page failure sets only this
   * one.
   */
  analyticsWindow?: AnalyticsWindowProvider;
  /**
   * Test-only set of analytics windows the app may offer and refresh.
   *
   * Production takes the §14 evidence table in `shared/publish-analytics-window.ts`, which verifies
   * none — so no window is offered, and a refresh is refused before any provider call. A fixture and
   * the end-to-end run supply one here because the walk, the atomic replacement, the unmapped count,
   * and the failure path are unreachable otherwise. It widens nothing at runtime: no caller outside
   * these options sets it, and the sentence a fixture window carries says it is a fixture.
   */
  analyticsWindows?: readonly AnalyticsWindow[];
  /** Fixed configured zone for publishing tests and deployments. */
  publishTimezone?: string;
  /**
   * The authorization server the OAuth routes talk to. Tests supply `MockOAuthClient` so a
   * whole connect — authorization URL, callback, token exchange — runs without credentials
   * and without contacting Google.
   */
  oauth?: (credentials: OAuthCredentials) => OAuthAuthorizationClient;
  /**
   * The clock the OAuth state lifetime is measured against, so an expired state can be
   * exercised on a fixed one rather than by waiting ten minutes.
   */
  now?: () => Date;
  /**
   * Where request logs are written. Tests capture the stream to assert what a connect does
   * *not* log — an authorization code, an `Authorization` header, a `Cookie` header — which
   * is not something reading the configuration can establish.
   */
  logStream?: DestinationStream;
};

/** Query strings carry authorization codes and tokens, so the path is all a request log keeps. */
const pathOnly = (url: string | undefined) => (url ?? '').split('?')[0];

/**
 * Error messages, stacks, causes, and custom properties are untrusted provider/application data.
 * Keeping only the built-in name makes the no-secrets guarantee independent of a provider's error
 * format and avoids relying on a finite list of token patterns.
 */
export const safeError = (error: unknown) => ({
  name:
    error instanceof Error && /^[A-Za-z][A-Za-z0-9]*(?:Error)?$/.test(error.name)
      ? error.name
      : 'Error',
});

/**
 * The request logger.
 *
 * The level comes from `LOG_LEVEL`, so the variable `.env.example` documents is the one in use.
 * The request serializer keeps no headers and removes the query from the URL. The error
 * serializer keeps only an error name, so provider messages, stacks, causes, and custom fields
 * cannot carry credentials at any log level.
 *
 * The serializer names the fields it keeps rather than deleting the ones it does not. This
 * allowlist keeps fields added by a future pino-http version from quietly reintroducing secrets.
 */
function requestLogger(stream?: DestinationStream) {
  return pinoHttp(
    {
      level: config.logLevel,
      serializers: {
        req(request) {
          const { id, method, url, remoteAddress, remotePort } = stdSerializers.req(request);
          return { id, method, url: pathOnly(url), remoteAddress, remotePort };
        },
        err: safeError,
      },
    },
    stream,
  );
}

/**
 * The three shapes an optional client field is written in, before either of the two ways of
 * sending one is layered on. `nullable*` below is the PATCH form, where an omitted key keeps the
 * stored value; `mergeFieldChoice` below that is the merge form, where the key is always sent and only
 * a blank one clears the field. Both read from these, so a value a client form would refuse is
 * refused just the same when a merge is the thing choosing it.
 */
const text = z.string().trim();
const emailText = z.union([z.literal(''), z.string().email()]);
const urlText = z.union([z.literal(''), z.string().url()]);
/**
 * Optional text field. An omitted key stays `undefined` so a PATCH keeps the stored
 * value; an empty string becomes `null` so the caller can deliberately clear it.
 */
const nullable = text.optional().transform((v) => (v === undefined ? undefined : v || null));
const nullableEmail = emailText
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
const nullableUrl = urlText.optional().transform((v) => (v === undefined ? undefined : v || null));
const nullableBranding = z
  .union([z.string().trim().max(500), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null ? v : v || null));
/** Resolve one PATCH field: an omitted key keeps the stored value, `null` clears it. */
const patch = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);

const clientFields = {
  name: z.string().trim().min(2).max(120),
  contactName: nullable,
  email: nullableEmail,
  phone: nullable,
  website: nullableUrl,
  notes: nullable,
  brandingLogoUrl: nullableBranding,
  brandingColorOne: nullableBranding,
  brandingColorTwo: nullableBranding,
};
const validateClientBranding = (
  data: {
    brandingLogoUrl?: string | null;
    brandingColorOne?: string | null;
    brandingColorTwo?: string | null;
  },
  ctx: z.RefinementCtx,
) => {
  for (const issue of clientBrandingIssues({
    logoUrl: data.brandingLogoUrl ?? '',
    colorOne: data.brandingColorOne ?? '',
    colorTwo: data.brandingColorTwo ?? '',
  }))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: issue.message });
};
const clientInputBase = z.object(clientFields);
const clientInput = clientInputBase.superRefine(validateClientBranding);
const clientBrandingInput = z
  .object({
    brandingLogoUrl: nullableBranding,
    brandingColorOne: nullableBranding,
    brandingColorTwo: nullableBranding,
  })
  .superRefine(validateClientBranding);
const clientPatch = z.object(clientFields).partial();

const normalizedTagName = z.string().transform(normalizeTagName).pipe(z.string().min(1).max(60));
/** Optional decoration on a tag or category chip. The name always carries the meaning. */
const chipColor = z
  .union([z.literal(''), z.string().trim().min(1).max(32)])
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null));
const tagInput = z.object({ name: normalizedTagName, color: chipColor });
const tagPatch = tagInput.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide a tag field to update.',
});

const normalizedCategoryName = z
  .string()
  .transform(normalizeCategoryName)
  .pipe(z.string().min(1).max(60));
/**
 * One field's choice in a merge. `DESTINATION` and `SOURCE` name a record and carry nothing;
 * `CUSTOM` carries the value, validated by the same schema the client form validates that field
 * with, so a merge cannot write an address or an email a client edit would have refused. A blank
 * custom value clears the field, which is what a blank one means everywhere else.
 */
const mergeFieldChoice = <T extends z.ZodType<string>>(value: T) =>
  z.union([
    z.object({ choice: z.enum(['DESTINATION', 'SOURCE']) }),
    z.object({ choice: z.literal('CUSTOM'), value: value.transform((v) => v || null) }),
  ]);
/** The destination half of a merge, and its choices; the source is the route's own `:id`. */
const clientMergeInput = z.object({
  destinationId: z.string().uuid(),
  /**
   * The six choosable fields. Every one is optional and defaults to `DESTINATION` in the planner
   * rather than here, so an older client that sends no choices at all merges exactly as it did.
   */
  fields: z
    .object({
      name: mergeFieldChoice(clientFields.name),
      contactName: mergeFieldChoice(text),
      email: mergeFieldChoice(emailText),
      phone: mergeFieldChoice(text),
      website: mergeFieldChoice(urlText),
      notes: mergeFieldChoice(text),
    })
    .partial()
    .default({}),
});

const categoryInput = z.object({ name: normalizedCategoryName, color: chipColor });
const categoryPatch = categoryInput.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide a category field to update.',
});

function sendSampleWorkbook(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
  filename: string,
  directory: string,
  contentType: string,
  label: string,
) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.sendFile(filename, { root: directory }, (error?: Error) => {
    if (!error) return;
    /**
     * Before any bytes are on the wire this is a 500 through the shared handler, which is what
     * keeps the absolute path out of the response. After them there is no status left to send,
     * so a download the browser abandoned is logged and dropped rather than answered twice.
     */
    if (res.headersSent) {
      req.log.error({ err: error }, `${label} download failed`);
      return;
    }
    next(error);
  });
}

export function createApp(db: Db = getDb(), options: AppOptions = {}) {
  const app = express();
  const production = options.production ?? isProductionRuntime();
  const clock = options.now ?? (() => new Date());
  const oauthClient = options.oauth ?? createGoogleOAuthClient;
  const driveMedia = () => (options.driveMedia ?? driveMediaProvider)(db);
  const publishProvider =
    options.publish ??
    (publishConfigured()
      ? new PostBridgeProvider(config.publish.apiKey)
      : new UnavailablePublishProvider());
  const bufferWrite =
    options.bufferWrite ??
    (bufferConfigured() && BUFFER_WRITE_EVIDENCE.enabled
      ? new BufferWriteClient(config.buffer.apiKey)
      : new UnavailableBufferWriteProvider(BUFFER_WRITE_EVIDENCE.reason));
  const publisher = new PublishService(
    db,
    signalProvider(db),
    publishProvider,
    options.publishTimezone ?? config.publish.timezone,
    clock,
    driveMedia(),
    'post-bridge',
    bufferWrite,
  );
  // Beside the publisher and not inside it. It holds its own provider, which has no way to submit,
  // update, or cancel anything, and it never touches `SignalProvider` at all.
  const analytics = new PublishAnalyticsService(
    db,
    options.analytics ??
      (publishConfigured()
        ? new PostBridgeAnalyticsProvider(config.publish.apiKey)
        : new UnavailableAnalyticsProvider()),
    clock,
  );
  // Beside both of them, holding a provider that can only list. Nothing on this path can reach a
  // post, a publication, a target, or a figure.
  const inventory = new ProviderInventoryService(
    db,
    options.inventory ??
      (publishConfigured()
        ? new PostBridgeInventoryProvider(config.publish.apiKey)
        : new UnavailableProviderInventoryProvider()),
    clock,
  );
  const bufferRead =
    options.bufferRead ??
    (bufferConfigured()
      ? new BufferReadClient(config.buffer.apiKey)
      : new UnavailableBufferReadProvider());
  const bufferAccounts = new BufferAccountsService(db, bufferRead, clock);
  // A fifth provider beside the four above, holding something that can only list rows for one
  // platform and window. It cannot reach `analytics/sync`, a post, a publication, a target, or the
  // per-delivery figures — which is what lets a window panel be opened without spending anything.
  const analyticsWindow = new AnalyticsWindowService(
    db,
    options.analyticsWindow ??
      (publishConfigured()
        ? new PostBridgeAnalyticsWindowProvider(config.publish.apiKey)
        : new UnavailableAnalyticsWindowProvider()),
    clock,
    ...(options.analyticsWindows ? [options.analyticsWindows] : []),
  );
  app.use(
    helmet({
      // Vite's development client needs a relaxed policy for HMR. The built client does not.
      contentSecurityPolicy: production ? productionContentSecurityPolicy : false,
    }),
  );
  app.use(cors({ origin: config.appOrigin, credentials: true }));
  /**
   * The budgets go here — ahead of every parser — because both of the things they protect are
   * spent by the parser. A rate limit that runs after `express.json` has already read a 12 MB
   * body has metered nothing, and a concurrency cap behind it counts requests whose memory is
   * already allocated. See `budgets.ts` for why import and Drive are metered and the board is not.
   */
  const driveBudget = requestBudget(DRIVE_BUDGET, { now: clock });
  app.use('/api/import/playbook', requestBudget(IMPORT_BUDGET, { now: clock, applies: postsOnly }));
  app.use(
    '/api/import/playbook',
    concurrencyGate(IMPORT_CONCURRENCY, IMPORT_BUSY_MESSAGE, { applies: postsOnly }),
  );
  /**
   * The sample download is a GET under the same prefix, so the two mounts above pass it through —
   * both meter POSTs only. It gets its own window because what it spends is different, and
   * because a spent import budget must not withhold the example that fixes the failing workbook.
   */
  app.use(SAMPLE_PLAYBOOK_DOWNLOAD_PATH, requestBudget(SAMPLE_PLAYBOOK_BUDGET, { now: clock }));
  app.use(SAMPLE_SIGNAL_DOWNLOAD_PATH, requestBudget(SAMPLE_SIGNAL_BUDGET, { now: clock }));
  app.use('/api/drive/sync', requestBudget(DRIVE_SYNC_BUDGET, { now: clock }));
  app.use('/api/drive', driveBudget);
  app.use('/api/settings/drive', driveBudget);
  /**
   * The three Drive routes that do not sit under a Drive prefix, sharing the window above because
   * the quota they spend is one account's however they are addressed. Mounted rather than passed
   * to the route: a second handler on a path with a parameter widens `req.params.id` to
   * `string | string[]` in Express 5's types, and the budget is not worth casting the route for.
   */
  app.use('/api/projects/:id/files', driveBudget);
  app.use('/api/clients/:id/retry-drive', driveBudget);
  app.use('/api/projects/:id/retry-drive', driveBudget);
  /**
   * An uploaded workbook is base64 in a JSON body — the committed sample playbook alone is 86 KB
   * — so the import routes get a larger limit rather than raising it for every endpoint that
   * only ever carries a form. `IMPORT_BODY_LIMIT_BYTES` is derived from the caps the Zod schema
   * puts on the fields, so the parser and the schema cannot drift apart.
   *
   * Registered *before* the 1 MB parser deliberately: whichever parser runs first is the one
   * that reads the body and the one whose limit applies, and middleware runs in registration
   * order regardless of where the route is declared. Behind it, the general parser sees a body
   * that is already read and passes it through.
   */
  app.use('/api/import', express.json({ limit: IMPORT_BODY_LIMIT_BYTES }));
  app.use('/api/projects/:id/drive-write', express.json({ limit: '12mb' }));
  app.use('/api/drive-write-requests', express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger(options.logStream));

  /**
   * Operator authentication (C51 / C114). Auth is required when the §5.1 / §11 checklist is
   * complete — not when leaving loopback. Production keeps `HOST` on loopback behind Caddy;
   * local `npm run dev` without the checklist stays passwordless. Tests may set `enforceAuth`
   * to force a session without filling every checklist field.
   */
  const sessionSecret = options.auth?.sessionSecret ?? config.auth.sessionSecret;
  const operatorPasswordHash =
    options.auth?.operatorPasswordHash ?? config.auth.operatorPasswordHash;
  const trustedProxyHops = options.auth?.trustedProxyHops ?? config.auth.trustedProxyHops;
  const appOrigin = options.appOrigin ?? config.appOrigin;
  const productionTlsTerminated =
    options.auth?.productionTlsTerminated ?? config.auth.productionTlsTerminated;
  const trustedProxyHopsConfigured =
    options.auth?.trustedProxyHopsConfigured ?? config.auth.trustedProxyHopsConfigured;
  const authRequired =
    options.enforceAuth ??
    authenticationConfigured({
      sessionSecret,
      operatorPasswordHash,
      appOrigin,
      productionTlsTerminated,
      trustedProxyHopsConfigured,
    });
  const secureCookies =
    options.auth?.secureCookies ??
    (authRequired && (productionTlsTerminated || appOrigin.startsWith('https:')));
  const authNowMs = () => clock().getTime();

  // Auth uses express-rate-limit (not requestBudget) so CodeQL's missing-rate-limiting query can
  // see the limiter. Login has its own tighter window; the rest of `/api/auth` shares one bucket.
  // Numbers live in `AUTH_*_BUDGET` so operators and tests read one place. Keying follows the same
  // `TRUSTED_PROXY_HOPS` rule as login progressive delay — not Express `trust proxy`.
  const authKey = (req: {
    socket: { remoteAddress?: string | null };
    headers: AddressRequest['headers'];
  }) => clientAddress(req, trustedProxyHops);
  app.use(
    '/api/auth/login',
    rateLimit({
      windowMs: AUTH_LOGIN_BUDGET.windowMs,
      limit: AUTH_LOGIN_BUDGET.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: AUTH_LOGIN_BUDGET.message },
      keyGenerator: (req) => authKey(req),
      skip: (req) => req.method !== 'POST',
      validate: { xForwardedForHeader: false },
    }),
  );
  app.use(
    '/api/auth',
    rateLimit({
      windowMs: AUTH_ROUTE_BUDGET.windowMs,
      limit: AUTH_ROUTE_BUDGET.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: AUTH_ROUTE_BUDGET.message },
      keyGenerator: (req) => authKey(req),
      validate: { xForwardedForHeader: false },
    }),
  );
  // Drive OAuth start/callback: same express-rate-limit shape as auth so CodeQL sees the budget.
  // Still sits under the broader `/api/drive` requestBudget for Google quota; this window is for
  // connect/callback abuse (minting pending states and exchanging codes).
  app.use(
    '/api/drive/oauth',
    rateLimit({
      windowMs: DRIVE_OAUTH_BUDGET.windowMs,
      limit: DRIVE_OAUTH_BUDGET.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: DRIVE_OAUTH_BUDGET.message },
      keyGenerator: (req) => authKey(req),
      validate: { xForwardedForHeader: false },
    }),
  );
  app.use(
    '/api/mcp/health',
    rateLimit({
      windowMs: MCP_HEALTH_BUDGET.windowMs,
      limit: MCP_HEALTH_BUDGET.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: MCP_HEALTH_BUDGET.message },
      keyGenerator: (req) => authKey(req),
      validate: { xForwardedForHeader: false },
    }),
  );
  app.use(
    '/api/health/dashboard',
    rateLimit({
      windowMs: HEALTH_DASHBOARD_BUDGET.windowMs,
      limit: HEALTH_DASHBOARD_BUDGET.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: HEALTH_DASHBOARD_BUDGET.message },
      keyGenerator: (req) => authKey(req),
      validate: { xForwardedForHeader: false },
    }),
  );
  const mcpOAuthLimiter = rateLimit({
    windowMs: MCP_OAUTH_BUDGET.windowMs,
    limit: MCP_OAUTH_BUDGET.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: MCP_OAUTH_BUDGET.message },
    keyGenerator: (req) => authKey(req),
    validate: { xForwardedForHeader: false },
  });

  // Network MCP (C113): own auth (session cookie or bearer) before the global `/api` middleware,
  // because bearer clients do not carry the HttpOnly session cookie.
  if (authRequired) {
    // The limiter goes to the router rather than to a list of path prefixes here: the router owns
    // which paths it serves, and two lists that have to agree is one route away from an unprotected
    // endpoint that nothing points at.
    app.use(
      createMcpOAuthRouter({
        db,
        sessionSecret,
        appOrigin,
        secureCookies,
        operatorPasswordHash,
        trustedProxyHops,
        now: authNowMs,
        rateLimiter: mcpOAuthLimiter,
      }),
    );
    // One registry per app instance — process lifetime in production (one process runs one app),
    // and naturally test-isolated since each test builds its own app (C116 / #366).
    const mcpWriteLimiters = new McpWriteLimiterRegistry();
    const mcpIntegrationWriteLimiters = new McpWriteLimiterRegistry(
      INTEGRATION_WRITE_LIMIT_PER_MINUTE,
    );
    const mcpHttpSessions = new McpHttpSessionRegistry();
    setMcpResourceUpdateBridge((uri) => {
      mcpHttpSessions.notifyResourceUpdated(uri);
    });
    app.all(
      MCP_HTTP_PATH,
      createMcpHttpHandler({
        db,
        sessionSecret,
        appOrigin,
        now: authNowMs,
        writeLimiters: mcpWriteLimiters,
        integrationWriteLimiters: mcpIntegrationWriteLimiters,
        httpSessions: mcpHttpSessions,
        integrationDeps: {
          inventory,
          analyticsWindow,
          bufferAccounts,
          driveMedia: () => driveMedia(),
          drive: (database) => driveProvider(database),
        },
      }),
    );
  }

  app.use(
    '/api',
    createAuthMiddleware({
      db,
      authRequired,
      sessionSecret,
      trustedProxyHops,
      secureCookies,
      now: authNowMs,
    }),
  );

  app.get('/api/auth/status', (req, res) => {
    const session = (req as unknown as AuthedRequest).operatorSession;
    res.json(authStatus({ authRequired, session }));
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      if (!authRequired) {
        res.status(400).json({ error: 'Authentication is not required on this host.' });
        return;
      }
      if (!sessionSecret) {
        res.status(503).json({ error: 'Authentication is not configured.' });
        return;
      }
      const body = z.object({ password: z.string().min(1) }).parse(req.body);
      const address =
        (req as AuthedRequest).operatorClientAddress ?? clientAddress(req, trustedProxyHops);
      const result = await operatorLogin(db, {
        password: body.password,
        clientAddress: address,
        sessionSecret,
        envHash: operatorPasswordHash,
        now: authNowMs(),
      });
      if (!result.ok) {
        if (result.retryAfterMs > 0) {
          res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
          res.status(429).json({ error: result.error });
          return;
        }
        // Generic failure — never distinguish a missing hash from a wrong password.
        req.log.warn({ event: 'auth.login_failed', clientAddress: address }, 'Login refused');
        res.status(401).json({ error: result.error });
        return;
      }
      purgeExpiredSessions(db, authNowMs());
      purgeExpiredAuthorizations(db, clock());
      res.setHeader('Set-Cookie', buildSessionCookie(result.rawToken, { secure: secureCookies }));
      res.json({ ok: true, csrfToken: result.csrfToken });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    // Revoke from the middleware's validated session row, not from a raw Cookie parse — a
    // user-supplied cookie value must not be the condition that gates the revoke.
    const session = (req as AuthedRequest).operatorSession;
    operatorLogout(db, {
      tokenHash: session?.tokenHash ?? null,
      now: authNowMs(),
    });
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
    res.json({ ok: true });
  });

  app.post(MCP_BEARER_ISSUE_PATH, (req, res) => {
    if (!authRequired) {
      res.status(400).json({ error: 'Authentication is not required on this host.' });
      return;
    }
    const session = (req as AuthedRequest).operatorSession;
    if (!session) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    const issued = createMcpBearer(db, {
      sessionTokenHash: session.tokenHash,
      sessionSecret,
      now: authNowMs(),
    });
    res.json({ ok: true, bearerToken: issued.rawToken });
  });

  app.get('/api/auth/mcp-agents', (_req, res) => {
    res.json({
      enabled: authRequired,
      credentials: authRequired ? listMcpAgentCredentials(db, authNowMs()) : [],
    });
  });

  app.post('/api/auth/mcp-agents', (req, res, next) => {
    try {
      if (!authRequired) {
        res.status(400).json({ error: 'Authentication is not required on this host.' });
        return;
      }
      const input = createMcpAgentCredentialSchema.parse(req.body);
      const issued = createMcpAgentCredential(db, {
        ...input,
        sessionSecret,
        now: authNowMs(),
      });
      res.status(201).json({
        ok: true,
        bearerToken: issued.rawToken,
        credential: issued.credential,
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/auth/mcp-agents/:agentId', (req, res, next) => {
    try {
      if (!authRequired) {
        res.status(400).json({ error: 'Authentication is not required on this host.' });
        return;
      }
      const input = updateMcpAgentRegistrationSchema.parse(req.body);
      if (!renameMcpAgentRegistration(db, req.params.agentId, input.label)) {
        res.status(404).json({ error: 'Agent registration not found.' });
        return;
      }
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/mcp-credentials/:credentialId/revoke', (req, res) => {
    if (!authRequired) {
      res.status(400).json({ error: 'Authentication is not required on this host.' });
      return;
    }
    if (!revokeMcpAgentCredential(db, req.params.credentialId, authNowMs())) {
      res.status(404).json({ error: 'Active MCP credential not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/mcp-credentials/:credentialId/rotate', (req, res, next) => {
    try {
      if (!authRequired) {
        res.status(400).json({ error: 'Authentication is not required on this host.' });
        return;
      }
      const input = createMcpAgentCredentialSchema.parse(req.body);
      const issued = rotateMcpAgentCredential(db, {
        credentialId: req.params.credentialId,
        ...input,
        sessionSecret,
        now: authNowMs(),
      });
      res
        .status(201)
        .json({ ok: true, bearerToken: issued.rawToken, credential: issued.credential });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/mcp/health', (_req, res) => {
    try {
      res.json(buildMcpHealthPanel(db, { enabled: authRequired, now: new Date(authNowMs()) }));
    } catch (error) {
      res.status(500).json({
        enabled: authRequired,
        state: 'unavailable',
        stateReason:
          error instanceof Error ? error.message : 'The MCP health panel could not be loaded.',
        generatedAt: new Date(authNowMs()).toISOString(),
        agents: [],
        errorSummary: [],
        staleHandoffs: [],
        recentCompletions: [],
        auditEventCount: 0,
      });
    }
  });

  app.get('/api/health/dashboard', (_req, res) => {
    try {
      res.json(buildAppHealth(db, { authRequired, now: new Date(authNowMs()) }));
    } catch (error) {
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Health dashboard unavailable.' });
    }
  });

  app.post('/api/mcp/health/test', (req, res) => {
    if (!authRequired) {
      res.status(400).json({ error: 'Authentication is not required on this host.' });
      return;
    }
    const { credentialId } = mcpHealthTestInputSchema.parse(req.body ?? {});
    const credential = credentialId ? getMcpAgentCredential(db, credentialId) : null;
    const checksumBefore = workspaceDataChecksum(db);
    const now = new Date(authNowMs());
    const status = buildConnectionStatus(db, {
      transport: 'operator',
      authenticated: true,
      agentLabel: null,
      grantedScopes: MCP_AGENT_SCOPES,
      baseUrl: appOrigin,
      now,
    });
    const checksumAfter = workspaceDataChecksum(db);
    res.json({
      ok: status.ok,
      status,
      workspaceChecksumUnchanged: checksumBefore === checksumAfter,
      lastUsedAt: now.toISOString(),
      credential: credential
        ? mcpHealthDiagnosticCredentialSchema.parse({
            id: credential.id,
            issuedAt: credential.issuedAt,
            expiresAt: credential.expiresAt,
          })
        : null,
    });
  });

  app.get('/api/mcp/health/verification/:credentialId', (req, res) => {
    if (!authRequired) {
      res.status(400).json({ error: 'Authentication is not required on this host.' });
      return;
    }
    const credential = getMcpAgentCredential(db, req.params.credentialId);
    const storeId = getStoreId(db);
    if (!credential) {
      const verification: McpCredentialVerification = {
        credentialId: req.params.credentialId,
        agentLabel: '',
        storeId,
        status: 'not_found',
        verifiedAt: null,
      };
      res.status(404).json(verification);
      return;
    }
    const verification: McpCredentialVerification = {
      credentialId: credential.id,
      agentLabel: credential.label,
      storeId,
      status: credential.revokedAt ? 'revoked' : credential.lastUsedAt ? 'verified' : 'pending',
      verifiedAt: credential.lastUsedAt,
    };
    res.json(verification);
  });

  app.post('/api/auth/password', async (req, res, next) => {
    try {
      if (!authRequired) {
        res.status(400).json({ error: 'Authentication is not required on this host.' });
        return;
      }
      const body = z
        .object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(1),
        })
        .parse(req.body);
      const result = await changePassword(db, {
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        envHash: operatorPasswordHash,
        now: authNowMs(),
      });
      if (!result.ok) {
        res.status(401).json({ error: result.error });
        return;
      }
      res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.get('/api/clients', (_req, res) => res.json(listClients(db)));
  app.post('/api/clients', async (req, res, next) => {
    try {
      const data = clientInput.parse(req.body);
      const clientId = id();
      const stamp = now();
      db.prepare(
        `INSERT INTO clients(id,name,slug,contact_name,email,phone,website,notes,branding_logo_url,branding_color_one,branding_color_two,drive_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        clientId,
        data.name,
        buildClientSlug(data.name, clientId),
        data.contactName ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.website ?? null,
        data.notes ?? null,
        data.brandingLogoUrl ?? null,
        normalizeHex(data.brandingColorOne ?? '') ?? data.brandingColorOne ?? null,
        normalizeHex(data.brandingColorTwo ?? '') ?? data.brandingColorTwo ?? null,
        'PENDING',
        stamp,
        stamp,
      );
      try {
        await provisionClient(db, clientId);
      } catch (error) {
        req.log.error({ err: error, clientId }, 'Drive client provisioning failed');
      }
      res.status(201).json(listClients(db).find((c: any) => c.id === clientId));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/clients/:id', (req, res, next) => {
    try {
      const data = clientPatch.parse(req.body);
      const revision = revisionPrecondition.parse(req.body?.revision);
      const current = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id) as any;
      if (!current) return res.status(404).json({ error: 'Client not found.' });
      const branding = {
        brandingLogoUrl: patch(data.brandingLogoUrl, current.branding_logo_url),
        brandingColorOne: patch(data.brandingColorOne, current.branding_color_one),
        brandingColorTwo: patch(data.brandingColorTwo, current.branding_color_two),
      };
      const brandingResult = clientBrandingInput.safeParse(branding);
      if (!brandingResult.success)
        throw new WorkspaceValidationError(brandingResult.error.issues[0].message);
      const stamp = now();
      transaction(db, () => {
        requireRevision(db, 'client', current.id, revision);
        db.prepare(
          `UPDATE clients SET name=?,slug=?,contact_name=?,email=?,phone=?,website=?,notes=?,branding_logo_url=?,branding_color_one=?,branding_color_two=?,updated_at=? WHERE id=?`,
        ).run(
          patch(data.name, current.name),
          data.name === undefined ? current.slug : buildClientSlug(data.name, current.id),
          patch(data.contactName, current.contact_name),
          patch(data.email, current.email),
          patch(data.phone, current.phone),
          patch(data.website, current.website),
          patch(data.notes, current.notes),
          branding.brandingLogoUrl,
          normalizeHex(branding.brandingColorOne ?? '') ?? branding.brandingColorOne,
          normalizeHex(branding.brandingColorTwo ?? '') ?? branding.brandingColorTwo,
          stamp,
          req.params.id,
        );
        advanceRevision(db, 'client', current.id, revision, Object.keys(data), stamp);
      });
      res.json(listClients(db).find((c: any) => c.id === req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/clients/:id/archive', (req, res) => {
    const result = db
      .prepare("UPDATE clients SET status='ARCHIVED',updated_at=? WHERE id=?")
      .run(now(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ok: true });
  });
  app.post('/api/clients/:id/unarchive', (req, res) => {
    /**
     * A merged client stays archived. Restoring it would leave a live client whose projects
     * belong to another one and whose name still resolves to that other one on import, which
     * is not a state the merge can be talked out of afterwards — there is no unmerge.
     */
    if (isMergedSource(db, req.params.id))
      return res.status(409).json({
        error: 'This client was merged into another client, so it cannot be restored.',
        code: 'CLIENT_MERGED',
      });
    const result = db
      .prepare("UPDATE clients SET status='ACTIVE',updated_at=? WHERE id=?")
      .run(now(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ok: true });
  });
  /**
   * Merging one client into another (C49, C71). The preview writes nothing; the commit re-plans
   * inside its own transaction and refuses a plan that no longer matches the one confirmed.
   * Both live in `server/client-merge.ts`, which calls no Drive method and writes no
   * `integration_events` row — a merge is local workspace surgery, not an integration.
   *
   * The field choices go to both routes. The preview settles what each field would become and
   * hashes it; the commit settles it again from the same choices, so a confirmation taken
   * against one set of values cannot write another.
   */
  app.post('/api/clients/:id/merge/preview', (req, res, next) => {
    try {
      const data = clientMergeInput.parse(req.body);
      res.json(previewClientMerge(db, req.params.id, data.destinationId, data.fields));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/clients/:id/merge', (req, res, next) => {
    try {
      const data = clientMergeInput.extend({ planHash: z.string().length(64) }).parse(req.body);
      res.json(
        commitClientMerge(db, req.params.id, data.destinationId, data.fields, data.planHash),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/clients/:id/retry-drive', async (req, res, next) => {
    try {
      await provisionClient(db, req.params.id);
      res.json(listClients(db).find((c: any) => c.id === req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/projects', (_req, res) => res.json(listProjects(db)));
  app.post('/api/projects', async (req, res, next) => {
    try {
      const data = projectInput.parse(req.body);
      const project = createProject(db, data);
      try {
        await provisionProject(db, project.id);
      } catch (error) {
        req.log.error({ err: error, projectId: project.id }, 'Drive project provisioning failed');
      }
      res.status(201).json(getProjectById(db, project.id));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/projects/:id', (req, res, next) => {
    try {
      const data = projectPatch.parse(req.body);
      const revision = revisionPrecondition.parse(req.body?.revision);
      res.json(updateProject(db, req.params.id, data, revision));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/projects/:id/archive', (req, res) => {
    const stamp = now();
    const r = db
      .prepare("UPDATE projects SET status='ARCHIVED',updated_at=?,last_activity_at=? WHERE id=?")
      .run(stamp, stamp, req.params.id);
    if (!r.changes) return res.status(404).json({ error: 'Project not found.' });
    res.json({ ok: true });
  });
  app.delete('/api/projects/:id', (req, res, next) => {
    try {
      res.json(deleteProject(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/projects/reorder', (req, res, next) => {
    try {
      const data = z.object({ orderedIds: z.array(z.string().uuid()).min(1) }).parse(req.body);
      const known = new Set(
        (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((row) => row.id),
      );
      if (data.orderedIds.some((projectId) => !known.has(projectId)))
        return res.status(404).json({ error: 'Project not found.' });
      // Neither `updated_at` nor `last_activity_at` is touched: rearranging tiles is
      // neither an edit nor work on the project, and stamping either would reshuffle the
      // Recently updated sort on the same screen.
      transaction(db, () => {
        const stmt = db.prepare('UPDATE projects SET position=? WHERE id=?');
        data.orderedIds.forEach((projectId, index) => stmt.run(index, projectId));
      });
      res.json(listProjects(db));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/projects/:id/retry-drive', async (req, res, next) => {
    try {
      await provisionProject(db, req.params.id);
      res.json(getProjectById(db, req.params.id));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Agent Drive write requests. MCP can create a pending request only; these operator routes are
   * the sole path that can decide one and execute through commitDriveWrite.
   */
  app.get('/api/drive-write-requests', (req, res, next) => {
    try {
      const status = z
        .enum([
          'PENDING',
          'EXECUTING',
          'APPROVED',
          'DENIED',
          'FAILED',
          'EXPIRED',
          'PROVIDER_UNCERTAIN',
        ])
        .optional()
        .parse(req.query.status);
      res.json({
        requests: listDriveWriteRequests(db, status, clock()),
        summary: summarizeDriveWriteRequests(db, clock()),
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/drive-write-requests/:id/approve', async (req, res, next) => {
    try {
      const request = await decideDriveWrite(
        db,
        req.params.id,
        'approve',
        options.driveWrite ? options.driveWrite(db) : driveWriteProvider(db),
      );
      res.json(request);
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/drive-write-requests/:id/deny', (req, res, next) => {
    void (async () => {
      try {
        const request = await decideDriveWrite(
          db,
          req.params.id,
          'deny',
          options.driveWrite ? options.driveWrite(db) : driveWriteProvider(db),
        );
        res.json(request);
      } catch (error) {
        next(error);
      }
    })();
  });

  /**
   * Confirmed Drive writes (C162). This is deliberately beside, not inside, the Files browse
   * route. Preview is read-only; commit accepts only the exact plan hash returned by preview.
   * There is no agent route: agent Drive write remains a separate, default-off grant.
   */
  app.post('/api/projects/:id/drive-write/folder/preview', (req, res, next) => {
    try {
      const data = z
        .object({
          parentId: z.string().trim().min(1).max(200),
          name: z.string().trim().min(1).max(200),
        })
        .strict()
        .parse(req.body);
      res.json(previewDriveFolderCreate(db, { projectId: req.params.id, ...data }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/projects/:id/drive-write/folder', async (req, res, next) => {
    try {
      const data = z
        .object({
          plan: driveWritePlanSchema,
          planHash: z.string().length(64),
          confirmation: z.string().min(1).max(500),
        })
        .strict()
        .parse(req.body);
      if (data.plan.kind !== 'create-folder' || data.plan.projectId !== req.params.id)
        throw new DriveWriteConfirmationError('The confirmed plan does not match this project.');
      const folder = await commitDriveWrite(
        db,
        data.plan,
        data.planHash,
        options.driveWrite ? options.driveWrite(db) : driveWriteProvider(db),
      );
      res.status(201).json(folder);
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/projects/:id/drive-write/upload/preview', (req, res, next) => {
    try {
      const data = z
        .object({
          folderId: z.string().trim().min(1).max(200),
          name: z.string().trim().min(1).max(200),
          mimeType: z.string().trim().min(1).max(200),
          contentBase64: z.string().min(1),
        })
        .strict()
        .parse(req.body);
      res.json(previewDriveUpload(db, { projectId: req.params.id, ...data }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/projects/:id/drive-write/upload', async (req, res, next) => {
    try {
      const data = z
        .object({
          plan: driveWritePlanSchema,
          planHash: z.string().length(64),
          confirmation: z.string().min(1).max(500),
        })
        .strict()
        .parse(req.body);
      if (data.plan.kind !== 'upload-file' || data.plan.projectId !== req.params.id)
        throw new DriveWriteConfirmationError('The confirmed plan does not match this project.');
      const file = await commitDriveWrite(
        db,
        data.plan,
        data.planHash,
        options.driveWrite ? options.driveWrite(db) : driveWriteProvider(db),
      );
      res.status(201).json(file);
    } catch (error) {
      next(error);
    }
  });

  /**
   * One page of a project's Drive folder, read-only (FR8). This is the whole API surface
   * the Files page has: there is no POST, PATCH, or DELETE beside it, and nothing here
   * returns a token or a credential — the browser gets names, IDs, and the `webViewLink`
   * Drive itself would send someone to.
   *
   * Every failure mode is a state on the body rather than an HTTP error, because each one
   * has a different thing for the user to do about it and the page has to render them.
   * The two genuine 4xxs are a project that does not exist and a folder that is not this
   * project's.
   */
  app.get('/api/projects/:id/files', async (req, res, next) => {
    try {
      const query = z
        .object({
          folderId: z.string().trim().min(5).max(200).optional(),
          pageToken: z.string().trim().min(1).max(4096).optional(),
          pageSize: z.coerce.number().int().min(1).max(DRIVE_PAGE_SIZE_MAX).optional(),
        })
        .parse(req.query);
      const listing = await listProjectFiles(db, req.params.id, {
        ...query,
        pageSize: query.pageSize ?? DRIVE_PAGE_SIZE,
        ...(options.drive ? { provider: options.drive(db) } : {}),
      });
      if (!listing) return res.status(404).json({ error: 'Project not found.' });
      res.json(listing);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/tasks', (req, res, next) => {
    try {
      const filters = taskFiltersFromQuery(req.query as Record<string, unknown>);
      if (req.query.projectId) filters.projects = [String(req.query.projectId)];
      if (req.query.clientId) filters.clients = [String(req.query.clientId)];
      res.json(listTasksFiltered(db, filters));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/task-presets', (req, res) => {
    const session = (req as unknown as AuthedRequest).operatorSession;
    res.json(listTaskPresets(db, session?.tokenHash ?? null));
  });
  app.post('/api/task-presets', (req, res, next) => {
    try {
      const session = (req as unknown as AuthedRequest).operatorSession;
      const input = taskPresetInputSchema.parse(req.body);
      res
        .status(201)
        .json(
          saveTaskPreset(db, input, session?.tokenHash ?? null, id(), new Date().toISOString()),
        );
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/task-presets/:id', (req, res) => {
    const session = (req as unknown as AuthedRequest).operatorSession;
    if (!deleteTaskPreset(db, req.params.id, session?.tokenHash ?? null))
      return res.status(404).json({ error: 'Preset not found.' });
    res.json({ ok: true });
  });
  app.post('/api/tasks', (req, res, next) => {
    try {
      res.status(201).json(createTask(db, taskInput.parse(req.body)));
    } catch (e) {
      next(e);
    }
  });
  app.patch('/api/tasks/:id', (req, res, next) => {
    try {
      const data = taskPatch.extend({ overrideBlocked: z.boolean().optional() }).parse(req.body);
      const revision = revisionPrecondition.parse(req.body?.revision);
      res.json(updateTask(db, req.params.id, data, revision));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/tasks/:id', (req, res, next) => {
    try {
      res.json(deleteTask(db, req.params.id));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/tags', (_req, res) => res.json(listTags(db)));
  app.post('/api/tags', (req, res, next) => {
    try {
      const data = tagInput.parse(req.body);
      const existing = db
        .prepare('SELECT id FROM tags WHERE name=? COLLATE NOCASE')
        .get(data.name) as { id: string } | undefined;
      if (existing) return res.json(getTag(db, existing.id));
      const tagId = id();
      db.prepare('INSERT INTO tags(id,name,color) VALUES(?,?,?)').run(
        tagId,
        data.name,
        data.color ?? null,
      );
      res.status(201).json(getTag(db, tagId));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/tags/:id', (req, res, next) => {
    try {
      const data = tagPatch.parse(req.body);
      const current = db.prepare('SELECT * FROM tags WHERE id=?').get(req.params.id) as any;
      if (!current) return res.status(404).json({ error: 'Tag not found.' });
      db.prepare('UPDATE tags SET name=?,color=? WHERE id=?').run(
        patch(data.name, current.name),
        patch(data.color, current.color),
        current.id,
      );
      res.json(getTag(db, current.id));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/tags/:id', (req, res, next) => {
    try {
      const query = z.object({ confirm: z.literal('true').optional() }).parse(req.query);
      const tag = getTag(db, req.params.id);
      if (!tag) return res.status(404).json({ error: 'Tag not found.' });
      const attached = (
        db.prepare('SELECT COUNT(*) count FROM task_tags WHERE tag_id=?').get(tag.id) as {
          count: number;
        }
      ).count;
      if (attached > 0 && query.confirm !== 'true')
        return res.status(409).json({
          error: 'This tag is attached to tasks. Confirm deletion to detach it everywhere.',
          code: 'TAG_IN_USE',
          attachedTaskCount: attached,
        });
      db.prepare('DELETE FROM tags WHERE id=?').run(tag.id);
      res.json({ ok: true, deleted: 'tag', name: tag.name, detachedFromTasks: attached });
    } catch (error) {
      next(error);
    }
  });

  // Project categories. The same shape as tags one level up: a shared, user-managed list,
  // matched case-insensitively, attached through a join so a rename reaches every project at
  // once and a deletion detaches without deleting anything a person made.
  app.get('/api/categories', (_req, res) => res.json(listCategories(db)));
  app.post('/api/categories', (req, res, next) => {
    try {
      const data = categoryInput.parse(req.body);
      const existing = db
        .prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE')
        .get(data.name) as { id: string } | undefined;
      // Typing a name that already exists picks that category rather than refusing or
      // duplicating it, which is what makes the chip input safe to type into.
      if (existing) return res.json(getCategory(db, existing.id));
      const categoryId = id();
      db.prepare('INSERT INTO categories(id,name,color) VALUES(?,?,?)').run(
        categoryId,
        data.name,
        data.color ?? null,
      );
      res.status(201).json(getCategory(db, categoryId));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/categories/:id', (req, res, next) => {
    try {
      const data = categoryPatch.parse(req.body);
      const current = getCategory(db, req.params.id);
      if (!current) return res.status(404).json({ error: 'Category not found.' });
      const nextName = patch(data.name, current.name);
      // The UNIQUE index would refuse this anyway, with a message naming SQLite rather than
      // the category already holding the name.
      const clash = db
        .prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE AND id<>?')
        .get(nextName, current.id) as { id: string } | undefined;
      if (clash)
        return res.status(409).json({
          error: `Another category is already called “${nextName}”.`,
          code: 'CATEGORY_NAME_TAKEN',
        });
      db.prepare('UPDATE categories SET name=?,color=? WHERE id=?').run(
        nextName,
        patch(data.color, current.color ?? null),
        current.id,
      );
      res.json(getCategory(db, current.id));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/categories/:id', (req, res, next) => {
    try {
      const query = z.object({ confirm: z.literal('true').optional() }).parse(req.query);
      const category = getCategory(db, req.params.id);
      if (!category) return res.status(404).json({ error: 'Category not found.' });
      const attached = (
        db
          .prepare('SELECT COUNT(*) count FROM project_categories WHERE category_id=?')
          .get(category.id) as { count: number }
      ).count;
      if (attached > 0 && query.confirm !== 'true')
        return res.status(409).json({
          error: 'This category is attached to projects. Confirm deletion to detach it everywhere.',
          code: 'CATEGORY_IN_USE',
          attachedProjectCount: attached,
        });
      // The join rows cascade. No project is deleted, and no project field changes.
      db.prepare('DELETE FROM categories WHERE id=?').run(category.id);
      res.json({
        ok: true,
        deleted: 'category',
        name: category.name,
        detachedFromProjects: attached,
      });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/projects/:id/categories', (req, res, next) => {
    try {
      const data = z.object({ categoryId: z.string().uuid() }).parse(req.body);
      if (!db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id))
        return res.status(404).json({ error: 'Project not found.' });
      if (!db.prepare('SELECT id FROM categories WHERE id=?').get(data.categoryId))
        return res.status(404).json({ error: 'Category not found.' });
      const stamp = now();
      const attached = transaction(db, () => {
        const result = db
          .prepare('INSERT OR IGNORE INTO project_categories(project_id,category_id) VALUES(?,?)')
          .run(req.params.id, data.categoryId);
        // Re-attaching a category the project already carries changes nothing.
        if (result.changes) touchProjectRecord(db, req.params.id, stamp);
        return result.changes;
      });
      res.status(attached ? 201 : 200).json(getProjectById(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/projects/:id/categories/:categoryId', (req, res) => {
    if (!db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id))
      return res.status(404).json({ error: 'Project not found.' });
    const stamp = now();
    transaction(db, () => {
      const result = db
        .prepare('DELETE FROM project_categories WHERE project_id=? AND category_id=?')
        .run(req.params.id, req.params.categoryId);
      if (result.changes) touchProjectRecord(db, req.params.id, stamp);
    });
    res.json(getProjectById(db, req.params.id));
  });
  app.post('/api/tasks/reorder', (req, res, next) => {
    try {
      const data = z
        .object({
          taskId: z.string().uuid(),
          status: z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETE']),
          orderedIds: z.array(z.string().uuid()),
          overrideBlocked: z.boolean().optional(),
        })
        .parse(req.body);
      const t = getTask(db, data.taskId);
      if (!t) return res.status(404).json({ error: 'Task not found.' });
      if (data.status === 'COMPLETE' && t.blocked && !data.overrideBlocked)
        return res.status(409).json({
          error: 'This task is blocked by incomplete dependencies.',
          code: 'TASK_BLOCKED',
          blockingDependencies: t.blockingDependencies,
        });
      const stamp = now();
      transaction(db, () => {
        db.prepare('UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=?').run(
          data.status,
          data.status === 'COMPLETE' ? t.completedAt || stamp : null,
          stamp,
          data.taskId,
        );
        const stmt = db.prepare('UPDATE tasks SET position=? WHERE id=? AND status=?');
        data.orderedIds.forEach((taskId, index) => stmt.run(index, taskId, data.status));
        // Only the moved task's project: the siblings shifting position around it did not
        // themselves change, and this endpoint carries every status change off the board.
        touchProjectActivity(db, t.projectId, stamp);
      });
      res.json(getTask(db, data.taskId));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/tasks/:id/checklist', (req, res, next) => {
    try {
      const data = z.object({ text: z.string().trim().min(1).max(300) }).parse(req.body);
      res.status(201).json(addChecklistItem(db, req.params.id, data.text));
    } catch (e) {
      next(e);
    }
  });
  app.patch('/api/checklist/:id', (req, res, next) => {
    try {
      const data = z
        .object({
          text: z.string().trim().min(1).optional(),
          completed: z.boolean().optional(),
          position: z.number().int().min(0).optional(),
        })
        .parse(req.body);
      res.json(updateChecklistItem(db, req.params.id, data));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/checklist/:id', (req, res, next) => {
    try {
      res.json(removeChecklistItem(db, req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/tasks/:id/tags', (req, res, next) => {
    try {
      const data = z.object({ tagId: z.string().uuid() }).parse(req.body);
      const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(req.params.id) as
        { project_id: string } | undefined;
      if (!task) return res.status(404).json({ error: 'Task not found.' });
      if (!db.prepare('SELECT id FROM tags WHERE id=?').get(data.tagId))
        return res.status(404).json({ error: 'Tag not found.' });
      const stamp = now();
      const attached = transaction(db, () => {
        const result = db
          .prepare('INSERT OR IGNORE INTO task_tags(task_id,tag_id) VALUES(?,?)')
          .run(req.params.id, data.tagId);
        // Re-attaching a tag the task already carries changes nothing, so it is not activity.
        if (result.changes) touchProjectActivity(db, task.project_id, stamp);
        return result.changes;
      });
      res.status(attached ? 201 : 200).json(getTask(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/tasks/:id/tags/:tagId', (req, res) => {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(req.params.id) as
      { project_id: string } | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    const stamp = now();
    transaction(db, () => {
      const result = db
        .prepare('DELETE FROM task_tags WHERE task_id=? AND tag_id=?')
        .run(req.params.id, req.params.tagId);
      if (result.changes) touchProjectActivity(db, task.project_id, stamp);
    });
    res.json(getTask(db, req.params.id));
  });
  app.post('/api/tasks/:id/dependencies', (req, res, next) => {
    try {
      const data = z.object({ dependencyId: z.string().uuid() }).parse(req.body);
      res.status(201).json(addDependency(db, req.params.id, data.dependencyId));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/tasks/:id/dependencies/:dependencyId', (req, res, next) => {
    try {
      res.json(removeDependency(db, req.params.id, req.params.dependencyId));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/dashboard', (_req, res) => {
    res.json(buildDashboardSummary(db));
  });

  app.get('/api/settings/branding', (_req, res) =>
    res.json({ version: APP_VERSION, branding: readBranding(db) }),
  );
  const manualLimiter = rateLimit({
    windowMs: MANUAL_BUDGET.windowMs,
    limit: MANUAL_BUDGET.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: MANUAL_BUDGET.message },
    keyGenerator: (req) => authKey(req),
    validate: { xForwardedForHeader: false },
  });
  app.use('/api/settings/manual', manualLimiter);
  app.use(MANUAL_ROUTE, manualLimiter);
  app.get('/api/settings/manual', (_req, res) => {
    const manualPath = path.resolve('docs/manual', MANUAL_FILENAME);
    const available = fs.existsSync(manualPath);
    res.json({
      version: APP_VERSION,
      available,
      url: available ? manualUrlForVersion(APP_VERSION) : null,
    });
  });
  app.get(`${MANUAL_ROUTE}/:version`, (req, res) => {
    const manualPath = path.resolve('docs/manual', MANUAL_FILENAME);
    if (req.params.version !== APP_VERSION || !fs.existsSync(manualPath)) {
      res.status(404).json({ error: 'The user manual for this version is unavailable.' });
      return;
    }
    const html = fs.readFileSync(manualPath, 'utf8');
    if (production) res.set('Content-Security-Policy', manualContentSecurityPolicy(html));
    res.type('html').send(html);
  });
  app.put('/api/settings/branding', (req, res, next) => {
    try {
      res.json(updateBranding(db, brandingInput.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/settings/view-defaults', (_req, res) =>
    res.json({ viewDefaults: readViewDefaults(db) }),
  );
  app.put('/api/settings/view-defaults', (req, res, next) => {
    try {
      res.json(updateViewDefaults(db, viewDefaultsInput.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });
  /**
   * The sample workbook, downloaded rather than looked up in the repository. One fixed file: the
   * name comes from a constant and never from the request, so the route cannot be asked for a
   * second file and there is no path for it to join wrongly.
   *
   * The headers are set here rather than left to `sendFile`'s extension lookup, so the browser is
   * told the `.xlsx` type and the filename by this code and a test can hold it to both.
   */
  app.get(SAMPLE_PLAYBOOK_DOWNLOAD_PATH, (req, res, next) => {
    sendSampleWorkbook(
      req,
      res,
      next,
      SAMPLE_PLAYBOOK_FILENAME,
      SAMPLE_PLAYBOOK_DIRECTORY,
      SAMPLE_PLAYBOOK_CONTENT_TYPE,
      'Sample playbook',
    );
  });
  app.get(SAMPLE_SIGNAL_DOWNLOAD_PATH, (req, res, next) => {
    sendSampleWorkbook(
      req,
      res,
      next,
      SAMPLE_SIGNAL_FILENAME,
      SAMPLE_SIGNAL_DIRECTORY,
      SAMPLE_PLAYBOOK_CONTENT_TYPE,
      'Sample Signal',
    );
  });
  // Campaign playbook import. The preview is the error report: a workbook that cannot be
  // imported answers 200 with every reason, because an author needs the whole list, not the
  // first failure. Only a malformed *request* is a 400.
  app.post('/api/import/playbook/preview', (req, res, next) => {
    try {
      res.json(previewPlaybook(db, playbookInput.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/import/playbook', (req, res, next) => {
    try {
      const data = playbookInput
        .and(z.object({ fingerprint: z.string().trim().max(128).optional() }))
        .parse(req.body);
      const { receipt, preview } = commitPlaybook(db, data);
      // A refused import is not a server error and not a success: 409 carries the receipt and
      // the preview that explains it, which is exactly what the modal renders either way.
      res.status(receipt.outcome === 'COMMITTED' ? 201 : 409).json({ receipt, preview });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/import/receipts', (_req, res) => res.json(listReceipts(db)));
  app.get('/api/import/receipts/:id', (req, res) => {
    const receipt = getReceipt(db, req.params.id);
    if (!receipt) return res.status(404).json({ error: 'Import receipt not found.' });
    res.json(receipt);
  });
  const signalImportInput = z
    .object({
      filename: z.string().trim().max(255).optional(),
      contentBase64: z.string().max(SIGNAL_IMPORT_CONTENT_BASE64_MAX).optional(),
      text: z.string().max(SIGNAL_IMPORT_TEXT_MAX).optional(),
      fingerprint: z.string().trim().max(128).optional(),
    })
    .refine((value) => Boolean(value.contentBase64) !== Boolean(value.text), {
      message: 'Provide either a workbook file or pasted Signal tabs.',
    });
  app.post('/api/import/signal/preview', async (req, res, next) => {
    try {
      const { fingerprint: _fingerprint, ...input } = signalImportInput.parse(req.body);
      void _fingerprint;
      res.json(await previewSignalImport(db, input, driveMedia()));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/import/signal', async (req, res, next) => {
    try {
      const result = await commitSignalImport(db, signalImportInput.parse(req.body), driveMedia());
      res.status(result.receipt.outcome === 'COMMITTED' ? 201 : 409).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/import/signal/receipts', async (_req, res, next) => {
    try {
      res.json(await listSignalImportReceipts(db));
    } catch (error) {
      next(error);
    }
  });

  /**
   * The calendar: Signal's schedule and task due dates over one range, kept as two lists
   * (FR7, §8.7). Read-only — the provider behind it has no write method, so there is no way to
   * change a schedule through this route, and no counterpart route that would accept one.
   *
   * A schedule that cannot be read answers 200 with the tasks and a reason, not an error: the
   * page is still useful with half of it, and `signal.available` is what the browser renders
   * the difference from.
   */
  app.get('/api/calendar', async (req, res, next) => {
    try {
      const { from, to } = signalRangeQuery.parse(req.query);
      if (from > to) return res.status(400).json({ error: 'The range ends before it starts.' });
      res.json(await readCalendarRange(db, signalProvider(db), from, to));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Signal Campaign's schedule. Signal is authoritative for what is scheduled (decision §5.7),
   * so these routes are the only way it changes and nothing else in the app keeps a second copy.
   *
   * The range read goes through `listPostsInRange` with an explicit lifecycle filter — default
   * active plans — so retired plans stay out of the planner unless asked for. The calendar route
   * above still goes through `SignalProvider`, which is active-only by construction.
   */
  app.get('/api/signal/posts', (req, res, next) => {
    try {
      const query = signalRangeQuery.parse(req.query);
      if (query.from > query.to)
        return res.status(400).json({ error: 'The range ends before it starts.' });
      res.json(
        listPostsInRange(
          db,
          query.from,
          query.to,
          query.lifecycle,
          signalPostFiltersFromQuery(query),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  /**
   * Queue health: what this workspace's own rows say is wrong with it.
   *
   * A read, derived on every request from posts, deliveries, and the record of the last provider
   * synchronisation — there is no alerts table and nothing here writes one. The rules are in
   * `shared/queue-health.ts`; this route gathers and returns.
   *
   * No provider is contacted. Every alert is a conclusion about local rows, which is what makes the
   * summary safe to load with the planner rather than behind a button.
   */
  app.get('/api/signal/health', (_req, res, next) => {
    try {
      res.json(readQueueHealth(db, clock()));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Delivery answers for every planner card in the range, plus the unscheduled queue.
   *
   * One bounded local read of publication and target rows. Opening Signal spends no provider
   * request and no per-card HTTP call — the grid already has the posts; this is the delivery
   * half derived beside them. Nothing here writes a post or a planning status.
   */
  app.get('/api/signal/card-delivery', (req, res, next) => {
    try {
      const query = signalRangeQuery.parse(req.query);
      if (query.from > query.to)
        return res.status(400).json({ error: 'The range ends before it starts.' });
      res.json(readCardDeliveries(db, query.from, query.to, signalPostFiltersFromQuery(query)));
    } catch (error) {
      next(error);
    }
  });
  /** The windows the rules measure against. A partial body moves one and leaves the rest. */
  app.put('/api/signal/health/config', (req, res, next) => {
    try {
      writeQueueHealthConfig(db, queueHealthConfigInput.parse(req.body));
      res.json(readQueueHealth(db, clock()));
    } catch (error) {
      next(error);
    }
  });
  /**
   * *I have seen this*, and nothing more.
   *
   * The write lands in `signal_alert_acks` and touches no post, publication, or target — the
   * acceptance criterion of this card, kept by the module having no statement that could. The
   * acknowledgement records the fingerprint it was shown, so a situation that changes afterwards
   * comes back as a live alert rather than staying dismissed for a problem that has moved.
   */
  app.post('/api/signal/health/alerts/:id/acknowledge', (req, res, next) => {
    try {
      res.json(acknowledgeQueueAlert(db, req.params.id, clock()));
    } catch (error) {
      next(error);
    }
  });
  /** Puts one back on the list. Already absent is the state asked for, so this never refuses. */
  app.delete('/api/signal/health/alerts/:id/acknowledge', (req, res, next) => {
    try {
      res.json(restoreQueueAlert(db, req.params.id, clock()));
    } catch (error) {
      next(error);
    }
  });
  /**
   * What else is in Post Bridge, as the last refresh stored it.
   *
   * A local read: no provider call on any path, so opening the planner spends no provider request
   * and cannot be the thing that discovers an orphan. The rows are whatever somebody's own press of
   * **Refresh inventory** last read.
   */
  app.get('/api/signal/provider-inventory', (_req, res, next) => {
    try {
      res.json(inventory.read());
    } catch (error) {
      next(error);
    }
  });
  /**
   * One person-pressed refresh: read every page, then replace the generation or replace nothing.
   *
   * The only route that lists the provider's posts, and it runs only because somebody pressed
   * something — there is no timer on this path. A failed read is not a `4xx`: it answers with the
   * inventory that is still stored and the reason the refresh replaced none of it, because a panel
   * showing nothing where it should be showing last week's rows would hide the orphan rather than
   * report a failure.
   */
  app.post('/api/signal/provider-inventory/refresh', async (_req, res, next) => {
    try {
      res.json(await inventory.refresh());
    } catch (error) {
      next(error);
    }
  });
  /**
   * Buffer channels as the last complete refresh stored them. A local read only — no Buffer request
   * on any path, so an ordinary Signal page load spends nothing.
   */
  app.get('/api/signal/buffer-accounts', (_req, res, next) => {
    try {
      res.json(bufferAccounts.read());
    } catch (error) {
      next(error);
    }
  });
  /**
   * One person-pressed Buffer account refresh: read organizations and channels, then replace the
   * generation or replace nothing.
   */
  app.post('/api/signal/buffer-accounts/refresh', async (_req, res, next) => {
    try {
      res.json(await bufferAccounts.refresh());
    } catch (error) {
      next(error);
    }
  });
  /**
   * Signal campaigns: the shared vocabulary a post's content belongs to.
   *
   * The same shape task tags and project categories have, one module over, because it is the same
   * kind of thing — a shared list of names attached through a join. Which is what gives this card's
   * criteria their proofs: renaming is one `UPDATE` on the campaign row, so every post carrying it
   * reads the new name; deleting cascades the join rows and touches no post; and the name is unique
   * `COLLATE NOCASE`, so two spellings cannot both exist.
   *
   * A post's own campaigns are written with the post (`PATCH /api/signal/posts/:id`), by name, so the
   * editor saves a whole draft in one press the way it does for channels and media.
   */
  app.get('/api/signal/campaigns', (_req, res, next) => {
    try {
      res.json(listCampaigns(db));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/campaigns', (req, res, next) => {
    try {
      // Typing a name that already exists picks that campaign rather than refusing or duplicating
      // it, which is what makes the chip input safe to type into. `201` is reserved for the case
      // that genuinely created one, so the browser can say which happened.
      const { campaign, created } = createCampaign(db, signalCampaignInput.parse(req.body));
      res.status(created ? 201 : 200).json(campaign);
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/signal/campaigns/:id', (req, res, next) => {
    try {
      res.json(updateCampaign(db, req.params.id, signalCampaignPatch.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/signal/campaigns/:id', (req, res, next) => {
    try {
      const query = z.object({ confirm: z.literal('true').optional() }).parse(req.query);
      const removed = deleteCampaign(db, req.params.id, query.confirm === 'true');
      res.json({ ok: true, deleted: 'signalCampaign', ...removed });
    } catch (error) {
      next(error);
    }
  });
  /**
   * Figures, segmented by campaign, channel, account, and date range.
   *
   * A local read: no provider is contacted on any path through it, so this page costs no
   * synchronisation however often it is opened — the numbers are the ones a person's own **Refresh
   * figures** press already stored against a post. Several campaigns are OR, and so are several
   * channels and several accounts; the three lists are AND against each other. `campaigns=none` is
   * the posts that carry no campaign, which is how **No campaign** is asked for by name.
   *
   * The range asks *which posts*, not *which days*: a post scheduled inside it brings its whole
   * measured history. `shared/signal-campaign-analytics.ts` says why, and does the arithmetic.
   */
  app.get('/api/signal/analytics/campaigns', (req, res, next) => {
    try {
      res.json(readSignalCampaignAnalytics(db, signalCampaignAnalyticsQuery.parse(req.query)));
    } catch (error) {
      next(error);
    }
  });
  /**
   * What the provider reports for one platform over one of its own windows, as the last refresh
   * stored it.
   *
   * A local read: **no provider call on any path, and in particular no `analytics/sync`**. Opening the
   * panel, switching platform, and switching window all come through here, which is the card's own
   * criterion — a window is a cheaper question than the per-delivery figures, and it would not be
   * cheaper if looking at it spent a request.
   */
  app.get('/api/signal/analytics/window', (req, res, next) => {
    try {
      const { platform, timeframe } = analyticsWindowQuery.parse(req.query);
      res.json(analyticsWindow.read(platform, timeframe));
    } catch (error) {
      next(error);
    }
  });
  /**
   * One person-pressed window refresh: read every page, then replace that platform and window or
   * replace nothing.
   *
   * There is no timer on this path. A failed read is not a `4xx`: it answers with the snapshot that is
   * still stored and the reason the refresh replaced none of it, because a panel showing nothing where
   * it should be showing the last complete read would present a failure as an empty window.
   *
   * A window with no dated §14 result is refused here too, before any provider call, and the refusal
   * comes back the same way — the stored snapshot and a sentence saying the window's meaning has not
   * been observed.
   */
  app.post('/api/signal/analytics/window/refresh', async (req, res, next) => {
    try {
      const { platform, timeframe } = analyticsWindowQuery.parse(req.body);
      res.json(await analyticsWindow.refresh(platform, timeframe));
    } catch (error) {
      next(error);
    }
  });
  /** The unscheduled queue — posts with no date, which belong to no range and no calendar cell. */
  app.get('/api/signal/queue', (req, res, next) => {
    try {
      const query = signalQueueQuery.parse(req.query);
      res.json(listQueue(db, query.lifecycle, signalPostFiltersFromQuery(query)));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/posts', async (req, res, next) => {
    try {
      res.status(201).json(await createPost(db, signalPostInput.parse(req.body), driveMedia()));
    } catch (error) {
      next(error);
    }
  });
  /**
   * What one pasted Drive link resolves to, and nothing else.
   *
   * The composer calls this so a person sees the file they are about to bind to before they save,
   * and the answer is metadata: name, type, size, the canonical viewer link, and the version
   * fingerprint this app will record. **No bytes, no Drive token, and no file-read endpoint** — the
   * only thing this route can do with an id is describe it, and the only way to give it an id is to
   * paste a link it agrees is a Drive file link.
   *
   * A refusal is a 400 carrying the specific reason: a folder, a shortcut that resolves to nothing,
   * a Google-native document, an unsupported type, a size Drive will not report, or a file past the
   * limit each say so by name. Saving the post resolves again through the same rule, so nothing
   * here is trusted on the way back in.
   */
  app.post('/api/signal/drive-media/resolve', async (req, res, next) => {
    try {
      const { link } = z.object({ link: z.string().min(1).max(2048) }).parse(req.body);
      res.json(await resolveDriveMedia({ link, provider: driveMedia() }));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Resolve the files in one project-owned Drive folder. This is deliberately a separate route:
   * the single-file route continues to refuse folder links, while this route gets its scope from
   * the project and its recorded Drive step folders.
   */
  app.post('/api/signal/drive-media/resolve-batch', async (req, res, next) => {
    try {
      const data = z
        .object({
          projectId: z.string().uuid(),
          folderId: z.string().trim().min(5).max(200).optional(),
        })
        .parse(req.body);
      const result = await resolveDriveMediaBatch({
        db,
        ...data,
        provider: options.drive ? options.drive(db) : driveProvider(db),
        mediaProvider: driveMedia(),
      });
      res.status(result.outcome === 'REFUSED' ? 400 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/signal/posts/:id', (req, res) => {
    const post = getPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Signal post not found.' });
    res.json(post);
  });
  /**
   * Platform and account content overrides for one post.
   *
   * `PUT` replaces the whole set, the way branding does and for the same reason: the composer holds
   * every layer while it is edited, and a patch would let a half-applied set leave a platform
   * tailored by a request that was reported as having failed. What the provider will accept is
   * checked here from `shared/publish-variants.ts` — the same function the composer renders its
   * fields from — so a field the form hides is a field this route refuses rather than one a `curl`
   * walks around.
   */
  app.get('/api/signal/posts/:id/variants', (req, res, next) => {
    try {
      res.json(getPostVariants(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.put('/api/signal/posts/:id/variants', async (req, res, next) => {
    try {
      const revision = revisionPrecondition.parse(req.body?.revision);
      // Asynchronous since C76: a layer may carry a cover image or a thumbnail, and a Drive-backed
      // one has to be resolved through the media capability before it can be stored. A set whose
      // roles are all public URLs, or which has none, still contacts nothing.
      res.json(
        await replacePostVariants(
          db,
          req.params.id,
          signalVariantsInput.parse(req.body),
          driveMedia(),
          new Set(),
          revision,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  /**
   * Which provider accounts a person explicitly chose for each Signal channel (C77).
   *
   * An empty answer is the ordinary case and is not the same as choosing nothing: it means no
   * explicit selection exists and every channel resolves the way §3.1 has always resolved it, to
   * exactly one account, refusing zero or several.
   */
  app.get('/api/signal/posts/:id/publish-targets', (req, res, next) => {
    try {
      res.json(getPostPublishTargets(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Replace that selection, validated against the account list the preview was built from.
   *
   * The provider list is read here and handed to the service rather than fetched inside it, so the
   * refusals are about accounts the user could actually have seen. A provider that cannot be
   * reached refuses the write instead of accepting a selection nothing has checked — saving a
   * target against an unknown account list is how a stale id survives to a submit.
   *
   * Like every Signal write, it records no `integration_events` row: this is local data, and the
   * log is for what an integration did.
   */
  app.put('/api/signal/posts/:id/publish-targets', async (req, res, next) => {
    try {
      const revision = revisionPrecondition.parse(req.body?.revision);
      res.json(
        replacePostPublishTargets(
          db,
          req.params.id,
          signalPublishTargetsInput.parse(req.body),
          await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock),
          clock,
          revision,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  /**
   * Check one layer's cover image or thumbnail against Drive again, because a person asked.
   *
   * The role counterpart of `POST /api/signal/posts/:id/media/recheck`, and it keeps that route's
   * two properties: it is the only way a stored role fingerprint is replaced, and it writes through
   * the ordinary variant replacement, so the post's `updated_at` moves — and an open publish
   * confirmation goes stale — exactly when the file's version actually changed.
   *
   * A failure answers 400 and writes nothing: the role keeps the metadata it had.
   */
  app.post('/api/signal/posts/:id/variants/media/recheck', async (req, res, next) => {
    try {
      res.json(
        await recheckVariantMedia(
          db,
          req.params.id,
          signalVariantMediaRecheckInput.parse(req.body),
          driveMedia(),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  /**
   * Duplicate copies composition into the unscheduled queue and leaves publication rows on the
   * original. The copy is a new plan: new id, no date, draft status.
   */
  app.post('/api/signal/posts/:id/duplicate', (req, res, next) => {
    try {
      res.status(201).json(duplicatePost(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Next free cell at this post's time, from the Signal schedule. Nothing is written; the
   * planner shows it until the user confirms.
   */
  app.get('/api/signal/posts/:id/next-slot', (req, res, next) => {
    try {
      const { from } = signalSlotFromQuery.parse(req.query);
      res.json(suggestPostSlot(db, req.params.id, from));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Confirm a suggested slot. Occupancy is recalculated here, immediately before the write, so
   * a cell taken between suggestion and confirmation is refused rather than double-booked.
   */
  app.post('/api/signal/posts/:id/slot', (req, res, next) => {
    try {
      const revision = revisionPrecondition.parse(req.body?.revision);
      res.json(
        applyPostSlotWithRevision(db, req.params.id, signalSlotInput.parse(req.body), revision),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/posts/:id/publish/preview', async (req, res, next) => {
    try {
      const listed = await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock);
      res.json(await publisher.preview(req.params.id, listed));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/posts/:id/publish-now/preview', async (req, res, next) => {
    try {
      const listed = await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock);
      res.json(await publisher.previewNow(req.params.id, listed));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/posts/:id/publish', async (req, res, next) => {
    try {
      const input = z.object({ planHash: z.string().length(64) }).parse(req.body);
      const listed = await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock);
      res.status(201).json(await publisher.submit(req.params.id, input.planHash, listed));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/posts/:id/publish-now', async (req, res, next) => {
    try {
      const input = z.object({ planHash: z.string().length(64) }).parse(req.body);
      const listed = await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock);
      res.status(201).json(await publisher.submitNow(req.params.id, input.planHash, listed));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/signal/posts/:id/publications', (req, res, next) => {
    try {
      res.json(publisher.list(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /**
   * A provider check. `automatic` marks the planner's own timer, which is held to the widening
   * schedule and answered from storage when it is not due; the default is a person pressing
   * refresh, which always runs.
   */
  app.post('/api/signal/publications/:id/reconcile', async (req, res, next) => {
    try {
      const input = z.object({ automatic: z.boolean().default(false) }).parse(req.body ?? {});
      res.json(await publisher.reconcile(req.params.id, { automatic: input.automatic }));
    } catch (error) {
      next(error);
    }
  });
  /**
   * The no-write comparison between Signal and the post the provider is holding.
   *
   * `POST` rather than `GET` because it reaches the provider — the same reason the publishing
   * preview is a `POST` — but it writes nothing on either side, locally or remotely, and there is
   * no route here that mutates the provider without a token taken from this one first.
   */
  app.post('/api/signal/publications/:id/provider/preview', async (req, res, next) => {
    try {
      res.json(await publisher.providerPreview(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Commit one action against the provider's copy. `reconcileHash` is the token the preview
   * returned, covering both the plan and the provider's record, and the service rebuilds the
   * comparison and refuses anything that has moved since.
   */
  app.post('/api/signal/publications/:id/provider/apply', async (req, res, next) => {
    try {
      const input = z
        .object({
          action: z.enum(PROVIDER_ACTIONS),
          reconcileHash: z.string().length(64),
        })
        .parse(req.body);
      res.json(
        await publisher.applyProviderAction(req.params.id, input.action, input.reconcileHash),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(
    '/api/signal/publications/:id/targets/:accountId/provider/preview',
    async (req, res, next) => {
      try {
        const accountId = z.coerce.number().int().positive().parse(req.params.accountId);
        const listed = await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock);
        res.json(await publisher.bufferTargetPreview(req.params.id, accountId, listed));
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    '/api/signal/publications/:id/targets/:accountId/provider/apply',
    async (req, res, next) => {
      try {
        const accountId = z.coerce.number().int().positive().parse(req.params.accountId);
        const input = z
          .object({ action: z.enum(PROVIDER_ACTIONS), reconcileHash: z.string().length(64) })
          .parse(req.body);
        const listed = await resolvePublishingTargets(db, publishProvider, bufferAccounts, clock);
        res.json(
          await publisher.applyBufferTargetAction(
            req.params.id,
            accountId,
            input.action,
            input.reconcileHash,
            listed,
          ),
        );
      } catch (error) {
        next(error);
      }
    },
  );
  /**
   * The figures stored against one post's deliveries. A local read: no provider call on any path.
   *
   * A `GET`, and the planner asks for it when a post is opened, which is deliberately not a refresh —
   * nothing here reaches Post Bridge, so opening a post cannot spend a synchronisation. The card puts
   * automatic refresh on page load explicitly out of scope, and this is how that stays true while the
   * figures somebody already fetched are still on screen.
   */
  app.get('/api/signal/posts/:id/metrics', (req, res, next) => {
    try {
      res.json(analytics.read(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /**
   * One on-demand refresh: sync the provider's figures, read them back, store what came back.
   *
   * The only route in this app that reaches the analytics endpoints, and it runs only because a
   * person pressed something. A refusal is not an error response — it answers with the stored figures
   * and the reason, because a failed refresh that returned a `4xx` would leave the panel showing
   * nothing where it should be showing the last known good values.
   */
  app.post('/api/signal/posts/:id/metrics/refresh', async (req, res, next) => {
    try {
      res.json(await analytics.refresh(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /** A person recording that they finished one delivery in the application that owns it. */
  app.post('/api/signal/publications/:id/targets/:accountId/finish', (req, res, next) => {
    try {
      const accountId = z.coerce.number().int().parse(req.params.accountId);
      res.json(publisher.markTargetFinished(req.params.id, accountId));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/signal/posts/:id', async (req, res, next) => {
    try {
      const revision = revisionPrecondition.parse(req.body?.revision);
      res.json(
        await updatePostWithRevision(
          db,
          req.params.id,
          signalPostPatch.parse(req.body),
          revision,
          driveMedia(),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  /**
   * Check one of this post's Drive references against Drive again, because a person asked.
   *
   * The only route that replaces a stored fingerprint. It goes through the ordinary Signal edit
   * transaction, so the post's `updated_at` moves and an open publish preview stops matching — a
   * file whose content changed must not be sent under a plan that was approved before it did.
   *
   * A failure answers 400 and writes nothing: the reference keeps the metadata it had, and the
   * composer shows the reason beside it rather than dropping the media.
   */
  app.post('/api/signal/posts/:id/media/recheck', async (req, res, next) => {
    try {
      const { driveFileId } = z.object({ driveFileId: z.string().min(1).max(200) }).parse(req.body);
      res.json(await recheckPostMedia(db, req.params.id, driveFileId, driveMedia()));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Retire a local Signal plan: hide it from ordinary planning views, keep the row and every
   * linked publication / target / metric. Does not withdraw a provider submission and does not
   * unpublish platform content (`docs/published-deletion-decision.md`).
   */
  app.post('/api/signal/posts/:id/retire', (req, res, next) => {
    try {
      res.json(retirePost(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  /**
   * Hard-delete a plan that has never had a publication row. Posts with publication history must
   * be retired instead. Never calls the provider — withdraw stays on the reconcile panel alone.
   */
  app.delete('/api/signal/posts/:id', (req, res, next) => {
    try {
      deletePost(db, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The integration activity log, read-only by construction: this is the only route that
   * touches `integration_events`, and there is no route that writes, edits, or deletes one.
   * Rows arrive from the services that do the work — the importer today, a calendar sync
   * later — never from the browser.
   */
  app.get('/api/integrations/activity', (req, res, next) => {
    try {
      const query = z
        .object({
          source: z.enum(INTEGRATION_SOURCES).optional(),
          correlationId: z.string().trim().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(INTEGRATION_EVENT_PAGE_MAX).optional(),
        })
        .parse(req.query);
      res.json(listIntegrationEvents(db, query));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Agent handoff queue (C110/C112): operator HTTP over the same service MCP uses.
   *
   * Agents normally post/claim/complete via MCP. The operator inbox lists, opens, and cancels;
   * POST exists so operators and e2e can seed the queue without an MCP session. Never mutates
   * workspace rows, and never writes `integration_events`.
   */
  app.get('/api/agent-handoffs', (req, res, next) => {
    try {
      const query = z
        .object({
          state: z.enum(AGENT_HANDOFF_STATES).optional(),
          limit: z.coerce.number().int().min(1).max(AGENT_HANDOFF_LIST_MAX_LIMIT).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.query);
      res.json(listHandoffs(db, query));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agents/directory', (_req, res) => {
    res.json({ agents: listAgentDirectory(db, clock().getTime()) });
  });
  app.get('/api/agents/presence', (req, res, next) => {
    try {
      res.json(listPresence(db, req.query));
    } catch (error) {
      next(error);
    }
  });
  app.put('/api/agents/:label/presence', (req, res, next) => {
    try {
      res.json(setPresence(db, req.params.label, req.body, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agents/:label/presence', (req, res, next) => {
    try {
      res.json(getPresence(db, req.params.label));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-summaries', (req, res, next) => {
    try {
      res.json(listSummaries(db, req.query, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-notifications', (req, res, next) => {
    try {
      res.json(listNotifications(db, req.query));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-notifications', (req, res, next) => {
    try {
      res.status(201).json(notify(db, req.body, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-notifications/:id/read', (req, res, next) => {
    try {
      res.json(markNotificationRead(db, req.params.id, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-memory', (req, res, next) => {
    try {
      res.json(listMemory(db, agentMemoryListSchema.parse(req.query)));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-memory/suggestions', (req, res, next) => {
    try {
      const { suggestedBy, ...input } = req.body ?? {};
      res.status(201).json(suggestMemory(db, input, String(suggestedBy ?? 'agent'), clock()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-memory/:id', (req, res, next) => {
    try {
      res.json(getMemory(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/agent-memory/:id', (req, res, next) => {
    try {
      res.json(correctMemory(db, req.params.id, req.body, 'operator', clock()));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-memory/:id/archive', (req, res, next) => {
    try {
      res.json(archiveMemory(db, req.params.id, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/agent-memory/:id', (req, res, next) => {
    try {
      deleteMemory(db, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });
  // Conversations are informational metadata. The authenticated MCP/session identity is the
  // sender; clients cannot supply an author and these routes never mutate workspace state.
  app.get('/api/agent-conversations', (req, res, next) => {
    try {
      res.json(
        listConversations(
          db,
          null,
          conversationListSchema.parse({
            ...req.query,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
            direction: req.query.direction === 'before' ? 'before' : 'forward',
          }),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-conversations', (req, res, next) => {
    try {
      res
        .status(201)
        .json(
          createConversation(db, createConversationSchema.parse(req.body), 'operator', clock()),
        );
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-conversations/:id', (req, res, next) => {
    try {
      res.json(getConversation(db, req.params.id, null));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-conversations/:id/messages', (req, res, next) => {
    try {
      res.json(
        listMessages(
          db,
          req.params.id,
          null,
          messageListSchema.parse({
            ...req.query,
            limit: req.query.limit ? Number(req.query.limit) : undefined,
          }),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-conversations/:id/messages', (req, res, next) => {
    try {
      res.status(201).json(postMessage(db, req.params.id, 'operator', req.body?.body, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-conversations/:id/archive', (req, res, next) => {
    try {
      res.json(setConversationState(db, req.params.id, 'operator', 'ARCHIVED', clock()));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-handoffs', (req, res, next) => {
    try {
      const body = agentHandoffPostInputSchema.parse(req.body);
      res.status(201).json(postHandoff(db, body, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-handoffs/:id', (req, res, next) => {
    try {
      res.json(getHandoff(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-handoffs/:id/cancel', (req, res, next) => {
    try {
      const body = agentHandoffCancelInputSchema.parse(req.body);
      res.json(cancelHandoffAsOperator(db, req.params.id, body, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agent-work-sessions', (req, res, next) => {
    try {
      res.json(reclaimableWorkSessions(db, clock()));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agent-work-sessions/:id/reclaim', (req, res, next) => {
    try {
      const reason = z
        .object({ reason: z.string().trim().min(1).max(500).optional() })
        .parse(req.body ?? {});
      res.json(reclaimWorkSession(db, req.params.id, reason.reason, clock()));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/drive/sync', async (req, res, next) => {
    try {
      res.json(await syncAllToDrive(db));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/settings/drive', (_req, res) =>
    res.json({
      configured: driveConfigured(),
      pickerConfigured: drivePickerConfigured(),
      connected: driveProvider(db).connected,
      rootFolderId: getSetting(db, 'drive_root_id'),
      rootFolderUrl: getSetting(db, 'drive_root_url'),
      // Browser-facing Picker config only — never access or refresh tokens.
      picker: drivePickerConfigured()
        ? {
            clientId: config.google.clientId,
            apiKey: config.google.apiKey,
            appId: config.google.appId,
            scope: DRIVE_OAUTH_SCOPE,
          }
        : null,
    }),
  );
  app.get('/api/drive/oauth/start', (req, res, next) => {
    try {
      if (!config.google.clientId || !config.google.clientSecret || !config.google.encryptionKey)
        throw new Error('Add Google OAuth credentials and an encryption key to .env first.');
      const session = (req as AuthedRequest).operatorSession;
      if (authRequired && !session) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }
      const { state, challenge } = beginAuthorization(db, clock(), {
        sessionTokenHash: session?.tokenHash ?? null,
      });
      res.json({ url: oauthClient(config.google).authorizationUrl({ state, challenge }) });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/drive/oauth/callback', async (req, res, next) => {
    try {
      /**
       * The state is consumed before anything is exchanged, so this request is the only one
       * that can ever use it. Every refusal answers the same way it always has — a bare 400
       * that names nothing — while the reason goes to the log, where the operator can see it
       * and the caller cannot.
       */
      let verifier: string;
      try {
        const session = (req as AuthedRequest).operatorSession;
        ({ verifier } = consumeAuthorization(db, req.query.state, clock(), {
          sessionTokenHash: session?.tokenHash ?? null,
        }));
      } catch (error) {
        if (!(error instanceof OAuthStateError)) throw error;
        req.log.warn({ reason: error.name }, 'Rejected a Drive OAuth callback');
        return res.status(400).send('Invalid OAuth state.');
      }
      const code = z.string().min(1).max(2048).parse(req.query.code);
      const tokens = await oauthClient(config.google).exchange({ code, verifier });
      setSetting(db, 'google_tokens', encryptJson(tokens, config.google.encryptionKey));
      res.redirect(`${config.appOrigin}/settings?drive=connected`);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/settings/drive/root', async (req, res, next) => {
    try {
      // Picker returns a stable Drive folder id. URLs are still accepted for reconnect aids,
      // but selection in Settings goes through Picker so drive.file can attach the folder.
      const data = z.object({ folderId: z.string().trim().min(5).max(200) }).parse(req.body);
      const folderId = parseFolderId(data.folderId);
      if (!/^[a-zA-Z0-9_-]+$/.test(folderId)) {
        throw new Error('Choose a folder with Google Picker, or paste a Drive folder id.');
      }
      const folder = await driveProvider(db).getFolder(folderId);
      setSetting(db, 'drive_root_id', folder.id);
      setSetting(db, 'drive_root_url', folder.url);
      res.json({ rootFolderId: folder.id, rootFolderUrl: folder.url });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/settings/drive/disconnect', (_req, res) => {
    db.prepare(
      "DELETE FROM settings WHERE key IN ('google_tokens','drive_root_id','drive_root_url')",
    ).run();
    res.json({
      ok: true,
      googleRevocationRequired: true,
      googlePermissionsUrl: 'https://myaccount.google.com/permissions',
    });
  });

  /**
   * The API's own 404, registered last among the API routes and therefore ahead of anything
   * mounted after `createApp` — `server/index.ts` serves the built client from there. Without
   * it, `/api/typo` fell through every route, past the error handler (which only runs on
   * `next(error)`), and into `index.html` with a 200, so a client-side typo surfaced as a JSON
   * parse error rather than as the 404 it is.
   */
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    void next;
    /**
     * A body over the parser's limit is the caller's problem as much as an unreadable one is, and
     * body-parser reports it by rejecting before any route runs. Without this branch it reached
     * the 500 below, so the answer to an oversized upload was "something went wrong" and an error
     * ID — which reads as a defect in the app rather than as the limit it is.
     */
    if (error?.type === 'entity.too.large')
      return res.status(413).json({ error: 'That request body is too large.' });
    // An unreadable upload is the caller's problem, not a 500: the message already says
    // what to do about it, and the import modal shows it verbatim.
    const status =
      error instanceof z.ZodError ||
      error instanceof ImportInputError ||
      error instanceof DriveScopeError ||
      error instanceof DriveWriteConfirmationError ||
      // An override the capability contract will not carry is the caller naming something the
      // provider cannot do, which is their problem to fix and not a failure of the write.
      error instanceof SignalVariantError ||
      // A target the provider's current account list does not support: disconnected, on another
      // platform, or on a channel the provider cannot reach. The account list moved under a
      // preview that was taken before it did, so the fix is a new preview rather than a retry.
      error instanceof SignalPublishTargetError ||
      // A link that is not a Drive file link, or a file this app will not bind a reference to.
      // Both carry the specific reason and both are answered rather than logged as a fault: the
      // person pasted something, and what to paste instead is the whole content of the message.
      error instanceof DriveMediaError ||
      error instanceof SignalMediaError ||
      error instanceof WorkspaceValidationError
        ? 400
        : // Editing or deleting a post that is not there is the caller addressing something
          // that does not exist, not a failure of the write.
          error instanceof SignalPostNotFoundError ||
            error instanceof SignalPostRelationshipError ||
            // Acknowledging an alert that is not in the summary is the same kind of miss: the
            // summary is derived, so an id with nothing behind it names a fact that has moved on.
            error instanceof QueueAlertNotFoundError ||
            error instanceof SignalCampaignNotFoundError ||
            error instanceof WorkspaceNotFoundError
          ? 404
          : // A refused merge is the caller's problem — the wrong pair, or a preview the
            // workspace moved out from under — and each case carries its own status. A slot
            // that is no longer free is the same kind of refusal.
            error instanceof PublishRequestError ||
              error instanceof ClientMergeError ||
              error instanceof AgentCoordinationError ||
              error instanceof RevisionConflictError ||
              error instanceof SignalSlotConflictError ||
              error instanceof SignalPostProtectedError ||
              error instanceof WorkspaceConflictError
            ? error.status
            : // A rename onto a name another campaign holds, and a deletion that would detach
              // posts before the caller has confirmed it: both are the same *this needs an answer
              // first* that tags and categories already answer with a 409 and a code.
              error instanceof SignalCampaignNameTakenError ||
                error instanceof SignalCampaignInUseError ||
                error instanceof McpAgentLabelTakenError ||
                error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
              ? 409
              : // Simple "this id does not exist" refusals across the app throw a plain Error
                // tagged with `status` (agent conversations, agent memory, agent summaries)
                // rather than a dedicated class each. Read that tag as a last resort, after
                // every specific class above has had a chance to claim the error.
                typeof error?.status === 'number' && error.status >= 400 && error.status < 500
                ? error.status
                : 500;
    /**
     * A 500 is the one status whose message has no reader who benefits: it is whatever SQLite
     * or googleapis said, which means table names, absolute paths, and provider detail going
     * to the browser. The detail goes to the log instead, against an ID the response carries,
     * so a user reporting "something went wrong" can still be traced to the actual error.
     */
    if (status === 500) {
      const errorId = id();
      req.log.error({ err: error, errorId }, 'Unhandled request error');
      return res.status(500).json({ error: SERVER_ERROR_MESSAGE, errorId });
    }
    res.status(status).json({
      error:
        error instanceof z.ZodError
          ? error.issues[0]?.message
          : error instanceof Error
            ? error.message
            : 'Unexpected error',
      ...(error instanceof SignalSlotConflictError
        ? {
            code: error.suggestion ? 'SLOT_TAKEN' : 'NO_OPEN_SLOT',
            suggestion: error.suggestion,
          }
        : {}),
      ...(error instanceof SignalCampaignNameTakenError
        ? { code: 'SIGNAL_CAMPAIGN_NAME_TAKEN' }
        : {}),
      // The count travels with the refusal so the confirmation can name what is about to be
      // detached, which is the only thing that makes confirming it a decision.
      ...(error instanceof SignalCampaignInUseError
        ? { code: 'SIGNAL_CAMPAIGN_IN_USE', attachedPostCount: error.attachedPostCount }
        : {}),
      ...(error instanceof RevisionConflictError
        ? {
            code: error.code,
            currentRevision: error.currentRevision,
            changedFields: error.changedFields,
          }
        : {}),
      ...(error instanceof WorkspaceConflictError
        ? {
            code: error.code,
            ...(error.blockingDependencies
              ? { blockingDependencies: error.blockingDependencies }
              : {}),
          }
        : {}),
      ...(error instanceof McpAgentLabelTakenError ? { code: 'MCP_AGENT_LABEL_TAKEN' } : {}),
    });
  });
  return app;
}

function parseFolderId(value: string) {
  const match = value.match(/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] || value;
}
