import { useEffect, useState } from 'react';
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
  LayoutGrid,
  List,
  Plus,
  Settings,
  Tags as TagsIcon,
  Trash2,
} from 'lucide-react';
import { send } from '../api';
import type { Category, Client, Priority, Project, Task } from '../../../shared/types';
import { compareProjectActivity, compareProjectNames } from '../../../shared/types';
import {
  PROJECT_SORTS,
  PROJECT_VISIBILITIES,
  resolveViewChoice,
  type ProjectSort,
  type ViewDefaults,
} from '../../../shared/view-defaults';
import {
  CANONICAL_PROJECT_PRESENTATION,
  LIVE_PROJECT_STATUSES,
  LIVE_PROJECT_STATUS_LABEL,
  PROJECT_PRESENTATIONS,
  parseLiveProjectStatuses,
  serializeLiveProjectStatuses,
  type LiveProjectStatus,
  type ProjectPresentation,
} from '../../../shared/project-view';
import { type Modal } from './App';
import { formatDate } from './formatting';
import { TagChip } from './FormControls';
import { DriveBadge, Empty, ProjectStatusChip, SearchBox } from './Primitives';
import { projectStatusStyle } from './project-status';
import { tagAccent } from './ui-shared';
import { PageHead } from './Shell';

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
  viewDefaults,
  open,
  refresh,
  flash,
}: {
  projects: Project[];
  updateProjects: (projects: Project[]) => void;
  clients: Client[];
  categories: Category[];
  tasks: Task[];
  viewDefaults: ViewDefaults;
  open: (m: Modal) => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState('');
  const [params, setParams] = useSearchParams();
  // Durable collection state lives in the address. Search stays local because it is transient
  // text typed for this visit rather than a view someone is likely to bookmark or share.
  const sortBy = resolveViewChoice(params.get('sort'), PROJECT_SORTS, viewDefaults.projects.sort);
  const presentation = resolveViewChoice(
    params.get('view'),
    PROJECT_PRESENTATIONS,
    CANONICAL_PROJECT_PRESENTATION,
  );
  const clientFilter = params.get('client') || '';
  const visibility = resolveViewChoice(
    params.get('visibility'),
    PROJECT_VISIBILITIES,
    viewDefaults.projects.visibility,
  );
  const selectedCategoryIds = (params.get('categories') || '').split(',').filter(Boolean);
  // Live status filters are OR within the dimension and AND with client/category/search. They
  // never include ARCHIVED — that scope stays on visibility — so the two cannot silently cancel.
  const selectedStatuses = parseLiveProjectStatuses(params.get('statuses'));
  const setParam = (key: string, value: string, defaultValue = '') => {
    const next = new URLSearchParams(params);
    if (value && value !== defaultValue) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };
  const setCategoryIds = (ids: string[]) => setParam('categories', ids.join(','));
  const setStatuses = (statuses: LiveProjectStatus[]) =>
    setParam('statuses', serializeLiveProjectStatuses(statuses));
  const setPresentation = (value: ProjectPresentation) =>
    setParam('view', value, CANONICAL_PROJECT_PRESENTATION);
  // Client choices track the visibility toggle so Live never offers a client whose projects
  // are all hidden, matching the same filter the project list itself applies. This keys off
  // project status rather than the client's own status: an active client with only archived
  // projects still belongs in the Archived dropdown, not the Live one.
  const clientIdsForVisibility = new Set(
    projects
      .filter(
        (p) =>
          visibility === 'all' ||
          (visibility === 'archived' ? p.status === 'ARCHIVED' : p.status !== 'ARCHIVED'),
      )
      .map((p) => p.clientId),
  );
  const clientOptions = clients.filter((c) => clientIdsForVisibility.has(c.id));
  // A client named by the URL can fall out of scope when visibility changes (e.g. a bookmark
  // for an archived-only client, revisited under Live). Falling back to "no filter" here keeps
  // the list correct on this same render; the effect below then cleans the bookmark itself so
  // the address bar does not keep pointing at a choice the dropdown no longer offers.
  const clientFilterValid = !clientFilter || clientOptions.some((c) => c.id === clientFilter);
  const effectiveClientFilter = clientFilterValid ? clientFilter : '';
  useEffect(() => {
    if (!clientFilterValid) setParam('client', '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientFilterValid]);
  // Drop unknown or out-of-order status tokens so a shared link cannot keep ARCHIVED (or
  // nonsense) beside a live-status filter that never accepts them.
  useEffect(() => {
    const raw = params.get('statuses');
    if (raw === null) return;
    const cleaned = serializeLiveProjectStatuses(parseLiveProjectStatuses(raw));
    if (cleaned !== raw) setParam('statuses', cleaned);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  // Archived visibility and live-status filters contradict: clearing the statuses from the
  // address (rather than silently ignoring them) keeps a shared link honest.
  useEffect(() => {
    if (visibility === 'archived' && selectedStatuses.length > 0) setStatuses([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility, selectedStatuses.length]);
  const statusFilterActive = visibility !== 'archived' && selectedStatuses.length > 0;
  const visible = projects.filter(
    (p) =>
      (visibility === 'all' ||
        (visibility === 'archived' ? p.status === 'ARCHIVED' : p.status !== 'ARCHIVED')) &&
      (!statusFilterActive || selectedStatuses.includes(p.status as LiveProjectStatus)) &&
      (!effectiveClientFilter || p.clientId === effectiveClientFilter) &&
      // Every selected category must be present, so each chip narrows the list the way the
      // selects beside it do rather than widening it.
      selectedCategoryIds.every((id) => p.categories.some((category) => category.id === id)) &&
      `${p.name} ${p.clientName}`.toLowerCase().includes(query.toLowerCase()),
  );
  const sortedVisible = [...visible].sort(projectComparator(sortBy));
  // Manual order and a sort rule cannot both win, so dragging belongs to Custom alone.
  // List mode keeps Custom as a sort but explains that rearranging is grid-only — a dropped
  // row would have nowhere visual to land that matches the tile grid's positions.
  const rearrangeable = sortBy === 'custom' && presentation === 'grid';
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
  const orderHint =
    presentation === 'list'
      ? sortBy === 'custom'
        ? 'Custom order is kept, but rearranging by hand is available in Grid view only.'
        : 'Switch to Grid and Custom order to arrange projects by hand.'
      : rearrangeable
        ? 'Drag a tile by its grip, or use its position selector, to arrange projects by hand.'
        : 'Switch to Custom order to arrange tiles by hand.';
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
      <div className="project-toolbar">
        <div
          className="segmented-control project-visibility"
          role="group"
          aria-label="Project visibility"
        >
          {(['live', 'archived', 'all'] as const).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={visibility === value}
              onClick={() => setParam('visibility', value, viewDefaults.projects.visibility)}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
        <div
          className="segmented-control project-presentation"
          role="group"
          aria-label="Project presentation"
        >
          <button
            type="button"
            aria-pressed={presentation === 'grid'}
            onClick={() => setPresentation('grid')}
          >
            <LayoutGrid aria-hidden="true" /> Grid
          </button>
          <button
            type="button"
            aria-pressed={presentation === 'list'}
            onClick={() => setPresentation('list')}
          >
            <List aria-hidden="true" /> List
          </button>
        </div>
      </div>
      <div className="filterbar">
        <SearchBox value={query} set={setQuery} placeholder="Search projects…" />
        <select
          value={effectiveClientFilter}
          onChange={(e) => setParam('client', e.target.value)}
          aria-label="Filter by client"
        >
          <option value="">All clients</option>
          {clientOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={sortBy}
          onChange={(e) => setParam('sort', e.target.value, viewDefaults.projects.sort)}
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
      {visibility !== 'archived' && (
        <div className="tag-filter">
          <span className="tag-filter-label" id="status-filter-label">
            Status
          </span>
          <div role="group" aria-labelledby="status-filter-label">
            {LIVE_PROJECT_STATUSES.map((status) => {
              const active = selectedStatuses.includes(status);
              return (
                <button
                  key={status}
                  type="button"
                  className={`tag-chip toggle status-filter-chip${active ? ' active' : ''}`}
                  aria-pressed={active}
                  style={projectStatusStyle(status)}
                  onClick={() =>
                    setStatuses(
                      active
                        ? selectedStatuses.filter((value) => value !== status)
                        : [...selectedStatuses, status],
                    )
                  }
                >
                  {LIVE_PROJECT_STATUS_LABEL[status]}
                </button>
              );
            })}
          </div>
          {selectedStatuses.length > 0 && (
            <button type="button" className="text-btn" onClick={() => setStatuses([])}>
              Clear statuses
            </button>
          )}
        </div>
      )}
      {visibility === 'archived' && (
        <p className="filterbar-hint">
          Status filters apply to live projects. Switch to Live or All to narrow by planning status.
        </p>
      )}
      {selectedStatuses.length > 1 && visibility !== 'archived' && (
        <p className="filterbar-hint">Showing projects that match any selected status.</p>
      )}
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
      <p className="filterbar-hint">{orderHint}</p>
      {presentation === 'grid' ? (
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
      ) : (
        <div className="project-rows" role="list">
          {sortedVisible.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              tasks={tasks}
              open={open}
              archive={archive}
              remove={remove}
            />
          ))}
        </div>
      )}
      {!visible.length && (
        <Empty title="No projects found" body="Adjust your filters or create a new project." />
      )}
    </>
  );
}

function ProjectActions({
  project,
  open,
  archive,
  remove,
}: {
  project: Project;
  open: (m: Modal) => void;
  archive: (p: Project) => void;
  remove: (p: Project) => void;
}) {
  return (
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
    </div>
  );
}

function ProjectRow({
  project,
  tasks,
  open,
  archive,
  remove,
}: {
  project: Project;
  tasks: Task[];
  open: (m: Modal) => void;
  archive: (p: Project) => void;
  remove: (p: Project) => void;
}) {
  const mine = tasks.filter((t) => t.projectId === project.id),
    done = mine.filter((t) => t.status === 'COMPLETE').length,
    over = mine.filter((t) => t.overdue).length;
  return (
    <article
      className="project-row"
      data-status={project.status}
      style={projectStatusStyle(project.status)}
      role="listitem"
    >
      <div className="project-row-main">
        <ProjectStatusChip status={project.status} />
        <Link to={`/projects/${project.id}`} className="project-row-link">
          <span className="client-name">{project.clientName}</span>
          <strong>{project.name}</strong>
        </Link>
        <DriveBadge status={project.driveStatus} />
      </div>
      <div className="project-row-meta">
        <span>
          {done}/{mine.length} tasks
        </span>
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
      <ProjectActions project={project} open={open} archive={archive} remove={remove} />
    </article>
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
  // Every block below is a direct child of the tile, because the tile is one column with one
  // gap in `styles.css` rather than a stack of margins. That is what lets the category list
  // appear, disappear, or wrap to a second line without changing what surrounds it.
  return (
    <article
      ref={setNodeRef}
      // The status palette travels with the tile, so the chip and the tile it sits on are
      // tinted from one entry rather than from two rules that can drift apart.
      style={{
        ...projectStatusStyle(project.status),
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={`project-tile${isDragging ? ' dragging' : ''}`}
      data-status={project.status}
    >
      <div className="project-card-head">
        <ProjectStatusChip status={project.status} />
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
