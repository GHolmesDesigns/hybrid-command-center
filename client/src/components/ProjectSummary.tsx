import type { Project, Task } from '../../../shared/types';
import { formatDate } from './formatting';
import { TagChip } from './FormControls';
import { ProjectStatusChip } from './Primitives';

/** The same project facts and categories on the detail page and a focused Status board. */
export function ProjectSummary({ project, tasks }: { project: Project; tasks: Task[] }) {
  const overdue = tasks.filter((task) => task.projectId === project.id && task.overdue).length;
  return (
    <>
      <div className="project-summary">
        <div>
          <span>Status</span>
          <ProjectStatusChip status={project.status} />
        </div>
        <div>
          <span>Start date</span>
          <strong>{project.startDate ? formatDate(project.startDate) : 'Not set'}</strong>
        </div>
        <div>
          <span>Planned launch</span>
          <strong>{project.launchDate ? formatDate(project.launchDate) : 'Not set'}</strong>
        </div>
        <div>
          <span>Target deadline</span>
          <strong>{project.targetDeadline ? formatDate(project.targetDeadline) : 'Not set'}</strong>
        </div>
        <div>
          <span>Priority</span>
          <strong>{project.priority}</strong>
        </div>
        <div>
          <span>Task health</span>
          <strong>{overdue} overdue</strong>
        </div>
      </div>
      {project.categories.length > 0 && (
        <ul className="tag-list" aria-label={`Categories on ${project.name}`}>
          {project.categories.map((category) => (
            <li key={category.id}>
              <TagChip tag={category} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
