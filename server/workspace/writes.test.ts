import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { RevisionConflictError } from '../domain/revisions.ts';
import {
  addChecklistItem,
  addDependency,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  removeChecklistItem,
  removeDependency,
  updateBranding,
  updateChecklistItem,
  updateProject,
  updateTask,
  updateViewDefaults,
  WorkspaceNotFoundError,
  WorkspaceValidationError,
  readBranding,
  readViewDefaults,
} from './writes.ts';
import { DEFAULT_BRANDING } from '../../shared/branding.ts';
import { CANONICAL_VIEW_DEFAULTS } from '../../shared/view-defaults.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

const seedClient = () => {
  const clientId = '11111111-1111-4111-8111-111111111111';
  const stamp = '2026-08-29T12:00:00.000Z';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES(?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
  ).run(clientId, 'Acme Studio', 'acme-studio', stamp, stamp);
  return clientId;
};

const seedProject = () => {
  const clientId = seedClient();
  return createProject(db, {
    clientId,
    name: 'Retainer',
    status: 'ACTIVE',
    priority: 'MEDIUM',
  });
};

describe('workspace writes', () => {
  it('creates a task under an active project', () => {
    const project = seedProject();
    const task = createTask(db, {
      projectId: project.id,
      title: 'Draft kickoff',
      status: 'TODO',
      priority: 'HIGH',
    });
    expect(task.title).toBe('Draft kickoff');
    expect(task.projectId).toBe(project.id);
    expect(task.status).toBe('TODO');
    expect(task.revision).toBe(1);
  });

  it('seeds a checklist template for a typed task', () => {
    const project = seedProject();
    const task = createTask(db, {
      projectId: project.id,
      title: 'Blog',
      status: 'TODO',
      priority: 'MEDIUM',
      taskType: 'BLOG_POST',
    });
    expect(task.checklist.length).toBeGreaterThan(0);
  });

  it('refuses a stale task revision with RevisionConflictError', () => {
    const project = seedProject();
    const task = createTask(db, {
      projectId: project.id,
      title: 'Draft kickoff',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    updateTask(db, task.id, { title: 'First writer' }, task.revision);
    expect(() => updateTask(db, task.id, { title: 'Stale writer' }, task.revision)).toThrowError(
      expect.objectContaining<Partial<RevisionConflictError>>({
        name: 'RevisionConflictError',
        code: 'conflict',
        currentRevision: task.revision + 1,
        changedFields: ['title'],
      }),
    );
  });

  it('updates a project and advances revision', () => {
    const project = seedProject();
    const updated = updateProject(db, project.id, { name: 'Retainer Plus' }, project.revision);
    expect(updated.name).toBe('Retainer Plus');
    expect(updated.revision).toBe(project.revision + 1);
  });

  it('manages checklist items with an optional parent revision', () => {
    const project = seedProject();
    const task = createTask(db, {
      projectId: project.id,
      title: 'Checklist host',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const withItem = addChecklistItem(db, task.id, 'First item', task.revision);
    expect(withItem.checklist.some((item) => item.text === 'First item')).toBe(true);
    expect(withItem.revision).toBe(task.revision + 1);
    const itemId = withItem.checklist.find((item) => item.text === 'First item')!.id;
    const toggled = updateChecklistItem(db, itemId, { completed: true }, withItem.revision);
    expect(toggled.checklist.find((item) => item.id === itemId)?.completed).toBe(true);
    const cleared = removeChecklistItem(db, itemId, toggled.revision);
    expect(cleared.checklist.some((item) => item.id === itemId)).toBe(false);
  });

  it('adds and removes dependencies with revision', () => {
    const project = seedProject();
    const foundation = createTask(db, {
      projectId: project.id,
      title: 'Foundation',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const blocked = createTask(db, {
      projectId: project.id,
      title: 'Blocked',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const linked = addDependency(db, blocked.id, foundation.id, blocked.revision);
    expect(linked.dependencyIds).toContain(foundation.id);
    const again = addDependency(db, blocked.id, foundation.id, linked.revision);
    expect(again.dependencyIds).toContain(foundation.id);
    const unlinked = removeDependency(db, blocked.id, foundation.id, again.revision);
    expect(unlinked.dependencyIds).not.toContain(foundation.id);
    expect(() =>
      removeDependency(db, '22222222-2222-4222-8222-222222222222', foundation.id, 1),
    ).toThrow(WorkspaceNotFoundError);
  });

  it('refuses a circular dependency', () => {
    const project = seedProject();
    const a = createTask(db, {
      projectId: project.id,
      title: 'Task A',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    const b = createTask(db, {
      projectId: project.id,
      title: 'Task B',
      status: 'TODO',
      priority: 'MEDIUM',
    });
    addDependency(db, b.id, a.id, b.revision);
    const aRev = (
      db.prepare('SELECT revision FROM tasks WHERE id=?').get(a.id) as { revision: number }
    ).revision;
    expect(() => addDependency(db, a.id, b.id, aRev)).toThrow(/circular/i);
  });

  it('deletes a task and a project without touching Drive', () => {
    const project = seedProject();
    const task = createTask(db, {
      projectId: project.id,
      title: 'Temporary',
      status: 'BACKLOG',
      priority: 'LOW',
    });
    expect(deleteTask(db, task.id)).toMatchObject({
      ok: true,
      deleted: 'task',
      driveTouched: false,
    });
    const result = deleteProject(db, project.id);
    expect(result).toEqual({
      ok: true,
      deleted: 'project',
      name: 'Retainer',
      driveTouched: false,
    });
  });

  it('refuses invalid creates and missing entities', () => {
    expect(() =>
      createProject(db, {
        clientId: '11111111-1111-4111-8111-111111111111',
        name: 'Orphan',
      }),
    ).toThrow(WorkspaceValidationError);
    const project = seedProject();
    expect(() =>
      createTask(db, {
        projectId: '22222222-2222-4222-8222-222222222222',
        title: 'Missing project',
      }),
    ).toThrow(WorkspaceValidationError);
    expect(() => updateTask(db, '22222222-2222-4222-8222-222222222222', { title: 'x' }, 1)).toThrow(
      WorkspaceNotFoundError,
    );
    expect(() => deleteProject(db, '22222222-2222-4222-8222-222222222222')).toThrow(
      WorkspaceNotFoundError,
    );
    void project;
  });

  it('reads and writes branding and view defaults', () => {
    expect(readBranding(db).title).toBe(DEFAULT_BRANDING.title);
    expect(readViewDefaults(db)).toEqual(CANONICAL_VIEW_DEFAULTS);
    const branding = updateBranding(db, { ...DEFAULT_BRANDING, title: 'Hybrid MCP' });
    expect(branding.branding.title).toBe('Hybrid MCP');
    expect(updateViewDefaults(db, CANONICAL_VIEW_DEFAULTS).viewDefaults).toEqual(
      CANONICAL_VIEW_DEFAULTS,
    );
  });
});
