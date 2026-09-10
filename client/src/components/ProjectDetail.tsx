import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowRight,
  ChevronRight,
  ExternalLink,
  FileText,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import { send } from '../api';
import type { Project, Task, TaskStatus } from '../../../shared/types';
import { TASK_STATUSES } from '../../../shared/types';
import { type Modal } from './App';
import { formatDate } from './formatting';
import { TagChip } from './FormControls';
import { Due, Empty, PriorityBadge, StatusDot } from './Primitives';
import { STATUS_LABEL } from './ui-shared';
import { PageHead } from './Shell';
import { DiscussionPanel } from './DiscussionPanel';

export function ProjectDetail({
  projects,
  tasks,
  updateTasks,
  open,
  remember,
  refresh,
  flash,
}: {
  projects: Project[];
  tasks: Task[];
  updateTasks: (tasks: Task[]) => void;
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
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!p) return <Empty title="Project not found" body="Return to Projects to choose another." />;
  const mine = tasks.filter((t) => t.projectId === id);
  /**
   * The project's tasks in the same stage, in the same order the board's column shows them.
   * Tasks that have never been dragged all share position 0, so the sort stays stable and they
   * keep the order the API returned them in.
   */
  const group = (status: TaskStatus) =>
    mine.filter((t) => t.status === status).sort((a, b) => a.position - b.position);
  const stages = TASK_STATUSES.map((status) => ({ status, tasks: group(status) })).filter(
    (stage) => stage.tasks.length > 0,
  );
  /**
   * Moves `task` to where the task with `overId` currently sits. There is one order per stage
   * and both views read it: positions are rewritten across every task in the stage, not just
   * this project's, so the board's column keeps the tasks it is hiding here exactly where they
   * were and the moved task lands on the slot it was dropped on.
   */
  const reorder = async (task: Task, overId: string) => {
    const column = tasks
      .filter((t) => t.status === task.status)
      .sort((a, b) => a.position - b.position);
    const oldIndex = column.findIndex((t) => t.id === task.id);
    const newIndex = column.findIndex((t) => t.id === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const reordered = arrayMove(column, oldIndex, newIndex).map((t, position) => ({
      ...t,
      position,
    }));
    const moved = new Map(reordered.map((t) => [t.id, t]));
    updateTasks(tasks.map((t) => moved.get(t.id) ?? t));
    try {
      await send('/tasks/reorder', 'POST', {
        taskId: task.id,
        status: task.status,
        orderedIds: reordered.map((t) => t.id),
        // A reorder completes nothing — the task is already in this stage — so the endpoint's
        // guard against completing a blocked task has nothing to guard here.
        overrideBlocked: task.status === 'COMPLETE',
      });
      await refresh();
      flash(`Reordered in ${STATUS_LABEL[task.status]}.`);
    } catch (e) {
      updateTasks(tasks);
      flash((e as Error).message, 'error');
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over || event.over.id === event.active.id) return;
    const task = mine.find((t) => t.id === event.active.id);
    // A row dropped outside its own stage is refused rather than moved: `reorder` looks the
    // target up in the moved task's column and finds nothing there. Changing a task's stage is
    // the board's job, and doing it silently on a drag past a heading would be a surprise.
    if (task) reorder(task, String(event.over.id));
  };
  /** Keyboard equivalent of dropping a row onto the row currently at `nextIndex` in its stage. */
  const moveToIndex = (task: Task, nextIndex: number) => {
    const target = group(task.status)[nextIndex];
    if (target) reorder(task, target.id);
  };
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
        body={p.description || 'Project tasks, launch plan, deadline, and Drive workspace.'}
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
      {/* What the project is, then what can be done to it. One column with one gap, so the
          categories are the same distance from the actions whether there are none of them, one,
          or enough to wrap — see `.project-overview` in `styles.css`. */}
      <div className="project-overview">
        <div className="project-summary">
          <div>
            <span>Status</span>
            <strong>{p.status.replace('_', ' ')}</strong>
          </div>
          <div>
            <span>Planned launch</span>
            <strong>{p.launchDate ? formatDate(p.launchDate) : 'Not set'}</strong>
          </div>
          <div>
            <span>Target deadline</span>
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
      </div>
      <DiscussionPanel
        scopeType="project"
        scopeId={p.id}
        subjectLabel={p.name}
        subjectPath={`/projects/${p.id}`}
      />
      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">Execution</span>
            <h2>All project tasks</h2>
          </div>
        </div>
        {mine.length ? (
          <>
            {/* One order per stage, shared with the board: this page hides the other projects'
                tasks in the same column but never keeps a second arrangement of its own. */}
            <p className="field-hint">
              Tasks are grouped by workflow stage. Drag a row by its grip, or use its position
              selector, to arrange work within a stage — the same order the Status board shows.
            </p>
            <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={dragEnd}>
              {stages.map((stage) => (
                <section key={stage.status} className="task-stage" data-status={stage.status}>
                  <h3>
                    <StatusDot status={stage.status} />
                    {STATUS_LABEL[stage.status]}
                    <span>{stage.tasks.length}</span>
                  </h3>
                  <SortableContext
                    items={stage.tasks.map((t) => t.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="task-table">
                      {stage.tasks.map((t, index) => (
                        <TaskRow
                          key={t.id}
                          task={t}
                          index={index}
                          total={stage.tasks.length}
                          open={open}
                          moveToIndex={moveToIndex}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </section>
              ))}
            </DndContext>
          </>
        ) : (
          <Empty compact title="No tasks yet" body="Create a task to start planning the work." />
        )}
      </section>
    </>
  );
}

function TaskRow({
  task,
  index,
  total,
  open,
  moveToIndex,
}: {
  task: Task;
  index: number;
  total: number;
  open: (m: Modal) => void;
  moveToIndex: (t: Task, nextIndex: number) => void;
}) {
  // Listeners sit on the grip alone. The row itself opens the task, and dragging the whole
  // surface would fight that.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`task-row${isDragging ? ' dragging' : ''}`}
    >
      <button onClick={() => open({ type: 'taskDetail', value: task })}>
        <StatusDot status={task.status} />
        <div>
          <strong>{task.title}</strong>
          <span>{STATUS_LABEL[task.status]}</span>
        </div>
        <PriorityBadge priority={task.priority} />
        <Due task={task} />
        <ChevronRight />
      </button>
      <label className="task-move">
        <span className="sr-only">{`Position of ${task.title}`}</span>
        <select value={index + 1} onChange={(e) => moveToIndex(task, Number(e.target.value) - 1)}>
          {Array.from({ length: total }, (_, slot) => (
            <option key={slot} value={slot + 1}>
              {`${slot + 1} of ${total}`}
            </option>
          ))}
        </select>
      </label>
      <button
        className="drag-handle"
        {...attributes}
        {...listeners}
        aria-label={`Drag ${task.title}`}
        title={`Drag ${task.title}`}
      >
        <GripVertical />
      </button>
    </div>
  );
}
