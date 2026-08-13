import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  AlertCircle,
  Archive,
  CalendarDays,
  Check,
  GripVertical,
  Plus,
  Settings,
  Tags as TagsIcon,
  Trash2,
} from 'lucide-react';
import { send } from '../api';
import type { Category, Client, Priority, Project, Task } from '../../../shared/types';
import { compareProjectActivity, compareProjectNames } from '../../../shared/types';
import { type Modal } from './App';
import { formatDate } from './formatting';
import { TagChip } from './FormControls';
import { DriveBadge, Empty, SearchBox } from './Primitives';
import { tagAccent } from './ui-shared';
import { PageHead } from './Shell';

type ProjectSort =
  | 'recently-updated'
  | 'recently-created'
  | 'name-ascending'
  | 'name-descending'
  | 'deadline'
  | 'priority'
  | 'custom';

const PROJECT_PRIORITY_ORDER: Record<Priority, number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function projectComparator(sortBy: ProjectSort) {
  return (a: Project, b: Project) => {
    if (sortBy === 'recently-updated') return compareProjectActivity(a, b);
    if (sortBy === 'recently-created') {
      return b.createdAt.localeCompare(a.createdAt) || compareProjectNames(a, b);
    }
    if (sortBy === 'name-ascending') return compareProjectNames(a, b);
    if (sortBy === 'name-descending') return compareProjectNames(b, a);
    if (sortBy === 'deadline') {
      if (!a.targetDeadline) return b.targetDeadline ? 1 : compareProjectNames(a, b);
      if (!b.targetDeadline) return -1;
      return a.targetDeadline.localeCompare(b.targetDeadline) || compareProjectNames(a, b);
    }
    if (sortBy === 'priority') {
      return (
        PROJECT_PRIORITY_ORDER[a.priority] - PROJECT_PRIORITY_ORDER[b.priority] ||
        compareProjectNames(a, b)
      );
    }
    // Custom. Projects that have never been dragged all share position 0, so the sort
    // stays stable and they keep the order the API returned them in.
    if (sortBy === 'custom') return a.position - b.position;
    return 0;
  };
}

export function Projects({
  projects,
  updateProjects,
  clients,
  categories,
  tasks,
  open,
  refresh,
  flash,
}: {
  projects: Project[];
  updateProjects: (projects: Project[]) => void;
  clients: Client[];
  categories: Category[];
  tasks: Task[];
  open: (m: Modal) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState(''),
    [clientFilter, setClientFilter] = useState(''),
    [sortBy, setSortBy] = useState<ProjectSort>('recently-updated');
  const [params, setParams] = useSearchParams();
  // The category selection lives in the page address, as the board's filters do, so a
  // filtered Projects view survives a reload and can be handed to someone else as a link.
  const selectedCategoryIds = (params.get('categories') || '').split(',').filter(Boolean);
  const setCategoryIds = (ids: string[]) => {
    const next = new URLSearchParams(params);
    if (ids.length) next.set('categories', ids.join(','));
    else next.delete('categories');
    setParams(next);
  };
  const visible = projects.filter(
    (p) =>
      (!clientFilter || p.clientId === clientFilter) &&
      // Every selected category must be present, so each chip narrows the list the way the
      // selects beside it do rather than widening it.
      selectedCategoryIds.every((id) => p.categories.some((category) => category.id === id)) &&
      `${p.name} ${p.clientName}`.toLowerCase().includes(query.toLowerCase()),
  );
  const sortedVisible = [...visible].sort(projectComparator(sortBy));
  // Manual order and a sort rule cannot both win, so dragging belongs to Custom alone.
  // Anywhere else a dropped tile would spring back to its sorted place and read as a bug.
  const rearrangeable = sortBy === 'custom';
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  /**
   * Moves `project` to where `overId` currently sits. Positions are rewritten across every
   * project, not just the filtered tiles, so reordering a search result cannot collide with
   * the positions of projects the filter is hiding.
   */
  const reorder = async (project: Project, overId: string) => {
    const oldIndex = projects.findIndex((p) => p.id === project.id);
    const newIndex = projects.findIndex((p) => p.id === overId);
    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
    const reordered = arrayMove(projects, oldIndex, newIndex).map((p, position) => ({
      ...p,
      position,
    }));
    updateProjects(reordered);
    try {
      await send('/projects/reorder', 'POST', { orderedIds: reordered.map((p) => p.id) });
      await refresh();
      flash('Project order saved.');
    } catch (e) {
      updateProjects(projects);
      flash((e as Error).message, 'error');
    }
  };
  const dragEnd = (event: DragEndEvent) => {
    if (!event.over || event.over.id === event.active.id) return;
    const project = projects.find((p) => p.id === event.active.id);
    if (project) reorder(project, String(event.over.id));
  };
  /** Keyboard equivalent of dropping a tile onto the tile currently at `nextIndex`. */
  const moveToIndex = (project: Project, nextIndex: number) => {
    const target = sortedVisible[nextIndex];
    if (target) reorder(project, target.id);
  };
  const archive = async (p: Project) => {
    if (!confirm(`Archive ${p.name}? Tasks and Drive files will be preserved.`)) return;
    await send(`/projects/${p.id}/archive`, 'POST');
    await refresh();
    flash('Project archived.');
  };
  const remove = async (p: Project) => {
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
    } catch (e) {
      flash((e as Error).message, 'error');
    }
  };
  return (
    <>
      <PageHead
        eyebrow="Workstreams"
        title="Projects"
        body="Track scope, deadlines, task health, and storage from one view. Projects are owned by Command Center — not by Drive folder names."
        action={
          <button onClick={() => open({ type: 'project' })}>
            <Plus /> New project
          </button>
        }
      />
      <div className="filterbar">
        <SearchBox value={query} set={setQuery} placeholder="Search projects…" />
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as ProjectSort)}
          aria-label="Sort projects by"
        >
          <option value="recently-updated">Recently updated</option>
          <option value="recently-created">Recently created</option>
          <option value="name-ascending">Name A–Z</option>
          <option value="name-descending">Name Z–A</option>
          <option value="deadline">Deadline (soonest)</option>
          <option value="priority">Priority (highest)</option>
          <option value="custom">Custom order</option>
        </select>
      </div>
      {categories.length > 0 && (
        <div className="tag-filter">
          <span className="tag-filter-label" id="category-filter-label">
            <TagsIcon /> Categories
          </span>
          <div role="group" aria-labelledby="category-filter-label">
            {categories.map((category) => {
              const active = selectedCategoryIds.includes(category.id);
              return (
                <button
                  key={category.id}
                  type="button"
                  className={`tag-chip toggle ${active ? 'active' : ''}`}
                  aria-pressed={active}
                  style={{ borderColor: tagAccent(category) }}
                  onClick={() =>
                    setCategoryIds(
                      active
                        ? selectedCategoryIds.filter((id) => id !== category.id)
                        : [...selectedCategoryIds, category.id],
                    )
                  }
                >
                  <span className="tag-dot" style={{ background: tagAccent(category) }} />
                  {category.name}
                </button>
              );
            })}
          </div>
          {selectedCategoryIds.length > 0 && (
            <button type="button" className="text-btn" onClick={() => setCategoryIds([])}>
              Clear categories
            </button>
          )}
        </div>
      )}
      {selectedCategoryIds.length > 1 && (
        <p className="filterbar-hint">Showing projects that carry every selected category.</p>
      )}
      <p className="filterbar-hint">
        {rearrangeable
          ? 'Drag a tile by its grip, or use its position selector, to arrange projects by hand.'
          : 'Switch to Custom order to arrange tiles by hand.'}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={dragEnd}>
        <SortableContext items={sortedVisible.map((p) => p.id)} strategy={rectSortingStrategy}>
          <div className="project-cards">
            {sortedVisible.map((p, index) => (
              <ProjectTile
                key={p.id}
                project={p}
                tasks={tasks}
                index={index}
                total={sortedVisible.length}
                rearrangeable={rearrangeable}
                open={open}
                archive={archive}
                remove={remove}
                moveToIndex={moveToIndex}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {!visible.length && (
        <Empty title="No projects found" body="Adjust your filters or create a new project." />
      )}
    </>
  );
}

function ProjectTile({
  project,
  tasks,
  index,
  total,
  rearrangeable,
  open,
  archive,
  remove,
  moveToIndex,
}: {
  project: Project;
  tasks: Task[];
  index: number;
  total: number;
  rearrangeable: boolean;
  open: (m: Modal) => void;
  archive: (p: Project) => void;
  remove: (p: Project) => void;
  moveToIndex: (p: Project, nextIndex: number) => void;
}) {
  // Listeners sit on the grip alone. A tile is mostly a <Link>, and dragging the whole
  // surface would fight navigation.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    disabled: !rearrangeable,
  });
  const mine = tasks.filter((t) => t.projectId === project.id),
    done = mine.filter((t) => t.status === 'COMPLETE').length,
    over = mine.filter((t) => t.overdue).length;
  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'dragging' : ''}
    >
      <div className="project-card-head">
        <span className="status-label">{project.status.replace('_', ' ')}</span>
        <DriveBadge status={project.driveStatus} />
      </div>
      <Link to={`/projects/${project.id}`}>
        <span className="client-name">{project.clientName}</span>
        <h2>{project.name}</h2>
        <p>{project.description || 'No project description yet.'}</p>
      </Link>
      {project.categories.length > 0 && (
        <ul className="tag-list" aria-label={`Categories on ${project.name}`}>
          {project.categories.map((category) => (
            <li key={category.id}>
              <TagChip tag={category} />
            </li>
          ))}
        </ul>
      )}
      <div className="progress">
        <div>
          <span>Task progress</span>
          <strong>
            {done}/{mine.length}
          </strong>
        </div>
        <div className="progress-track">
          <span style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%` }} />
        </div>
      </div>
      <div className="project-meta">
        <span className={over ? 'overdue-text' : ''}>
          {over ? (
            <>
              <AlertCircle />
              {over} overdue
            </>
          ) : (
            <>
              <Check />
              On track
            </>
          )}
        </span>
        <span>
          <CalendarDays />
          {project.targetDeadline ? formatDate(project.targetDeadline) : 'No deadline'}
        </span>
      </div>
      <div className="card-actions">
        <Link className="secondary buttonlike" to={`/status?project=${project.id}`}>
          Open board
        </Link>
        <button
          className="icon-btn"
          onClick={() => open({ type: 'project', value: project })}
          aria-label={`Edit ${project.name}`}
        >
          <Settings />
        </button>
        {project.status !== 'ARCHIVED' && (
          <button
            className="icon-btn danger"
            onClick={() => archive(project)}
            aria-label={`Archive ${project.name}`}
          >
            <Archive />
          </button>
        )}
        <button
          className="icon-btn danger"
          onClick={() => remove(project)}
          aria-label={`Delete ${project.name}`}
        >
          <Trash2 />
        </button>
        <button
          className="drag-handle"
          {...attributes}
          {...listeners}
          disabled={!rearrangeable}
          aria-label={`Drag ${project.name}`}
          title={rearrangeable ? `Drag ${project.name}` : 'Switch to Custom order to rearrange'}
        >
          <GripVertical />
        </button>
      </div>
      <label className="keyboard-move">
        <span className="sr-only">{`Position of ${project.name}`}</span>
        <select
          value={index + 1}
          disabled={!rearrangeable}
          onChange={(e) => moveToIndex(project, Number(e.target.value) - 1)}
        >
          {Array.from({ length: total }, (_, slot) => (
            <option key={slot} value={slot + 1}>
              {`Position ${slot + 1} of ${total}`}
            </option>
          ))}
        </select>
      </label>
    </article>
  );
}
