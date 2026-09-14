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
import { api, send } from '../api';
import type { Client, Project, Tag, Task, TaskStatus } from '../../../shared/types';
import { TASK_STATUSES, TASK_TYPES } from '../../../shared/types';
import { isDueNextSevenDays, isDueToday } from '../../../shared/deadlines';
import { type Modal } from './App';
import { KanbanColumn } from './KanbanCards';
import { SearchBox } from './Primitives';
import { STATUS_LABEL, TASK_TYPE_LABEL, tagAccent } from './ui-shared';
import { PageHead } from './Shell';
import type { TaskFilter, TaskFilterPreset } from '../../../shared/task-filters';
import { MultiSelectFilter, type FilterOption } from './MultiSelectFilter';

/**
 * The `type` value that asks for tasks carrying no type at all. Untyped tasks predate the
 * field and are normal work, so they have to be findable rather than merely not excluded.
 * Lowercase, so it can never collide with a `TASK_TYPES` member sharing the same param.
 */
const NO_TASK_TYPE = 'none';

const parseValues = (value: string | null) => [
  ...new Set((value || '').split(',').filter(Boolean)),
];
const matchesAny = (selected: string[], value?: string) =>
  selected.length === 0 || Boolean(value && selected.includes(value));

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
  const selectedProjectKey = params.get('project') || '';
  const selectedProjects = parseValues(selectedProjectKey),
    selectedClients = parseValues(params.get('client')),
    selectedPriorities = parseValues(params.get('priority')),
    selectedTaskTypes = parseValues(params.get('type')),
    selectedFlags = parseValues(params.get('filter'));
  const [query, setQueryState] = useState('');
  const [presets, setPresets] = useState<TaskFilterPreset[]>([]);
  const setQuery = (value: string) => {
    setQueryState(value);
  };
  const selectedTagIds = parseValues(params.get('tags'));
  useEffect(() => {
    void api<TaskFilterPreset[]>('/task-presets')
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);
  const rememberedProject = selectedProjects[0];
  useEffect(() => {
    if (rememberedProject) remember(rememberedProject);
  }, [rememberedProject, remember]);
  const needle = query.trim().toLowerCase();
  const filtered = tasks.filter(
    (t) =>
      matchesAny(selectedProjects, t.projectId) &&
      matchesAny(selectedClients, t.clientId) &&
      matchesAny(selectedPriorities, t.priority) &&
      (selectedTaskTypes.length === 0 ||
        selectedTaskTypes.some((taskType) =>
          taskType === NO_TASK_TYPE ? !t.taskType : t.taskType === taskType,
        )) &&
      // Every selected tag must be present, so each chip narrows the board the way the
      // selects above it do rather than widening it.
      selectedTagIds.every((tagId) => t.tags.some((tag) => tag.id === tagId)) &&
      (!needle ||
        t.title.toLowerCase().includes(needle) ||
        t.tags.some((tag) => tag.name.toLowerCase().includes(needle))) &&
      (selectedFlags.length === 0 ||
        selectedFlags.some(
          (flag) =>
            (flag === 'overdue' && t.overdue) ||
            (flag === 'blocked' && t.blocked) ||
            // The same rules the dashboard counts with, so a tile and the board it links to
            // can never show different sets.
            (flag === 'today' && isDueToday(t)) ||
            (flag === 'week' && isDueNextSevenDays(t)) ||
            (flag === 'none' && !t.dueDate) ||
            (flag === 'completed' && t.status === 'COMPLETE'),
        )),
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
  const setValues = (key: string, values: string[], next = new URLSearchParams(params)) => {
    const canonical = [...new Set(values)].sort();
    if (canonical.length > 0) next.set(key, canonical.join(','));
    else next.delete(key);
    setParams(next);
  };
  const toggleValue = (key: string, selected: string[], value: string, checked: boolean) => {
    const values = checked ? [...selected, value] : selected.filter((item) => item !== value);
    if (key !== 'client') {
      setValues(key, values);
      return;
    }

    const next = new URLSearchParams(params);
    const canonicalClients = [...new Set(values)].sort();
    if (canonicalClients.length > 0) next.set('client', canonicalClients.join(','));
    else next.delete('client');
    const validProjects = selectedProjects.filter((projectId) => {
      const candidate = projects.find((project) => project.id === projectId);
      return (
        candidate &&
        (canonicalClients.length === 0 || canonicalClients.includes(candidate.clientId))
      );
    });
    if (validProjects.length > 0) next.set('project', [...validProjects].sort().join(','));
    else next.delete('project');
    setParams(next);
  };
  const activeClients = clients.filter((candidate) => candidate.status === 'ACTIVE');
  const availableProjects = projects.filter(
    (candidate) => selectedClients.length === 0 || selectedClients.includes(candidate.clientId),
  );
  const filterOptions: Array<{
    paramKey: string;
    label: string;
    emptyLabel: string;
    selected: string[];
    options: FilterOption[];
  }> = [
    {
      paramKey: 'client',
      label: 'Client',
      emptyLabel: 'All clients',
      selected: selectedClients,
      options: activeClients.map((candidate) => ({ value: candidate.id, label: candidate.name })),
    },
    {
      paramKey: 'project',
      label: 'Project',
      emptyLabel: 'All projects',
      selected: selectedProjects,
      options: availableProjects.map((candidate) => ({
        value: candidate.id,
        label: candidate.name,
      })),
    },
    {
      paramKey: 'priority',
      label: 'Priority',
      emptyLabel: 'Any priority',
      selected: selectedPriorities,
      options: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((value) => ({ value, label: value })),
    },
    {
      paramKey: 'type',
      label: 'Task type',
      emptyLabel: 'Any type',
      selected: selectedTaskTypes,
      options: [
        { value: NO_TASK_TYPE, label: 'No type' },
        ...TASK_TYPES.map((value) => ({ value, label: TASK_TYPE_LABEL[value] })),
      ],
    },
    {
      paramKey: 'filter',
      label: 'Focus',
      emptyLabel: 'All tasks',
      selected: selectedFlags,
      options: [
        { value: 'overdue', label: 'Overdue' },
        { value: 'today', label: 'Due today' },
        { value: 'week', label: 'Due this week' },
        { value: 'none', label: 'No due date' },
        { value: 'blocked', label: 'Blocked' },
        { value: 'completed', label: 'Completed' },
      ],
    },
  ];
  const hasFilters =
    filterOptions.some((filter) => filter.selected.length > 0) || selectedTagIds.length > 0;
  const clearAll = () => {
    const next = new URLSearchParams(params);
    ['client', 'project', 'priority', 'type', 'filter', 'tags'].forEach((key) => next.delete(key));
    setParams(next);
  };
  const currentFilter = (): TaskFilter => ({
    clients: selectedClients,
    projects: selectedProjects,
    priorities: selectedPriorities as TaskFilter['priorities'],
    statuses: [],
    types: selectedTaskTypes as TaskFilter['types'],
    focus: selectedFlags as TaskFilter['focus'],
    tags: selectedTagIds,
    search: query.trim(),
  });
  const applyPreset = (preset: TaskFilterPreset) => {
    const next = new URLSearchParams(params);
    const entries: Array<[string, string[]]> = [
      ['client', preset.filters.clients],
      ['project', preset.filters.projects],
      ['priority', preset.filters.priorities],
      ['type', preset.filters.types],
      ['filter', preset.filters.focus],
      ['tags', preset.filters.tags],
    ];
    for (const [key, values] of entries) {
      if (values.length) next.set(key, values.join(','));
      else next.delete(key);
    }
    setQueryState(preset.filters.search);
    setParams(next);
  };
  const savePreset = async () => {
    const name = window.prompt('Name this task filter preset:');
    if (!name?.trim()) return;
    try {
      const saved = await send<TaskFilterPreset>('/task-presets', 'POST', {
        name,
        filters: currentFilter(),
        scope: 'shared',
      });
      setPresets((current) =>
        [
          ...current.filter((preset) => preset.name.toLowerCase() !== saved.name.toLowerCase()),
          saved,
        ].sort((a, b) => a.name.localeCompare(b.name)),
      );
      flash(`Preset “${saved.name}” saved.`);
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  };
  return (
    <>
      <PageHead
        eyebrow="Workflow"
        title="Project Status"
        body={`${filtered.length} visible tasks · move work forward with drag, touch, or keyboard controls.`}
        action={
          <button
            onClick={() =>
              open({
                type: 'task',
                projectId: selectedProjects.length === 1 ? selectedProjects[0] : undefined,
              })
            }
          >
            <Plus /> New task
          </button>
        }
      />
      <div className="board-filters">
        {filterOptions.map((filter) => (
          <MultiSelectFilter
            key={filter.paramKey}
            label={filter.label}
            emptyLabel={filter.emptyLabel}
            options={filter.options}
            selected={filter.selected}
            onChange={(value, checked) =>
              toggleValue(filter.paramKey, filter.selected, value, checked)
            }
          />
        ))}
        {hasFilters && (
          <button type="button" className="text-btn clear-board-filters" onClick={clearAll}>
            Clear all
          </button>
        )}
        <label className="multi-filter">
          <span>Presets</span>
          <select
            aria-label="Task filter preset"
            defaultValue=""
            onChange={(event) => {
              const preset = presets.find((candidate) => candidate.id === event.target.value);
              if (preset) applyPreset(preset);
              event.currentTarget.value = '';
            }}
          >
            <option value="">Choose a preset</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
                {preset.scope === 'operator' ? ' · Mine' : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="text-btn" onClick={() => void savePreset()}>
          Save preset
        </button>
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
                    setValues(
                      'tags',
                      active
                        ? selectedTagIds.filter((tagId) => tagId !== tag.id)
                        : [...selectedTagIds, tag.id],
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
            <button type="button" className="text-btn" onClick={() => setValues('tags', [])}>
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
