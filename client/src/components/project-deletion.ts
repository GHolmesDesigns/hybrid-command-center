import type { Project } from '../../../shared/types.ts';

export function signalPostDetachmentCopy(count: number): string {
  return `${count} Signal post${count === 1 ? '' : 's'} will be unassigned, not deleted.`;
}

export function projectDeleteConfirmation(project: Project): string {
  return `Delete project “${project.name}” from Command Center?\n\nThis removes the project and its tasks from the app only. ${signalPostDetachmentCopy(project.signalPostCount)} Drive folders and files are not touched.`;
}

export function projectDeleteSuccess(detachedSignalPosts: number): string {
  return `Project deleted from Command Center. ${detachedSignalPosts} Signal post${detachedSignalPosts === 1 ? '' : 's'} unassigned, not deleted. Drive files were left alone.`;
}
