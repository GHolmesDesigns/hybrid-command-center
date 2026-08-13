import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { Plus, Tag as TagIcon } from 'lucide-react';
import { send } from '../api';
import type { Client, Project, Tag, Task, TaskStatus } from '../../../shared/types';
import { TASK_STATUSES, TASK_TYPES } from '../../../shared/types';
import { isDueNextSevenDays, isDueToday } from '../../../shared/deadlines';
import { type Modal } from './App';
import { KanbanColumn } from './KanbanCards';
import { SearchBox } from './Primitives';
import { STATUS_LABEL, TASK_TYPE_LABEL, tagAccent } from './ui-shared';
import { PageHead } from './Shell';

/**
 * The `type` value that asks for tasks carrying no type at all. Untyped tasks predate the
 * field and are normal work, so they have to be findable rather than merely not excluded.
 * Lowercase, so it can never collide with a `TASK_TYPES` member sharing the same param.
 */
const NO_TASK_TYPE = 'none';

export function Kanban({
  tasks,
  updateTasks,
  clients,
  projects,
  tags,
  open,
  remember,
  refresh,
  flash,
}: {
  tasks: Task[];
  updateTasks: (tasks: Task[]) => void;
  clients: Client[];
  projects: Project[];
  tags: Tag[];
  open: (m: Modal) => void;
  remember: (id: string) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [params, setParams] = useSearchParams();
  // Every filter lives in the URL, so a filtered board survives a reload and can be handed to
  // someone else as a link. Only the search box is component state: it is typed per visit.
  const project = params.get('project') || '',
    client = params.get('client') || '',
    priority = params.get('priority') || '',
    taskType = params.get('type') || '',
    flag = params.get('filter') || '';
  const [query, setQuery] = useState('');
  const selectedTagIds = (params.get('tags') || '').split(',').filter(Boolean);
  useEffect(() => {
    if (project) remember(project);
  }, [project, remember]);
  const needle = query.trim().toLowerCase();
  const filtered = tasks.filter(
    (t) =>
      (!project || t.projectId === project) &&
      (!client || t.clientId === client) &&
      (!priority || t.priority === priority) &&
      (!taskType || (taskType === NO_TASK_TYPE ? !t.taskType : t.taskType === taskType)) &&
      // Every selected tag must be present, so each chip narrows the board the way the
      // selects above it do rather than widening it.
      selectedTagIds.every((tagId) => t.tags.some((tag) => tag.id === tagId)) &&
      (!needle ||
        t.title.toLowerCase().includes(needle) ||
        t.tags.some((tag) => tag.name.toLowerCase().includes(needle))) &&
      (!flag ||
        (flag === 'overdue' && t.overdue) ||
        (flag === 'blocked' && t.blocked) ||
        // The same rules the dashboard counts with, so a tile and the board it links to
        // can never show different sets.
        (flag === 'today' && isDueToday(t)) ||
        (flag === 'week' && isDueNextSevenDays(t)) ||
        (flag === 'none' && !t.dueDate) ||
        (flag === 'completed' && t.status === 'COMPLETE')),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = async (task: Task, status: TaskStatus, overId?: string | number) => {
    const destination = tasks.filter((candidate) => candidate.status === status);
    let reordered: Task[];
    if (task.status === status) {
      const oldIndex = destination.findIndex((candidate) => candidate.id === task.id);
      const overIndex = destination.findIndex((candidate) => candidate.id === overId);
      const newIndex = overIndex >= 0 ? overIndex : destination.length - 1;
      reordered = arrayMove(destination, oldIndex, newIndex);
    } else {
      const withoutTask = destination.filter((candidate) => candidate.id !== task.id);
      const overIndex = withoutTask.findIndex((candidate) => candidate.id === overId);
      const withTask = [...withoutTask, { ...task, status }];
      const newIndex = overIndex >= 0 ? overIndex : withTask.length - 1;
      reordered = arrayMove(withTask, withTask.length - 1, newIndex);
    }
    const orderedIds = reordered.map((candidate) => candidate.id);
    const optimisticTasks = TASK_STATUSES.flatMap((candidateStatus) =>
      candidateStatus === status
        ? reordered.map((candidate, position) => ({ ...candidate, position }))
        : tasks.filter(
            (candidate) => candidate.status === candidateStatus && candidate.id !== task.id,
          ),
    );
    updateTasks(optimisticTasks);

    try {
      await send('/tasks/reorder', 'POST', { taskId: task.id, status, orderedIds });
      await refresh();
      flash(
        task.status === status
          ? `Reordered in ${STATUS_LABEL[status]}.`
          : `Moved to ${STATUS_LABEL[status]}.`,
      );
    } catch (e: any) {
      if (e.status === 409 && e.data?.code === 'TASK_BLOCKED') {
        if (confirm(`${e.message}\n\nComplete anyway and override the dependency block?`)) {
          try {
            await send('/tasks/reorder', 'POST', {
              taskId: task.id,
              status,
              orderedIds,
              overrideBlocked: true,
            });
            await refresh();
            flash('Task completed with dependency override.');
          } catch (overrideError) {
            updateTasks(tasks);
            flash((overrideError as Error).message, 'error');
          }
        } else {
          updateTasks(tasks);
        }
      } else {
        updateTasks(tasks);
        flash(e.message, 'error');
      }
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over) return;
    const task = tasks.find((t) => t.id === event.active.id);
    if (!task) return;
    const overTask = tasks.find((t) => t.id === event.over!.id);
    const status = (
      TASK_STATUSES.includes(event.over.id as TaskStatus) ? event.over.id : overTask?.status
    ) as TaskStatus | undefined;
    if (status) move(task, status, event.over.id);
  };
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  return (
    <>
      <PageHead
        eyebrow="Workflow"
        title="Project Status"
        body={`${filtered.length} visible tasks · move work forward with drag, touch, or keyboard controls.`}
        action={
          <button onClick={() => open({ type: 'task', projectId: project || undefined })}>
            <Plus /> New task
          </button>
        }
      />
      <div className="board-filters">
        <label>
          <span>Client</span>
          <select value={client} onChange={(e) => set('client', e.target.value)}>
            <option value="">All clients</option>
            {clients
              .filter((c) => c.status === 'ACTIVE')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>Project</span>
          <select value={project} onChange={(e) => set('project', e.target.value)}>
            <option value="">All projects</option>
            {projects
              .filter((p) => !client || p.clientId === client)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          <span>Priority</span>
          <select value={priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="">Any priority</option>
            {['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Task type</span>
          <select value={taskType} onChange={(e) => set('type', e.target.value)}>
            <option value="">Any type</option>
            <option value={NO_TASK_TYPE}>No type</option>
            {TASK_TYPES.map((t) => (
              <option key={t} value={t}>
                {TASK_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Focus</span>
          <select value={flag} onChange={(e) => set('filter', e.target.value)}>
            <option value="">All tasks</option>
            <option value="overdue">Overdue</option>
            <option value="today">Due today</option>
            <option value="week">Due this week</option>
            <option value="none">No due date</option>
            <option value="blocked">Blocked</option>
            <option value="completed">Completed</option>
          </select>
        </label>
      </div>
      <SearchBox value={query} set={setQuery} placeholder="Search task titles and tags…" />
      {tags.length > 0 && (
        <div className="tag-filter">
          <span className="tag-filter-label" id="tag-filter-label">
            <TagIcon /> Tags
          </span>
          <div role="group" aria-labelledby="tag-filter-label">
            {tags.map((tag) => {
              const active = selectedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`tag-chip toggle ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  style={{ borderColor: tagAccent(tag) }}
                  onClick={() =>
                    set(
                      'tags',
                      (active
                        ? selectedTagIds.filter((tagId) => tagId !== tag.id)
                        : [...selectedTagIds, tag.id]
                      ).join(','),
                    )
                  }
                >
                  <span className="tag-dot" style={{ background: tagAccent(tag) }} />
                  {tag.name}
                </button>
              );
            })}
          </div>
          {selectedTagIds.length > 0 && (
            <button type="button" className="text-btn" onClick={() => set('tags', '')}>
              Clear tags
            </button>
          )}
        </div>
      )}
      {selectedTagIds.length > 1 && (
        <p className="filterbar-hint">Showing tasks that carry every selected tag.</p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={dragEnd}>
        <div className="kanban-board">
          {TASK_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={filtered.filter((t) => t.status === status)}
              open={open}
              move={move}
            />
          ))}
        </div>
      </DndContext>
    </>
  );
}
