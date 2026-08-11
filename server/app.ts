import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { google } from 'googleapis';
import { isValid, parseISO } from 'date-fns';
import { z } from 'zod';
import type { Db } from './db.ts';
import { getDb, transaction } from './db.ts';
import { config } from './config.ts';
import { getTag, getTask, listClients, listProjects, listTags, listTasks } from './repositories.ts';
import { wouldCreateCycle, blockingDependencies } from './domain/dependencies.ts';
import { isDueNextSevenDays, isDueToday } from './domain/deadlines.ts';
import {
  driveProvider,
  getSetting,
  provisionClient,
  provisionProject,
  setSetting,
  syncAllToDrive,
} from './drive/service.ts';
import { encryptJson } from './drive/tokens.ts';
import {
  APP_VERSION,
  BRANDING_SETTING_KEY,
  DEFAULT_BRANDING,
  type Branding,
} from '../shared/branding.ts';
import { TASK_STATUSES, TASK_TYPES } from '../shared/types.ts';

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
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
    imgSrc: ["'self'", 'data:'],
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

type AppOptions = { production?: boolean };

const slugify = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
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
 * such as `2026-02-30`. Without both, junk reaches `server/domain/deadlines.ts`, where
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

const normalizedTagName = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(60));
const tagColor = z
  .union([z.literal(''), z.string().trim().min(1).max(32)])
  .optional()
  .transform((value) => (value === undefined ? undefined : value || null));
const tagInput = z.object({ name: normalizedTagName, color: tagColor });
const tagPatch = tagInput.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'Provide a tag field to update.',
});

export function createApp(db: Db = getDb(), options: AppOptions = {}) {
  const app = express();
  const production = options.production ?? isProductionRuntime();
  app.use(
    helmet({
      // Vite's development client needs a relaxed policy for HMR. The built client does not.
      contentSecurityPolicy: production ? productionContentSecurityPolicy : false,
    }),
  );
  app.use(cors({ origin: config.appOrigin }));
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp());
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
        `${slugify(data.name)}-${clientId.slice(0, 6)}`,
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
        `UPDATE clients SET name=?,contact_name=?,email=?,phone=?,website=?,notes=?,updated_at=? WHERE id=?`,
      ).run(
        patch(data.name, current.name),
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
        `INSERT INTO projects(id,client_id,name,description,status,start_date,target_deadline,priority,notes,position,drive_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
      );
      try {
        await provisionProject(db, projectId);
      } catch (error) {
        req.log.error({ err: error, projectId }, 'Drive project provisioning failed');
      }
      res.status(201).json(listProjects(db).find((p: any) => p.id === projectId));
    } catch (error) {
      next(error);
    }
  });
  app.patch('/api/projects/:id', (req, res, next) => {
    try {
      const data = projectPatch.parse(req.body);
      const p = db.prepare('SELECT * FROM projects WHERE id=?').get(req.params.id) as any;
      if (!p) return res.status(404).json({ error: 'Project not found.' });
      db.prepare(
        `UPDATE projects SET client_id=?,name=?,description=?,status=?,start_date=?,target_deadline=?,priority=?,notes=?,updated_at=? WHERE id=?`,
      ).run(
        patch(data.clientId, p.client_id),
        patch(data.name, p.name),
        patch(data.description, p.description),
        patch(data.status, p.status),
        patch(data.startDate, p.start_date),
        patch(data.targetDeadline, p.target_deadline),
        patch(data.priority, p.priority),
        patch(data.notes, p.notes),
        now(),
        req.params.id,
      );
      res.json(listProjects(db).find((x: any) => x.id === req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/projects/:id/archive', (req, res) => {
    const r = db
      .prepare("UPDATE projects SET status='ARCHIVED',updated_at=? WHERE id=?")
      .run(now(), req.params.id);
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
      // `updated_at` is deliberately untouched: rearranging tiles is not an edit, and
      // stamping it would reshuffle the Recently updated sort on the same screen.
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
      res.json(listProjects(db).find((p: any) => p.id === req.params.id));
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
        !db.prepare("SELECT id FROM projects WHERE id=? AND status<>'ARCHIVED'").get(data.projectId)
      )
        return res.status(400).json({ error: 'Choose an active project.' });
      const taskId = id();
      const stamp = now();
      const max = (
        db
          .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM tasks WHERE status=?')
          .get(data.status) as any
      ).next;
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
      db.prepare(
        `UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,task_type=?,due_date=?,start_date=?,notes=?,completed_at=?,updated_at=? WHERE id=?`,
      ).run(
        patch(data.projectId, t.project_id),
        patch(data.title, t.title),
        patch(data.description, t.description),
        nextStatus,
        patch(data.priority, t.priority),
        patch(data.taskType, t.task_type),
        patch(data.dueDate, t.due_date),
        patch(data.startDate, t.start_date),
        patch(data.notes, t.notes),
        nextStatus === 'COMPLETE' ? t.completed_at || now() : null,
        now(),
        t.id,
      );
      res.json(getTask(db, t.id));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/tasks/:id', (req, res) => {
    const task = db.prepare('SELECT id, title FROM tasks WHERE id=?').get(req.params.id) as
      { id: string; title: string } | undefined;
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    // Checklist/deps cascade in SQLite. Drive files are never touched.
    db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
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
      transaction(db, () => {
        db.prepare('UPDATE tasks SET status=?,completed_at=?,updated_at=? WHERE id=?').run(
          data.status,
          data.status === 'COMPLETE' ? t.completedAt || now() : null,
          now(),
          data.taskId,
        );
        const stmt = db.prepare('UPDATE tasks SET position=? WHERE id=? AND status=?');
        data.orderedIds.forEach((taskId, index) => stmt.run(index, taskId, data.status));
      });
      res.json(getTask(db, data.taskId));
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/tasks/:id/checklist', (req, res, next) => {
    try {
      const data = z.object({ text: z.string().trim().min(1).max(300) }).parse(req.body);
      if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(req.params.id))
        return res.status(404).json({ error: 'Task not found.' });
      const itemId = id();
      const pos = (
        db
          .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM checklist_items WHERE task_id=?')
          .get(req.params.id) as any
      ).next;
      db.prepare('INSERT INTO checklist_items(id,task_id,text,position) VALUES(?,?,?,?)').run(
        itemId,
        req.params.id,
        data.text,
        pos,
      );
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
      const item = db.prepare('SELECT * FROM checklist_items WHERE id=?').get(req.params.id) as any;
      if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
      db.prepare('UPDATE checklist_items SET text=?,completed=?,position=? WHERE id=?').run(
        data.text ?? item.text,
        data.completed === undefined ? item.completed : Number(data.completed),
        data.position ?? item.position,
        item.id,
      );
      res.json(getTask(db, item.task_id));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/checklist/:id', (req, res) => {
    const item = db
      .prepare('SELECT task_id FROM checklist_items WHERE id=?')
      .get(req.params.id) as any;
    if (!item) return res.status(404).json({ error: 'Checklist item not found.' });
    db.prepare('DELETE FROM checklist_items WHERE id=?').run(req.params.id);
    res.json(getTask(db, item.task_id));
  });
  app.post('/api/tasks/:id/tags', (req, res, next) => {
    try {
      const data = z.object({ tagId: z.string().uuid() }).parse(req.body);
      if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(req.params.id))
        return res.status(404).json({ error: 'Task not found.' });
      if (!db.prepare('SELECT id FROM tags WHERE id=?').get(data.tagId))
        return res.status(404).json({ error: 'Tag not found.' });
      const result = db
        .prepare('INSERT OR IGNORE INTO task_tags(task_id,tag_id) VALUES(?,?)')
        .run(req.params.id, data.tagId);
      res.status(result.changes ? 201 : 200).json(getTask(db, req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/tasks/:id/tags/:tagId', (req, res) => {
    if (!db.prepare('SELECT id FROM tasks WHERE id=?').get(req.params.id))
      return res.status(404).json({ error: 'Task not found.' });
    db.prepare('DELETE FROM task_tags WHERE task_id=? AND tag_id=?').run(
      req.params.id,
      req.params.tagId,
    );
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
      db.prepare('INSERT OR IGNORE INTO task_dependencies(task_id,dependency_id) VALUES(?,?)').run(
        req.params.id,
        data.dependencyId,
      );
      res.status(201).json(getTask(db, req.params.id));
    } catch (e) {
      next(e);
    }
  });
  app.delete('/api/tasks/:id/dependencies/:dependencyId', (req, res) => {
    db.prepare('DELETE FROM task_dependencies WHERE task_id=? AND dependency_id=?').run(
      req.params.id,
      req.params.dependencyId,
    );
    res.json(getTask(db, req.params.id));
  });

  app.get('/api/dashboard', (_req, res) => {
    const tasks = listTasks(db);
    const projects = listProjects(db);
    const open = tasks.filter((t) => t.status !== 'COMPLETE');
    const overdue = open.filter((t) => t.overdue);
    res.json({
      counts: {
        activeClients: listClients(db).filter((c: any) => c.status === 'ACTIVE').length,
        activeProjects: projects.filter((p: any) => p.status === 'ACTIVE').length,
        dueToday: open.filter((t) => isDueToday(t.dueDate)).length,
        dueNextSevenDays: open.filter((t) => isDueNextSevenDays(t.dueDate)).length,
        overdue: overdue.length,
        projectsOverdue: new Set(overdue.map((t) => t.projectId)).size,
      },
      overdueTasks: urgent(overdue),
      upcomingTasks: urgent(
        open.filter((t) => isDueToday(t.dueDate) || isDueNextSevenDays(t.dueDate)),
      ),
      recentProjects: projects
        .slice()
        .sort((a: any, b: any) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 5),
    });
  });

  app.get('/api/settings/branding', (_req, res) =>
    res.json({ version: APP_VERSION, branding: readBranding(db) }),
  );
  app.put('/api/settings/branding', (req, res, next) => {
    try {
      const data = z
        .object({
          mark: z.string().trim().min(1).max(4),
          title: z.string().trim().min(1).max(40),
          subtitle: z.string().trim().min(1).max(60),
          tagline: z.string().trim().min(1).max(80),
        })
        .parse(req.body);
      setSetting(db, BRANDING_SETTING_KEY, JSON.stringify(data));
      res.json({ version: APP_VERSION, branding: data });
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
      configured: Boolean(
        config.google.clientId && config.google.clientSecret && config.google.encryptionKey,
      ),
      connected: driveProvider(db).connected,
      rootFolderId: getSetting(db, 'drive_root_id'),
      rootFolderUrl: getSetting(db, 'drive_root_url'),
    }),
  );
  app.get('/api/drive/oauth/start', (_req, res, next) => {
    try {
      if (!config.google.clientId || !config.google.clientSecret || !config.google.encryptionKey)
        throw new Error('Add Google OAuth credentials and an encryption key to .env first.');
      const oauth = new google.auth.OAuth2(
        config.google.clientId,
        config.google.clientSecret,
        config.google.redirectUri,
      );
      const state = id();
      setSetting(db, 'oauth_state', state);
      res.json({
        url: oauth.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          scope: ['https://www.googleapis.com/auth/drive'],
          state,
        }),
      });
    } catch (e) {
      next(e);
    }
  });
  app.get('/api/drive/oauth/callback', async (req, res, next) => {
    try {
      if (String(req.query.state) !== getSetting(db, 'oauth_state'))
        return res.status(400).send('Invalid OAuth state.');
      const oauth = new google.auth.OAuth2(
        config.google.clientId,
        config.google.clientSecret,
        config.google.redirectUri,
      );
      const { tokens } = await oauth.getToken(String(req.query.code));
      setSetting(db, 'google_tokens', encryptJson(tokens, config.google.encryptionKey));
      setSetting(db, 'oauth_state', 'used');
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

  app.use(
    (error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
      void next;
      const status =
        error instanceof z.ZodError ? 400 : error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500;
      res.status(status).json({
        error:
          error instanceof z.ZodError
            ? error.issues[0]?.message
            : error instanceof Error
              ? error.message
              : 'Unexpected error',
      });
    },
  );
  return app;
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
function readBranding(db: Db): Branding {
  const raw = getSetting(db, BRANDING_SETTING_KEY);
  if (!raw) return { ...DEFAULT_BRANDING };
  try {
    const parsed = JSON.parse(raw) as Partial<Branding>;
    return {
      mark: String(parsed.mark || DEFAULT_BRANDING.mark).slice(0, 4),
      title: String(parsed.title || DEFAULT_BRANDING.title).slice(0, 40),
      subtitle: String(parsed.subtitle || DEFAULT_BRANDING.subtitle).slice(0, 60),
      tagline: String(parsed.tagline || DEFAULT_BRANDING.tagline).slice(0, 80),
    };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}
