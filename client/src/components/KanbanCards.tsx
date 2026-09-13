import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, GripVertical, ListChecks, Play, ShieldAlert } from 'lucide-react';
import type { Task, TaskStatus } from '../../../shared/types';
import { startTaskPath } from '../../../shared/start-task';
import { TASK_STATUSES } from '../../../shared/types';
import { type Modal } from './App';
import { TagChip } from './FormControls';
import { Due, PriorityBadge, TaskTypeBadge } from './Primitives';
import { STATUS_HELP, STATUS_LABEL } from './ui-shared';

export function KanbanColumn({
  status,
  tasks,
  open,
  move,
}: {
  status: TaskStatus;
  tasks: Task[];
  open: (m: Modal) => void;
  move: (t: Task, s: TaskStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <section className={`kanban-column ${isOver ? 'drop-active' : ''}`}>
      <header>
        <div>
          <span className={`status-dot ${status.toLowerCase()}`} />
          <h2>{STATUS_LABEL[status]}</h2>
          <span className="count">{tasks.length}</span>
        </div>
        <p>{STATUS_HELP[status]}</p>
      </header>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {tasks.map((t) => (
            <KanbanCard key={t.id} task={t} open={open} move={move} />
          ))}
          {!tasks.length && <div className="column-empty">Drop tasks here</div>}
        </div>
      </SortableContext>
    </section>
  );
}

function KanbanCard({
  task,
  open,
  move,
}: {
  task: Task;
  open: (m: Modal) => void;
  move: (t: Task, s: TaskStatus) => void;
}) {
  const navigate = useNavigate();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`kanban-card ${isDragging ? 'dragging' : ''} ${task.overdue ? 'is-overdue' : ''} ${task.blocked ? 'is-blocked' : ''}`}
    >
      <div className="card-labels">
        <div className="card-labels-chips">
          <PriorityBadge priority={task.priority} />
          {task.taskType && <TaskTypeBadge type={task.taskType} />}
          {task.blocked && (
            <span className="blocked-label">
              <ShieldAlert /> Blocked
            </span>
          )}
          {task.overdue && (
            <span className="overdue-label">
              <AlertCircle /> Overdue
            </span>
          )}
        </div>
        <button
          type="button"
          className="card-start-task"
          aria-label={`Start Task for ${task.title}`}
          onClick={() => navigate(startTaskPath(task.id))}
        >
          <Play /> Start Task
        </button>
      </div>
      <button className="card-title" onClick={() => open({ type: 'taskDetail', value: task })}>
        <strong>{task.title}</strong>
        <span>
          {task.clientName} · {task.projectName}
        </span>
      </button>
      {task.tags.length > 0 && (
        <ul className="tag-list" aria-label={`Tags on ${task.title}`}>
          {task.tags.map((tag) => (
            <li key={tag.id}>
              <TagChip tag={tag} />
            </li>
          ))}
        </ul>
      )}
      {task.description && <p className="card-description">{task.description}</p>}
      {task.notes && (
        <div className="card-notes">
          <strong>Notes</strong>
          <p>{task.notes}</p>
        </div>
      )}
      <div className="card-foot">
        <Due task={task} />
        {task.checklistTotal > 0 && (
          <span>
            <ListChecks />
            {task.checklistCompleted}/{task.checklistTotal}
          </span>
        )}
        <button
          className="drag-handle"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${task.title}`}
        >
          <GripVertical />
        </button>
      </div>
      <label className="keyboard-move">
        <span className="sr-only">Move task status</span>
        <select value={task.status} onChange={(e) => move(task, e.target.value as TaskStatus)}>
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}
