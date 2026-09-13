import type { Client, Project, Task } from './types';

export type StartTaskResolution = {
  taskId: string | null;
  disabledReason: string | null;
};

export function startTaskPath(taskId: string) {
  return `/tasks?task=${encodeURIComponent(taskId)}`;
}

export function taskStartAvailability(
  task: Task | undefined,
  projects: Project[],
  clients: Client[],
): { available: boolean; reason: string | null } {
  if (!task) return { available: false, reason: 'Task not found.' };
  if (task.status === 'COMPLETE') return { available: false, reason: 'This task is complete.' };
  const project = projects.find((candidate) => candidate.id === task.projectId);
  if (!project) return { available: false, reason: "This task's project is unavailable." };
  if (project.status === 'ARCHIVED')
    return { available: false, reason: 'This task belongs to an archived project.' };
  const client = clients.find(
    (candidate) => candidate.id === (task.clientId || project.clientId),
  );
  if (client?.status === 'ARCHIVED')
    return { available: false, reason: 'This task belongs to an archived client.' };
  return { available: true, reason: null };
}

/** First matching context wins; an unavailable match disables rather than falling through. */
export function resolveGlobalStartTask(input: {
  modalTask: Task | null;
  routeTaskId: string | null;
  savedSessionTaskId: string | null;
  tasks: Task[];
  projects: Project[];
  clients: Client[];
}): StartTaskResolution {
  const contexts: Array<{ taskId: string | null; task: Task | undefined }> = [
    { taskId: input.modalTask?.id ?? null, task: input.modalTask ?? undefined },
    {
      taskId: input.routeTaskId,
      task: input.routeTaskId
        ? input.tasks.find((candidate) => candidate.id === input.routeTaskId)
        : undefined,
    },
    {
      taskId: input.savedSessionTaskId,
      task: input.savedSessionTaskId
        ? input.tasks.find((candidate) => candidate.id === input.savedSessionTaskId)
        : undefined,
    },
  ];
  for (const context of contexts) {
    if (!context.taskId) continue;
    const { available, reason } = taskStartAvailability(
      context.task,
      input.projects,
      input.clients,
    );
    if (available) return { taskId: context.taskId, disabledReason: null };
    return { taskId: null, disabledReason: reason };
  }
  return { taskId: null, disabledReason: null };
}

export function taskParamSelectionIssue(
  taskId: string,
  task: Task | undefined,
  projects: Project[],
  clients: Client[],
  inFilteredList: boolean,
): string | null {
  if (!task) return 'That task is no longer available.';
  const { available, reason } = taskStartAvailability(task, projects, clients);
  if (!available) return reason;
  if (!inFilteredList) return 'That task is hidden by the current filters.';
  return null;
}
