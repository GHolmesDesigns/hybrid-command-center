import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp, { stdSerializers } from 'pino-http';
import type { DestinationStream } from 'pino';
import { isValid, parseISO } from 'date-fns';
import { z } from 'zod';
import type { Db } from './db.ts';
import { getDb, transaction } from './db.ts';
import { config } from './config.ts';
import {
  getCategory,
  getTag,
  getTask,
  listActiveTasks,
  listCategories,
  listClients,
  listProjects,
  listTags,
  listTasks,
} from './repositories.ts';
import { touchProjectActivity, touchProjectRecord } from './domain/activity.ts';
import { wouldCreateCycle, blockingDependencies } from './domain/dependencies.ts';
import { isDueNextSevenDays, isDueToday, isOverdue } from '../shared/deadlines.ts';
import { buildClientSlug } from './domain/client-slugs.ts';
import {
  driveProvider,
  getSetting,
  provisionClient,
  provisionProject,
  setSetting,
  syncAllToDrive,
} from './drive/service.ts';
import { DriveScopeError, driveConfigured, listProjectFiles } from './drive/browse.ts';
import { signalProvider } from './signal/read.ts';
import { readCalendarRange } from './calendar.ts';
import {
  SignalPostNotFoundError,
  createPost,
  deletePost,
  getPost,
  listQueue,
  signalPostInput,
  signalPostPatch,
  signalRangeQuery,
  updatePost,
} from './signal/service.ts';
import type { DriveProvider } from './drive/provider.ts';
import {
  OAuthStateError,
  beginAuthorization,
  consumeAuthorization,
  createGoogleOAuthClient,
  type OAuthAuthorizationClient,
  type OAuthCredentials,
} from './drive/oauth.ts';
import { encryptJson } from './drive/tokens.ts';
import { DRIVE_PAGE_SIZE, DRIVE_PAGE_SIZE_MAX } from '../shared/drive.ts';
import {
  ImportInputError,
  commitPlaybook,
  getReceipt,
  listReceipts,
  playbookInput,
  previewPlaybook,
} from './import.ts';
import { listIntegrationEvents } from './integration-log.ts';
import { INTEGRATION_EVENT_PAGE_MAX, INTEGRATION_SOURCES } from '../shared/integration-log.ts';
import {
  APP_VERSION,
  BRANDING_SETTING_KEY,
  DEFAULT_BRANDING,
  LOGO_URL_MAX,
  brandingIssues,
  type Branding,
} from '../shared/branding.ts';
import { normalizeHex } from '../shared/contrast.ts';
import {
  TASK_CHECKLIST_TEMPLATES,
  TASK_STATUSES,
  TASK_TYPES,
  compareProjectActivity,
  normalizeCategoryName,
  normalizeTagName,
  type Project,
} from '../shared/types.ts';

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
    connectSrc: ["'self'"],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'none'"],
    // `https:` is what makes a Settings-supplied logo load. Branding references a logo by
    // address rather than storing an uploaded file (README, "Sidebar branding"), so the
    // policy has to permit the host the user names, and the host is not known in advance.
    // Only images widen: no other directive accepts a remote origin.
    imgSrc: ["'self'", 'data:', 'https:'],
    manifestSrc: ["'self'"],
    mediaSrc: ["'self'"],
    objectSrc: ["'none'"],
    scriptSrc: ["'self'"],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", 'https://fonts.googleapis.com'],
    styleSrcAttr: ["'unsafe-inline'"],
    workerSrc: ["'self'"],
    // The production app is intentionally served over loopback HTTP by default.
    upgradeInsecureRequests: null,
  },
} as const;

export type AppOptions = {
  production?: boolean;
  /**
   * The Drive provider the read-only browsing routes use. Tests supply a mock one so a
   * listing can be exercised without credentials and without contacting real Drive; in
   * every other case this resolves to the encrypted-token provider as usual.
   */
  drive?: (db: Db) => DriveProvider;
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

/** Query strings carry the authorization code, so the path is all a request log keeps. */
const pathOnly = (url: string | undefined) => (url ?? '').split('?')[0];

/**
 * The request logger.
 *
 * Registered with no options, `pinoHttp()` logs the request's query string and its full header
 * set — so every Drive connect wrote a live `code=4/0A…` to stdout, the one place
 * `redactSecrets` cannot reach because it never sees the request. Three things fix that: the
 * level comes from `LOG_LEVEL`, so the variable `.env.example` documents is the one in use; the
 * two credential-bearing headers are redacted; and the request is serialized down to fields
 * that cannot carry a query.
 *
 * The serializer names the fields it keeps rather than deleting the ones it does not, because
 * the query reaches the log by more than one route — `url` carries it as text and pino-http
 * parses it again into `query` — and an allowlist is what keeps a field added by a future
 * version of the serializer from quietly putting it back a third way.
 */
function requestLogger(stream?: DestinationStream) {
  return pinoHttp(
    {
      level: config.logLevel,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie'],
        censor: '[redacted]',
      },
      serializers: {
        req(request) {
          const { id, method, url, headers, remoteAddress, remotePort } =
            stdSerializers.req(request);
          return { id, method, url: pathOnly(url), headers, remoteAddress, remotePort };
        },
      },
    },
    stream,
  );
}

/**
 * Optional text field. An omitted key stays `undefined` so a PATCH keeps the stored
 * value; an empty string becomes `null` so the caller can deliberately clear it.
 */
const nullable = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
const nullableEmail = z
  .union([z.literal(''), z.string().email()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
const nullableUrl = z
  .union([z.literal(''), z.string().url()])
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
/**
 * Optional calendar date. User-supplied dates are `YYYY-MM-DD` values interpreted in local
 * time, so the pattern is checked first and `isValid` then rejects real-looking impossibilities
 * such as `2026-02-30`. Without both, junk reaches `shared/deadlines.ts`, where
 * `parseISO` yields an `Invalid Date` and every deadline rule silently answers `false`.
 * Server-generated timestamps (`created_at`, `updated_at`, `completed_at`) are full ISO
 * strings and never pass through here.
 */
const nullableDate = z
  .union([
    z.literal(''),
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
      .refine((v) => isValid(parseISO(v)), 'Not a real calendar date'),
  ])
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
/**
 * Optional task type. The form posts `''` for the "No type" option, so the empty string
 * is accepted and stored as NULL, the same shape the other optional fields use. Anything
 * outside the vocabulary is rejected with a 400 rather than written through.
 */
const nullableTaskType = z
  .union([z.literal(''), z.enum(TASK_TYPES)])
  .optional()
  .transform((v) => (v === undefined ? undefined : v || null));
/** Resolve one PATCH field: an omitted key keeps the stored value, `null` clears it. */
const patch = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETE'] as const;

const clientFields = {
  name: z.string().trim().min(2).max(120),
  contactName: nullable,
  email: nullableEmail,
  phone: nullable,
  website: nullableUrl,
  notes: nullable,
};
const clientInput = z.object(clientFields);
const clientPatch = z.object(clientFields).partial();

// PATCH schemas deliberately drop the `.default()` calls. `.partial()` still applies a
// default when the key is absent, so sharing the create schema would silently reset
// status and priority on any PATCH that did not name them.
const projectFields = {
  clientId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  description: nullable,
  startDate: nullableDate,
  targetDeadline: nullableDate,
  notes: nullable,
};
const projectInput = z.object({
  ...projectFields,
  status: z.enum(PROJECT_STATUSES).default('ACTIVE'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
});
const projectPatch = z
  .object({ ...projectFields, status: z.enum(PROJECT_STATUSES), priority: z.enum(PRIORITIES) })
  .partial();

// `taskType` belongs here rather than on `taskInput`: it carries no `.default()`, so
// `.partial()` leaves it absent on a PATCH that omits it and the stored type survives.
const taskFields = {
  projectId: z.string().uuid(),
  title: z.string().trim().min(2).max(200),
  description: nullable,
  taskType: nullableTaskType,
  dueDate: nullableDate,
  startDate: nullableDate,
  notes: nullable,
};
const taskInput = z.object({
  ...taskFields,
  status: z.enum(TASK_STATUSES).default('BACKLOG'),
  priority: z.enum(PRIORITIES).default('MEDIUM'),
});
const taskPatch = z
  .object({ ...taskFields, status: z.enum(TASK_STATUSES), priority: z.enum(PRIORITIES) })
  .partial();

/**
 * A `#rrggbb` colour, accepting `#RGB` and uppercase on the way in and storing one shape.
 * Colours and logo fields carry defaults because this is a PUT of the whole resource: a
 * payload that names only the text fields — the shape every client sent before colours
 * existed — replaces the branding with the default palette rather than being refused.
 */
const hexColor = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .transform((value) => normalizeHex(value) ?? value)
    .pipe(z.string().regex(/^#[0-9a-f]{6}$/, 'Expected a hex colour such as #18201d'));

/**
 * Contrast is enforced here, not only in the form, so no client can store a sidebar its
 * own text cannot be read against (issue #71). `brandingIssues()` is the same function the
 * Settings form warns with, so the two cannot disagree about what is allowed.
 */
const brandingInput = z
  .object({
    mark: z.string().trim().min(1).max(4),
    title: z.string().trim().min(1).max(40),
    subtitle: z.string().trim().min(1).max(60),
    tagline: z.string().trim().min(1).max(80),
    background: hexColor(DEFAULT_BRANDING.background),
    foreground: hexColor(DEFAULT_BRANDING.foreground),
    accent: hexColor(DEFAULT_BRANDING.accent),
    logoUrl: z.string().trim().max(LOGO_URL_MAX).default(''),
    logoAlt: z.string().trim().max(120).default(''),
  })
  // Alt text describes a logo, so without one there is nothing for it to describe.
  .transform((branding) => ({ ...branding, logoAlt: branding.logoUrl ? branding.logoAlt : '' }))
  .superRefine((branding, ctx) => {
    for (const issue of brandingIssues(branding))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [issue.field], message: issue.message });
  });

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
const categoryInput = z.object({ name: normalizedCategoryName, color: chipColor });
const categoryPatch = categoryInput.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide a category field to update.',
});

export function createApp(db: Db = getDb(), options: AppOptions = {}) {
  const app = express();
  const production = options.production ?? isProductionRuntime();
  const clock = options.now ?? (() => new Date());
  const oauthClient = options.oauth ?? createGoogleOAuthClient;
  app.use(
    helmet({
      // Vite's development client needs a relaxed policy for HMR. The built client does not.
      contentSecurityPolicy: production ? productionContentSecurityPolicy : false,
    }),
  );
  app.use(cors({ origin: config.appOrigin }));
  /**
   * An uploaded workbook is base64 in a JSON body — the committed sample playbook alone is 86 KB
   * — so the import routes get a larger limit rather than raising it for every endpoint that
   * only ever carries a form. The Zod schema caps the field itself.
   *
   * Registered *before* the 1 MB parser deliberately: whichever parser runs first is the one
   * that reads the body and the one whose limit applies, and middleware runs in registration
   * order regardless of where the route is declared. Behind it, the general parser sees a body
   * that is already read and passes it through.
   */
  app.use('/api/import', express.json({ limit: '16mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(requestLogger(options.logStream));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  app.get('/api/clients', (_req, res) => res.json(listClients(db)));
  app.post('/api/clients', async (req, res, next) => {
    try {
      const data = clientInput.parse(req.body);
      const clientId = id();
      const stamp = now();
      db.prepare(
        `INSERT INTO clients(id,name,slug,contact_name,email,phone,website,notes,drive_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        clientId,
        data.name,
        buildClientSlug(data.name, clientId),
        data.contactName ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.website ?? null,
        data.notes ?? null,
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
      const current = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.id) as any;
      if (!current) return res.status(404).json({ error: 'Client not found.' });
      db.prepare(
        `UPDATE clients SET name=?,slug=?,contact_name=?,email=?,phone=?,website=?,notes=?,updated_at=? WHERE id=?`,
      ).run(
        patch(data.name, current.name),
        data.name === undefined ? current.slug : buildClientSlug(data.name, current.id),
        patch(data.contactName, current.contact_name),
        patch(data.email, current.email),
        patch(data.phone, current.phone),
        patch(data.website, current.website),
        patch(data.notes, current.notes),
        now(),
        req.params.id,
      );
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
    const result = db
      .prepare("UPDATE clients SET status='ACTIVE',updated_at=? WHERE id=?")
      .run(now(), req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Client not found.' });
    res.json({ ok: true });
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
      if (!db.prepare("SELECT id FROM clients WHERE id=? AND status='ACTIVE'").get(data.clientId))
        return res.status(400).json({ error: 'Choose an active client.' });
      const projectId = id();
      const stamp = now();
      // A new project lands last in the manual tile order, as a new task does in its column.
      const position = (
        db.prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM projects').get() as any
      ).next;
      db.prepare(
        `INSERT INTO projects(id,client_id,name,description,status,start_date,target_deadline,priority,notes,position,drive_status,created_at,updated_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        projectId,
        data.clientId,
        data.name,
        data.description ?? null,
        data.status,
        data.startDate ?? null,
        data.targetDeadline ?? null,
        data.priority,
        data.notes ?? null,
        position,
        'PENDING',
        stamp,
        stamp,
        stamp,
      );
      try {
        await provisionProject(db, projectId);
      } catch (error) {
        req.log.error({ err: error, projectId }, 'Drive project provisioning failed');
      }
      res.status(201).json(projectById(db, projectId));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/projects/:id', (req, res, next) => {
    try {
      const data = projectPatch.parse(req.body);
      const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id) as any;
      if (!p) return res.status(404).json({ error: 'Project not found.' });
      // Editing the project record is both an edit and activity, so it stamps both fields.
      const stamp = now();
      db.prepare(
        `UPDATE projects SET client_id=?,name=?,description=?,status=?,start_date=?,target_deadline=?,priority=?,notes=?,updated_at=?,last_activity_at=? WHERE id=?`,
      ).run(
        patch(data.clientId, p.client_id),
        patch(data.name, p.name),
        patch(data.description, p.description),
        patch(data.status, p.status),
        patch(data.startDate, p.start_date),
        patch(data.targetDeadline, p.target_deadline),
        patch(data.priority, p.priority),
        patch(data.notes, p.notes),
        stamp,
        stamp,
        req.params.id,
      );
      res.json(projectById(db, req.params.id));
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
  app.delete('/api/projects/:id', (req, res) => {
    const project = db.prepare('SELECT id, name FROM projects WHERE id=?').get(req.params.id) as
      { id: string; name: string } | undefined;
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    // Removes local project + tasks only. Drive folders and files are intentionally left untouched.
    transaction(db, () => {
      db.prepare('DELETE FROM tasks WHERE project_id=?').run(project.id);
      db.prepare("DELETE FROM drive_steps WHERE entity_type='project' AND entity_id=?").run(
        project.id,
      );
      db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    });
    res.json({ ok: true, deleted: 'project', name: project.name, driveTouched: false });
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
      res.json(projectById(db, req.params.id));
    } catch (e) {
      next(e);
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

  app.get('/api/tasks', (req, res) => {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [query, column] of [
      ['projectId', 't.project_id'],
      ['clientId', 'p.client_id'],
      ['status', 't.status'],
      ['priority', 't.priority'],
    ] as const) {
      if (req.query[query]) {
        clauses.push(`${column}=?`);
        params.push(String(req.query[query]));
      }
    }
    res.json(listTasks(db, clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params));
  });
  app.post('/api/tasks', (req, res, next) => {
    try {
      const data = taskInput.parse(req.body);
      if (
        !db
          .prepare(
            `SELECT p.id FROM projects p JOIN clients c ON c.id=p.client_id
             WHERE p.id=? AND p.status<>'ARCHIVED' AND c.status='ACTIVE'`,
          )
          .get(data.projectId)
      )
        return res.status(400).json({ error: 'Choose an active project.' });
      const taskId = id();
      const stamp = now();
      const max = (
        db
          .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM tasks WHERE status=?')
          .get(data.status) as any
      ).next;
      transaction(db, () => {
        db.prepare(
          `INSERT INTO tasks(id,project_id,title,description,status,priority,task_type,due_date,start_date,notes,position,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          taskId,
          data.projectId,
          data.title,
          data.description ?? null,
          data.status,
          data.priority,
          data.taskType ?? null,
          data.dueDate ?? null,
          data.startDate ?? null,
          data.notes ?? null,
          max,
          data.status === 'COMPLETE' ? stamp : null,
          stamp,
          stamp,
        );
        const template = data.taskType ? TASK_CHECKLIST_TEMPLATES[data.taskType] : undefined;
        if (template) {
          const insertChecklistItem = db.prepare(
            'INSERT INTO checklist_items(id,task_id,text,position) VALUES(?,?,?,?)',
          );
          template.forEach((text, position) =>
            insertChecklistItem.run(id(), taskId, text, position),
          );
        }
        touchProjectActivity(db, data.projectId, stamp);
      });
      res.status(201).json(getTask(db, taskId));
    } catch (e) {
      next(e);
    }
  });
  app.patch('/api/tasks/:id', (req, res, next) => {
    try {
      const data = taskPatch.extend({ overrideBlocked: z.boolean().optional() }).parse(req.body);
      const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id) as any;
      if (!t) return res.status(404).json({ error: 'Task not found.' });
      const nextStatus = patch(data.status, t.status);
      if (
        nextStatus === 'COMPLETE' &&
        !data.overrideBlocked &&
        blockingDependencies(db, t.id).length
      )
        return res.status(409).json({
          error: 'This task is blocked by incomplete dependencies.',
          code: 'TASK_BLOCKED',
          blockingDependencies: blockingDependencies(db, t.id),
        });
      const stamp = now();
      const nextProjectId = patch(data.projectId, t.project_id);
      transaction(db, () => {
        db.prepare(
          `UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,task_type=?,due_date=?,start_date=?,notes=?,completed_at=?,updated_at=? WHERE id=?`,
        ).run(
          nextProjectId,
          patch(data.title, t.title),
          patch(data.description, t.description),
          nextStatus,
          patch(data.priority, t.priority),
          patch(data.taskType, t.task_type),
          patch(data.dueDate, t.due_date),
          patch(data.startDate, t.start_date),
          patch(data.notes, t.notes),
          nextStatus === 'COMPLETE' ? t.completed_at || stamp : null,
          stamp,
          t.id,
        );
        touchProjectActivity(db, t.project_id, stamp);
        // Moving a task between projects is activity in both: one lost the work, one gained it.
        if (nextProjectId !== t.project_id) touchProjectActivity(db, nextProjectId, stamp);
      });
      res.json(getTask(db, t.id));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/tasks/:id', (req, res) => {
    const task = db
      .prepare('SELECT id, title, project_id FROM tasks WHERE id=?')
      .get(req.params.id) as { id: string; title: string; project_id: string } | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    const stamp = now();
    // Checklist/deps cascade in SQLite. Drive files are never touched.
    transaction(db, () => {
      db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
      touchProjectActivity(db, task.project_id, stamp);
    });
    res.json({ ok: true, deleted: 'task', title: task.title, driveTouched: false });
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
      res.status(attached ? 201 : 200).json(projectById(db, req.params.id));
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
    res.json(projectById(db, req.params.id));
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
      const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(req.params.id) as
        { project_id: string } | undefined;
      if (!task) return res.status(404).json({ error: 'Task not found.' });
      const itemId = id();
      const stamp = now();
      const pos = (
        db
          .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM checklist_items WHERE task_id=?')
          .get(req.params.id) as any
      ).next;
      transaction(db, () => {
        db.prepare('INSERT INTO checklist_items(id,task_id,text,position) VALUES(?,?,?,?)').run(
          itemId,
          req.params.id,
          data.text,
          pos,
        );
        touchProjectActivity(db, task.project_id, stamp);
      });
      res.status(201).json(getTask(db, req.params.id));
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
      // The parent project comes along for the activity stamp, so ticking an item costs
      // one query rather than walking checklist item to task to project.
      const item = db
        .prepare(
          `SELECT c.*, t.project_id FROM checklist_items c JOIN tasks t ON t.id=c.task_id
           WHERE c.id=?`,
        )
        .get(req.params.id) as any;
      if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
      const stamp = now();
      transaction(db, () => {
        db.prepare('UPDATE checklist_items SET text=?,completed=?,position=? WHERE id=?').run(
          data.text ?? item.text,
          data.completed === undefined ? item.completed : Number(data.completed),
          data.position ?? item.position,
          item.id,
        );
        touchProjectActivity(db, item.project_id, stamp);
      });
      res.json(getTask(db, item.task_id));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/checklist/:id', (req, res) => {
    const item = db
      .prepare(
        `SELECT c.task_id, t.project_id FROM checklist_items c JOIN tasks t ON t.id=c.task_id
         WHERE c.id=?`,
      )
      .get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
    const stamp = now();
    transaction(db, () => {
      db.prepare('DELETE FROM checklist_items WHERE id=?').run(req.params.id);
      touchProjectActivity(db, item.project_id, stamp);
    });
    res.json(getTask(db, item.task_id));
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
      const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(req.params.id) as any;
      const dep = db
        .prepare('SELECT project_id FROM tasks WHERE id=?')
        .get(data.dependencyId) as any;
      if (!task || !dep) return res.status(404).json({ error: 'Task not found.' });
      if (wouldCreateCycle(db, req.params.id, data.dependencyId))
        return res.status(409).json({
          error: 'That dependency would create a circular relationship.',
          code: 'CIRCULAR_DEPENDENCY',
        });
      const activeTaskCount = (
        db
          .prepare(
            `SELECT COUNT(*) count FROM tasks t
             JOIN projects p ON p.id=t.project_id
             JOIN clients c ON c.id=p.client_id
             WHERE t.id IN (?,?) AND p.status<>'ARCHIVED' AND c.status='ACTIVE'`,
          )
          .get(req.params.id, data.dependencyId) as { count: number }
      ).count;
      if (activeTaskCount !== 2)
        return res.status(400).json({ error: 'Choose tasks under active clients and projects.' });
      const stamp = now();
      transaction(db, () => {
        const result = db
          .prepare('INSERT OR IGNORE INTO task_dependencies(task_id,dependency_id) VALUES(?,?)')
          .run(req.params.id, data.dependencyId);
        // The dependent task's project only. The task being depended on is unchanged.
        if (result.changes) touchProjectActivity(db, task.project_id, stamp);
      });
      res.status(201).json(getTask(db, req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/tasks/:id/dependencies/:dependencyId', (req, res) => {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(req.params.id) as
      { project_id: string } | undefined;
    const stamp = now();
    transaction(db, () => {
      const result = db
        .prepare('DELETE FROM task_dependencies WHERE task_id=? AND dependency_id=?')
        .run(req.params.id, req.params.dependencyId);
      if (task && result.changes) touchProjectActivity(db, task.project_id, stamp);
    });
    res.json(getTask(db, req.params.id));
  });

  app.get('/api/dashboard', (_req, res) => {
    // Active scope only: tasks under an archived project or an archived client are still
    // reachable everywhere else, but they are not work that needs attention now, so they
    // belong in none of these counts or lists.
    const tasks = listActiveTasks(db);
    const projects = listProjects(db);
    // Each bucket filters COMPLETE out for itself, so a task that is finished cannot reach
    // a list through one of them.
    const overdue = tasks.filter((t) => isOverdue(t));
    const dueToday = tasks.filter((t) => isDueToday(t));
    // Includes today: a task due in the next few hours is the most urgent thing in the
    // window, not something the window has already passed. `dueToday` is a subset of it.
    const dueNextSevenDays = tasks.filter((t) => isDueNextSevenDays(t));
    res.json({
      counts: {
        activeClients: listClients(db).filter((c: any) => c.status === 'ACTIVE').length,
        activeProjects: projects.filter((p: any) => p.status === 'ACTIVE').length,
        dueToday: dueToday.length,
        dueNextSevenDays: dueNextSevenDays.length,
        overdue: overdue.length,
        projectsOverdue: new Set(overdue.map((t) => t.projectId)).size,
      },
      overdueTasks: urgent(overdue),
      dueTodayTasks: urgent(dueToday),
      upcomingTasks: urgent(dueNextSevenDays),
      // Ordered by activity, not by `updatedAt`: the panel is asking where work is
      // happening, and renaming a project is not work on it. The comparator is shared with
      // the Projects page so the two views cannot put the same projects in a different order.
      recentProjects: (projects as Project[]).slice().sort(compareProjectActivity).slice(0, 5),
    });
  });

  app.get('/api/settings/branding', (_req, res) =>
    res.json({ version: APP_VERSION, branding: readBranding(db) }),
  );
  app.put('/api/settings/branding', (req, res, next) => {
    try {
      const data = brandingInput.parse(req.body);
      setSetting(db, BRANDING_SETTING_KEY, JSON.stringify(data));
      res.json({ version: APP_VERSION, branding: data });
    } catch (error) {
      next(error);
    }
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
   * The range read goes through `SignalProvider` rather than straight to the query behind it.
   * That is the boundary the calendar consumes, and routing this endpoint through it too means
   * the interface is exercised by the app rather than only by its tests.
   */
  app.get('/api/signal/posts', async (req, res, next) => {
    try {
      const { from, to } = signalRangeQuery.parse(req.query);
      if (from > to) return res.status(400).json({ error: 'The range ends before it starts.' });
      res.json(await signalProvider(db).listPosts({ from, to }));
    } catch (error) {
      next(error);
    }
  });
  /** The unscheduled queue — posts with no date, which belong to no range and no calendar cell. */
  app.get('/api/signal/queue', (_req, res, next) => {
    try {
      res.json(listQueue(db));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/signal/posts', (req, res, next) => {
    try {
      res.status(201).json(createPost(db, signalPostInput.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/signal/posts/:id', (req, res) => {
    const post = getPost(db, req.params.id);
    if (!post) return res.status(404).json({ error: 'Signal post not found.' });
    res.json(post);
  });
  app.patch('/api/signal/posts/:id', (req, res, next) => {
    try {
      res.json(updatePost(db, req.params.id, signalPostPatch.parse(req.body)));
    } catch (error) {
      next(error);
    }
  });
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
      connected: driveProvider(db).connected,
      rootFolderId: getSetting(db, 'drive_root_id'),
      rootFolderUrl: getSetting(db, 'drive_root_url'),
    }),
  );
  app.get('/api/drive/oauth/start', (_req, res, next) => {
    try {
      if (!config.google.clientId || !config.google.clientSecret || !config.google.encryptionKey)
        throw new Error('Add Google OAuth credentials and an encryption key to .env first.');
      const { state, challenge } = beginAuthorization(db, clock());
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
        ({ verifier } = consumeAuthorization(db, req.query.state, clock()));
      } catch (error) {
        if (!(error instanceof OAuthStateError)) throw error;
        req.log.warn({ reason: error.message }, 'Rejected a Drive OAuth callback');
        return res.status(400).send('Invalid OAuth state.');
      }
      const code = z.string().min(1).max(2048).parse(req.query.code);
      const tokens = await oauthClient(config.google).exchange({ code, verifier });
      setSetting(db, 'google_tokens', encryptJson(tokens, config.google.encryptionKey));
      const returnOrigin = process.argv.includes('--production')
        ? `http://localhost:${config.port}`
        : config.appOrigin;
      res.redirect(`${returnOrigin}/settings?drive=connected`);
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/settings/drive/root', async (req, res, next) => {
    try {
      const data = z.object({ folderId: z.string().trim().min(5).max(200) }).parse(req.body);
      const folderId = parseFolderId(data.folderId);
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
    res.json({ ok: true });
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
    // An unreadable upload is the caller's problem, not a 500: the message already says
    // what to do about it, and the import modal shows it verbatim.
    const status =
      error instanceof z.ZodError ||
      error instanceof ImportInputError ||
      error instanceof DriveScopeError
        ? 400
        : // Editing or deleting a post that is not there is the caller addressing something
          // that does not exist, not a failure of the write.
          error instanceof SignalPostNotFoundError
          ? 404
          : error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
            ? 409
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
    });
  });
  return app;
}

/** One project in the shape every project endpoint answers with, categories included. */
function projectById(db: Db, projectId: string) {
  return listProjects(db).find((project: any) => project.id === projectId);
}
function parseFolderId(value: string) {
  const match = value.match(/folders\/([a-zA-Z0-9_-]+)/);
  return match?.[1] || value;
}
function urgent(tasks: any[]) {
  const rank: any = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return tasks.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
      rank[a.priority] - rank[b.priority],
  );
}
/**
 * Branding as stored, completed from the defaults. Rows written before colours and logos
 * existed carry only the four text fields, so every key falls back individually and the
 * saved wording survives the upgrade. A row that still fails validation after that — hand
 * edited, or from a future shape this build does not understand — is not worth guessing at
 * one field at a time, so the whole thing reverts to a palette known to be readable.
 */
function readBranding(db: Db): Branding {
  const raw = getSetting(db, BRANDING_SETTING_KEY);
  if (!raw) return { ...DEFAULT_BRANDING };
  try {
    const stored = JSON.parse(raw) as Partial<Record<keyof Branding, unknown>>;
    const merged = { ...DEFAULT_BRANDING };
    for (const key of Object.keys(DEFAULT_BRANDING) as (keyof Branding)[])
      if (typeof stored[key] === 'string') merged[key] = stored[key];
    const parsed = brandingInput.safeParse(merged);
    return parsed.success ? parsed.data : { ...DEFAULT_BRANDING };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}
