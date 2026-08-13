import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, ChevronRight, ExternalLink, FileText, Plus, Trash2 } from 'lucide-react';
import { send } from '../api';
import type { Project, Task } from '../../../shared/types';
import { type Modal } from './App';
import { formatDate } from './formatting';
import { TagChip } from './FormControls';
import { Due, Empty, PriorityBadge, StatusDot } from './Primitives';
import { STATUS_LABEL } from './ui-shared';
import { PageHead } from './Shell';

export function ProjectDetail({
  projects,
  tasks,
  open,
  remember,
  refresh,
  flash,
}: {
  projects: Project[];
  tasks: Task[];
  open: (m: Modal) => void;
  remember: (id: string) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const { id } = useParams();
  const nav = useNavigate();
  const p = projects.find((x) => x.id === id);
  const projectId = p?.id;
  useEffect(() => {
    if (projectId) remember(projectId);
  }, [projectId, remember]);
  if (!p) return <Empty title="Project not found" body="Return to Projects to choose another." />;
  const mine = tasks.filter((t) => t.projectId === id);
  const remove = async () => {
    if (
      !confirm(
        `Delete project “${p.name}” from Command Center?\n\nThis removes the project and its tasks from the app only. Drive folders and files are not touched.`,
      )
    )
      return;
    try {
      await send(`/projects/${p.id}`, 'DELETE');
      await refresh();
      flash('Project deleted from Command Center. Drive files were left alone.');
      nav('/projects');
    } catch (e) {
      flash((e as Error).message, 'error');
    }
  };
  return (
    <>
      <div className="backline">
        <Link to="/projects">← All projects</Link>
      </div>
      <PageHead
        focusOnMount
        eyebrow={p.clientName || 'Project'}
        title={p.name}
        body={p.description || 'Project tasks, deadline, and Drive workspace.'}
        action={
          <div className="head-actions">
            {p.driveFolderUrl && (
              <a
                className="secondary buttonlike"
                href={p.driveFolderUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open Drive <ExternalLink />
              </a>
            )}
            <button onClick={() => open({ type: 'task', projectId: p.id })}>
              <Plus /> New task
            </button>
          </div>
        }
      />
      <div className="project-summary">
        <div>
          <span>Status</span>
          <strong>{p.status.replace('_', ' ')}</strong>
        </div>
        <div>
          <span>Deadline</span>
          <strong>{p.targetDeadline ? formatDate(p.targetDeadline) : 'Not set'}</strong>
        </div>
        <div>
          <span>Priority</span>
          <strong>{p.priority}</strong>
        </div>
        <div>
          <span>Task health</span>
          <strong>{mine.filter((t) => t.overdue).length} overdue</strong>
        </div>
      </div>
      {p.categories.length > 0 && (
        <ul className="tag-list" aria-label={`Categories on ${p.name}`}>
          {p.categories.map((category) => (
            <li key={category.id}>
              <TagChip tag={category} />
            </li>
          ))}
        </ul>
      )}
      <div className="detail-actions">
        <Link className="buttonlike" to={`/status?project=${p.id}`}>
          Open project status <ArrowRight />
        </Link>
        <Link className="buttonlike secondary" to={`/files?project=${p.id}`}>
          <FileText /> Browse files
        </Link>
        <button className="secondary" onClick={() => open({ type: 'project', value: p })}>
          Edit project
        </button>
        <button className="secondary danger-outline" onClick={remove}>
          <Trash2 /> Delete project
        </button>
      </div>
      {/* Stated where deleting is, not only in the confirmation: the Drive folder this page
          links to outlives the record, and that is easiest to believe before the prompt. */}
      <p className="field-hint">
        Deleting this project removes it and its tasks from Command Center only. Its Drive folder
        and every file in it are left exactly as they are.
      </p>
      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">Execution</span>
            <h2>All project tasks</h2>
          </div>
        </div>
        {mine.length ? (
          <div className="task-table">
            {mine.map((t) => (
              <button key={t.id} onClick={() => open({ type: 'taskDetail', value: t })}>
                <StatusDot status={t.status} />
                <div>
                  <strong>{t.title}</strong>
                  <span>{STATUS_LABEL[t.status]}</span>
                </div>
                <PriorityBadge priority={t.priority} />
                <Due task={t} />
                <ChevronRight />
              </button>
            ))}
          </div>
        ) : (
          <Empty compact title="No tasks yet" body="Create a task to start planning the work." />
        )}
      </section>
    </>
  );
}
