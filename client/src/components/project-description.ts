import type { Project } from '../../../shared/types';

export const projectDescription = (project: Project) =>
  project.description || 'Project tasks, launch plan, deadline, and Drive workspace.';
