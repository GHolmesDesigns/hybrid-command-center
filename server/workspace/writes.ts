/**
 * Local workspace writes shared by HTTP and MCP (C130).
 *
 * Drive provisioning stays in the HTTP layer — MCP createProject leaves drive_status PENDING.
 * Checklist and dependency mutations optionally take a parent-task revision; MCP always passes one.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import { isMergedSource } from '../client-merge.ts';
import { touchProjectActivity } from '../domain/activity.ts';
import { blockingDependencies, wouldCreateCycle } from '../domain/dependencies.ts';
import { advanceRevision, requireRevision, RevisionConflictError } from '../domain/revisions.ts';
import { getSetting, setSetting } from '../drive/service.ts';
import { getTask, listProjects } from '../repositories.ts';
import {
  APP_VERSION,
  BRANDING_SETTING_KEY,
  DEFAULT_BRANDING,
  type Branding,
} from '../../shared/branding.ts';
import {
  CANONICAL_VIEW_DEFAULTS,
  isViewDefaults,
  VIEW_DEFAULTS_SETTING_KEY,
  type ViewDefaults,
} from '../../shared/view-defaults.ts';
import { TASK_CHECKLIST_TEMPLATES, type Project, type Task } from '../../shared/types.ts';
import {
  brandingInput,
  projectInput,
  taskInput,
  type BrandingInput,
  type ProjectInput,
  type ProjectPatch,
  type TaskInput,
  type TaskPatch,
} from './schemas.ts';
import { recordChangeFeedEvent } from '../change-feeds.ts';

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const patch = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next);

const recordWorkspaceChange = (
  db: Db,
  kind: string,
  entityType: string,
  entityId: string,
  summary: string,
  at?: string,
) => {
  recordChangeFeedEvent(db, {
    feed: 'workspace',
    kind,
    entityType,
    entityId,
    summary,
    at,
  });
};

export class WorkspaceNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceValidationError';
  }
}

export class WorkspaceConflictError extends Error {
  readonly status = 409;
  readonly code: string;
  readonly blockingDependencies?: ReturnType<typeof blockingDependencies>;
  constructor(
    message: string,
    code: string,
    extra: { blockingDependencies?: ReturnType<typeof blockingDependencies> } = {},
  ) {
    super(message);
    this.name = 'WorkspaceConflictError';
    this.code = code;
    this.blockingDependencies = extra.blockingDependencies;
  }
}

export { RevisionConflictError };

export function getProjectById(db: Db, projectId: string): Project | undefined {
  return listProjects(db).find((project) => (project as Project).id === projectId) as
    Project | undefined;
}

export function readBranding(db: Db): Branding {
  const raw = getSetting(db, BRANDING_SETTING_KEY);
  if (!raw) return { ...DEFAULT_BRANDING };
  try {
    const stored = JSON.parse(raw) as Partial<Record<keyof Branding, unknown>>;
    const merged = { ...DEFAULT_BRANDING };
    for (const key of Object.keys(DEFAULT_BRANDING) as (keyof Branding)[])
      if (typeof stored[key] === 'string') merged[key] = stored[key] as string;
    const parsed = brandingInput.safeParse(merged);
    return parsed.success ? parsed.data : { ...DEFAULT_BRANDING };
  } catch {
    return { ...DEFAULT_BRANDING };
  }
}

export function readViewDefaults(db: Db): ViewDefaults {
  const raw = getSetting(db, VIEW_DEFAULTS_SETTING_KEY);
  if (!raw) return { ...CANONICAL_VIEW_DEFAULTS };
  try {
    const stored = JSON.parse(raw) as unknown;
    // C153 added Projects presentation after operators could already have saved every other
    // default. Upgrade exactly that legacy shape in memory so the new field does not erase their
    // existing choices; every other incomplete or unknown shape still fails closed.
    const upgraded =
      stored !== null &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      'projects' in stored &&
      stored.projects !== null &&
      typeof stored.projects === 'object' &&
      !Array.isArray(stored.projects) &&
      !('presentation' in stored.projects)
        ? {
            ...stored,
            projects: {
              ...stored.projects,
              presentation: CANONICAL_VIEW_DEFAULTS.projects.presentation,
            },
          }
        : stored;
    return isViewDefaults(upgraded) ? upgraded : { ...CANONICAL_VIEW_DEFAULTS };
  } catch {
    return { ...CANONICAL_VIEW_DEFAULTS };
  }
}

export function createProject(db: Db, raw: z.input<typeof projectInput> | ProjectInput): Project {
  const data = projectInput.parse(raw);
  if (!db.prepare("SELECT id FROM clients WHERE id=? AND status='ACTIVE'").get(data.clientId))
    throw new WorkspaceValidationError('Choose an active client.');
  const projectId = id();
  const stamp = now();
  const position = (
    db.prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM projects').get() as { next: number }
  ).next;
  db.prepare(
    `INSERT INTO projects(id,client_id,name,description,status,start_date,launch_date,target_deadline,priority,notes,position,drive_status,created_at,updated_at,last_activity_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    projectId,
    data.clientId,
    data.name,
    data.description ?? null,
    data.status,
    data.startDate ?? null,
    data.launchDate ?? null,
    data.targetDeadline ?? null,
    data.priority,
    data.notes ?? null,
    position,
    'PENDING',
    stamp,
    stamp,
    stamp,
  );
  recordWorkspaceChange(db, 'project.created', 'project', projectId, 'Project created.', stamp);
  const project = getProjectById(db, projectId);
  if (!project) throw new WorkspaceNotFoundError('Project not found.');
  return project;
}

export function updateProject(db: Db, projectId: string, data: ProjectPatch, revision: number) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) as
    Record<string, unknown> | undefined;
  if (!p) throw new WorkspaceNotFoundError('Project not found.');
  if (data.clientId !== undefined) {
    if (isMergedSource(db, data.clientId))
      throw new WorkspaceConflictError(
        'That client was merged into another client. Choose the surviving client.',
        'CLIENT_MERGED',
      );
    if (!db.prepare("SELECT id FROM clients WHERE id=? AND status='ACTIVE'").get(data.clientId))
      throw new WorkspaceValidationError('Choose an active client.');
  }
  const stamp = now();
  transaction(db, () => {
    requireRevision(db, 'project', projectId, revision);
    db.prepare(
      `UPDATE projects SET client_id=?,name=?,description=?,status=?,start_date=?,launch_date=?,target_deadline=?,priority=?,notes=?,updated_at=?,last_activity_at=? WHERE id=?`,
    ).run(
      patch(data.clientId, p.client_id as string),
      patch(data.name, p.name as string),
      patch(data.description, p.description as string | null),
      patch(data.status, p.status as string),
      patch(data.startDate, p.start_date as string | null),
      patch(data.launchDate, p.launch_date as string | null),
      patch(data.targetDeadline, p.target_deadline as string | null),
      patch(data.priority, p.priority as string),
      patch(data.notes, p.notes as string | null),
      stamp,
      stamp,
      projectId,
    );
    advanceRevision(db, 'project', projectId, revision, Object.keys(data), stamp);
    recordWorkspaceChange(db, 'project.updated', 'project', projectId, 'Project updated.', stamp);
  });
  const project = getProjectById(db, projectId);
  if (!project) throw new WorkspaceNotFoundError('Project not found.');
  return project;
}

export function deleteProject(db: Db, projectId: string) {
  const project = db.prepare('SELECT id, name FROM projects WHERE id=?').get(projectId) as
    { id: string; name: string } | undefined;
  if (!project) throw new WorkspaceNotFoundError('Project not found.');
  transaction(db, () => {
    db.prepare('DELETE FROM tasks WHERE project_id=?').run(project.id);
    db.prepare("DELETE FROM drive_steps WHERE entity_type='project' AND entity_id=?").run(
      project.id,
    );
    db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    recordWorkspaceChange(db, 'project.deleted', 'project', project.id, 'Project deleted.');
  });
  return {
    ok: true as const,
    deleted: 'project' as const,
    name: project.name,
    driveTouched: false,
  };
}

export function createTask(db: Db, raw: z.input<typeof taskInput> | TaskInput): Task {
  const data = taskInput.parse(raw);
  if (
    !db
      .prepare(
        `SELECT p.id FROM projects p JOIN clients c ON c.id=p.client_id
         WHERE p.id=? AND p.status<>'ARCHIVED' AND c.status='ACTIVE'`,
      )
      .get(data.projectId)
  )
    throw new WorkspaceValidationError('Choose an active project.');
  const taskId = id();
  const stamp = now();
  const max = (
    db
      .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM tasks WHERE status=?')
      .get(data.status) as { next: number }
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
      template.forEach((text, position) => insertChecklistItem.run(id(), taskId, text, position));
    }
    touchProjectActivity(db, data.projectId, stamp);
    recordWorkspaceChange(db, 'task.created', 'task', taskId, 'Task created.', stamp);
  });
  const task = getTask(db, taskId);
  if (!task) throw new WorkspaceNotFoundError('Task not found.');
  return task;
}

export function updateTask(db: Db, taskId: string, data: TaskPatch, revision: number): Task {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as
    Record<string, unknown> | undefined;
  if (!t) throw new WorkspaceNotFoundError('Task not found.');
  const nextStatus = patch(data.status, t.status as string);
  if (nextStatus === 'COMPLETE' && !data.overrideBlocked && blockingDependencies(db, taskId).length)
    throw new WorkspaceConflictError(
      'This task is blocked by incomplete dependencies.',
      'TASK_BLOCKED',
      { blockingDependencies: blockingDependencies(db, taskId) },
    );
  const stamp = now();
  const nextProjectId = patch(data.projectId, t.project_id as string);
  transaction(db, () => {
    requireRevision(db, 'task', taskId, revision);
    db.prepare(
      `UPDATE tasks SET project_id=?,title=?,description=?,status=?,priority=?,task_type=?,due_date=?,start_date=?,notes=?,completed_at=?,updated_at=? WHERE id=?`,
    ).run(
      nextProjectId,
      patch(data.title, t.title as string),
      patch(data.description, t.description as string | null),
      nextStatus,
      patch(data.priority, t.priority as string),
      patch(data.taskType, t.task_type as string | null),
      patch(data.dueDate, t.due_date as string | null),
      patch(data.startDate, t.start_date as string | null),
      patch(data.notes, t.notes as string | null),
      nextStatus === 'COMPLETE' ? (t.completed_at as string | null) || stamp : null,
      stamp,
      taskId,
    );
    touchProjectActivity(db, t.project_id as string, stamp);
    if (nextProjectId !== t.project_id) touchProjectActivity(db, nextProjectId, stamp);
    advanceRevision(
      db,
      'task',
      taskId,
      revision,
      Object.keys(data).filter((field) => field !== 'overrideBlocked'),
      stamp,
    );
    recordWorkspaceChange(db, 'task.updated', 'task', taskId, 'Task updated.', stamp);
  });
  const task = getTask(db, taskId);
  if (!task) throw new WorkspaceNotFoundError('Task not found.');
  return task;
}

export function deleteTask(db: Db, taskId: string) {
  const task = db.prepare('SELECT id, title, project_id FROM tasks WHERE id=?').get(taskId) as
    { id: string; title: string; project_id: string } | undefined;
  if (!task) throw new WorkspaceNotFoundError('Task not found.');
  const stamp = now();
  transaction(db, () => {
    db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
    touchProjectActivity(db, task.project_id, stamp);
    recordWorkspaceChange(db, 'task.deleted', 'task', task.id, 'Task deleted.', stamp);
  });
  return { ok: true as const, deleted: 'task' as const, title: task.title, driveTouched: false };
}

export function addChecklistItem(db: Db, taskId: string, text: string, revision?: number): Task {
  const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as
    { project_id: string } | undefined;
  if (!task) throw new WorkspaceNotFoundError('Task not found.');
  const itemId = id();
  const stamp = now();
  const pos = (
    db
      .prepare('SELECT COALESCE(MAX(position),-1)+1 next FROM checklist_items WHERE task_id=?')
      .get(taskId) as { next: number }
  ).next;
  transaction(db, () => {
    if (revision !== undefined) requireRevision(db, 'task', taskId, revision);
    db.prepare('INSERT INTO checklist_items(id,task_id,text,position) VALUES(?,?,?,?)').run(
      itemId,
      taskId,
      text,
      pos,
    );
    touchProjectActivity(db, task.project_id, stamp);
    if (revision !== undefined) advanceRevision(db, 'task', taskId, revision, ['checklist'], stamp);
  });
  const result = getTask(db, taskId);
  if (!result) throw new WorkspaceNotFoundError('Task not found.');
  return result;
}

export function updateChecklistItem(
  db: Db,
  itemId: string,
  data: { text?: string; completed?: boolean; position?: number },
  revision?: number,
): Task {
  const item = db
    .prepare(
      `SELECT c.*, t.project_id FROM checklist_items c JOIN tasks t ON t.id=c.task_id
       WHERE c.id=?`,
    )
    .get(itemId) as
    | {
        id: string;
        task_id: string;
        text: string;
        completed: number;
        position: number;
        project_id: string;
      }
    | undefined;
  if (!item) throw new WorkspaceNotFoundError('Checklist item not found.');
  const stamp = now();
  transaction(db, () => {
    if (revision !== undefined) requireRevision(db, 'task', item.task_id, revision);
    db.prepare('UPDATE checklist_items SET text=?,completed=?,position=? WHERE id=?').run(
      data.text ?? item.text,
      data.completed === undefined ? item.completed : Number(data.completed),
      data.position ?? item.position,
      item.id,
    );
    touchProjectActivity(db, item.project_id, stamp);
    if (revision !== undefined)
      advanceRevision(db, 'task', item.task_id, revision, ['checklist'], stamp);
  });
  const result = getTask(db, item.task_id);
  if (!result) throw new WorkspaceNotFoundError('Task not found.');
  return result;
}

export function removeChecklistItem(db: Db, itemId: string, revision?: number): Task {
  const item = db
    .prepare(
      `SELECT c.task_id, t.project_id FROM checklist_items c JOIN tasks t ON t.id=c.task_id
       WHERE c.id=?`,
    )
    .get(itemId) as { task_id: string; project_id: string } | undefined;
  if (!item) throw new WorkspaceNotFoundError('Checklist item not found.');
  const stamp = now();
  transaction(db, () => {
    if (revision !== undefined) requireRevision(db, 'task', item.task_id, revision);
    db.prepare('DELETE FROM checklist_items WHERE id=?').run(itemId);
    touchProjectActivity(db, item.project_id, stamp);
    if (revision !== undefined)
      advanceRevision(db, 'task', item.task_id, revision, ['checklist'], stamp);
  });
  const result = getTask(db, item.task_id);
  if (!result) throw new WorkspaceNotFoundError('Task not found.');
  return result;
}

export function addDependency(
  db: Db,
  taskId: string,
  dependencyId: string,
  revision?: number,
): Task {
  const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as
    { project_id: string } | undefined;
  const dep = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(dependencyId) as
    { project_id: string } | undefined;
  if (!task || !dep) throw new WorkspaceNotFoundError('Task not found.');
  if (wouldCreateCycle(db, taskId, dependencyId))
    throw new WorkspaceConflictError(
      'That dependency would create a circular relationship.',
      'CIRCULAR_DEPENDENCY',
    );
  const activeTaskCount = (
    db
      .prepare(
        `SELECT COUNT(*) count FROM tasks t
         JOIN projects p ON p.id=t.project_id
         JOIN clients c ON c.id=p.client_id
         WHERE t.id IN (?,?) AND p.status<>'ARCHIVED' AND c.status='ACTIVE'`,
      )
      .get(taskId, dependencyId) as { count: number }
  ).count;
  if (activeTaskCount !== 2)
    throw new WorkspaceValidationError('Choose tasks under active clients and projects.');
  const stamp = now();
  transaction(db, () => {
    if (revision !== undefined) requireRevision(db, 'task', taskId, revision);
    const result = db
      .prepare('INSERT OR IGNORE INTO task_dependencies(task_id,dependency_id) VALUES(?,?)')
      .run(taskId, dependencyId);
    if (result.changes) touchProjectActivity(db, task.project_id, stamp);
    if (revision !== undefined)
      advanceRevision(db, 'task', taskId, revision, ['dependencies'], stamp);
  });
  const result = getTask(db, taskId);
  if (!result) throw new WorkspaceNotFoundError('Task not found.');
  return result;
}

export function removeDependency(
  db: Db,
  taskId: string,
  dependencyId: string,
  revision?: number,
): Task {
  const task = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as
    { project_id: string } | undefined;
  if (!task) throw new WorkspaceNotFoundError('Task not found.');
  const stamp = now();
  transaction(db, () => {
    if (revision !== undefined) requireRevision(db, 'task', taskId, revision);
    const result = db
      .prepare('DELETE FROM task_dependencies WHERE task_id=? AND dependency_id=?')
      .run(taskId, dependencyId);
    if (result.changes) touchProjectActivity(db, task.project_id, stamp);
    if (revision !== undefined)
      advanceRevision(db, 'task', taskId, revision, ['dependencies'], stamp);
  });
  const result = getTask(db, taskId);
  if (!result) throw new WorkspaceNotFoundError('Task not found.');
  return result;
}

export function updateBranding(db: Db, data: BrandingInput) {
  setSetting(db, BRANDING_SETTING_KEY, JSON.stringify(data));
  return { version: APP_VERSION, branding: data };
}

export function updateViewDefaults(db: Db, data: ViewDefaults) {
  setSetting(db, VIEW_DEFAULTS_SETTING_KEY, JSON.stringify(data));
  return { viewDefaults: data };
}
