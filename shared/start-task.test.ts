import { describe, expect, it } from 'vitest';
import {
  resolveGlobalStartTask,
  startTaskPath,
  taskParamSelectionIssue,
  taskStartAvailability,
} from './start-task';
import type { Client, Project, Task } from './types';

const baseClient: Client = {
  id: 'c1',
  name: 'Client',
  slug: 'client',
  status: 'ACTIVE',
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
};

const baseProject: Project = {
  id: 'p1',
  clientId: 'c1',
  name: 'Project',
  status: 'ACTIVE',
  priority: 'MEDIUM',
  position: 0,
  driveStatus: 'DISCONNECTED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lastActivityAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  categories: [],
};

const baseTask: Task = {
  id: 't1',
  projectId: 'p1',
  clientId: 'c1',
  title: 'Task',
  status: 'IN_PROGRESS',
  priority: 'MEDIUM',
  position: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  tags: [],
  checklist: [],
  dependencyIds: [],
  blockingDependencies: [],
  blocked: false,
  overdue: false,
  checklistCompleted: 0,
  checklistTotal: 0,
  revision: 1,
};

describe('start-task', () => {
  it('builds a tasks URL with the task id', () => {
    expect(startTaskPath('abc 123')).toBe('/tasks?task=abc%20123');
  });

  it('prefers the modal task over route and saved session', () => {
    const resolution = resolveGlobalStartTask({
      modalTask: { ...baseTask, id: 'modal' },
      routeTaskId: 'route',
      savedSessionTaskId: 'saved',
      tasks: [
        { ...baseTask, id: 'modal' },
        { ...baseTask, id: 'route' },
        { ...baseTask, id: 'saved' },
      ],
      projects: [baseProject],
      clients: [baseClient],
    });
    expect(resolution).toEqual({ taskId: 'modal', disabledReason: null });
  });

  it('disables when the first matching task is complete', () => {
    const resolution = resolveGlobalStartTask({
      modalTask: { ...baseTask, id: 'modal', status: 'COMPLETE' },
      routeTaskId: 'route',
      savedSessionTaskId: null,
      tasks: [
        { ...baseTask, id: 'modal', status: 'COMPLETE' },
        { ...baseTask, id: 'route' },
      ],
      projects: [baseProject],
      clients: [baseClient],
    });
    expect(resolution.taskId).toBeNull();
    expect(resolution.disabledReason).toMatch(/complete/i);
  });

  it('reports filter exclusion for a valid but hidden task param', () => {
    const issue = taskParamSelectionIssue('t1', baseTask, [baseProject], [baseClient], false);
    expect(issue).toMatch(/filters/i);
  });

  it('marks archived projects unavailable', () => {
    const availability = taskStartAvailability(
      baseTask,
      [{ ...baseProject, status: 'ARCHIVED' }],
      [baseClient],
    );
    expect(availability.available).toBe(false);
  });

  it('marks missing tasks, projects, and archived clients unavailable', () => {
    expect(taskStartAvailability(undefined, [baseProject], [baseClient])).toEqual({
      available: false,
      reason: 'Task not found.',
    });
    expect(
      taskStartAvailability({ ...baseTask, status: 'COMPLETE' }, [baseProject], [baseClient]),
    ).toEqual({
      available: false,
      reason: 'This task is complete.',
    });
    expect(taskStartAvailability(baseTask, [], [baseClient])).toEqual({
      available: false,
      reason: "This task's project is unavailable.",
    });
    expect(
      taskStartAvailability(baseTask, [baseProject], [{ ...baseClient, status: 'ARCHIVED' }]),
    ).toEqual({
      available: false,
      reason: 'This task belongs to an archived client.',
    });
    expect(taskStartAvailability(baseTask, [baseProject], [baseClient])).toEqual({
      available: true,
      reason: null,
    });
  });

  it('falls through route and saved session when earlier contexts are empty', () => {
    expect(
      resolveGlobalStartTask({
        modalTask: null,
        routeTaskId: 'route',
        savedSessionTaskId: 'saved',
        tasks: [
          { ...baseTask, id: 'route' },
          { ...baseTask, id: 'saved' },
        ],
        projects: [baseProject],
        clients: [baseClient],
      }),
    ).toEqual({ taskId: 'route', disabledReason: null });

    expect(
      resolveGlobalStartTask({
        modalTask: null,
        routeTaskId: null,
        savedSessionTaskId: 'saved',
        tasks: [{ ...baseTask, id: 'saved' }],
        projects: [baseProject],
        clients: [baseClient],
      }),
    ).toEqual({ taskId: 'saved', disabledReason: null });
  });

  it('returns idle when no start context is present', () => {
    expect(
      resolveGlobalStartTask({
        modalTask: null,
        routeTaskId: null,
        savedSessionTaskId: null,
        tasks: [baseTask],
        projects: [baseProject],
        clients: [baseClient],
      }),
    ).toEqual({ taskId: null, disabledReason: null });
  });

  it('reports missing, unavailable, and filtered task params', () => {
    expect(taskParamSelectionIssue('missing', undefined, [baseProject], [baseClient], true)).toBe(
      'That task is no longer available.',
    );
    expect(
      taskParamSelectionIssue(
        't1',
        { ...baseTask, status: 'COMPLETE' },
        [baseProject],
        [baseClient],
        true,
      ),
    ).toMatch(/complete/i);
    expect(taskParamSelectionIssue('t1', baseTask, [baseProject], [baseClient], true)).toBeNull();
  });
});
