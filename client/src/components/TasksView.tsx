import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Pause, Play, RotateCcw, Tag as TagIcon } from 'lucide-react';
import type { Client, Project, Tag, Task } from '../../../shared/types';
import { TASK_TYPES } from '../../../shared/types';
import { isDueNextSevenDays, isDueToday } from '../../../shared/deadlines';
import { PageHead } from './Shell';
import { SearchBox } from './Primitives';
import { TASK_TYPE_LABEL, tagAccent } from './ui-shared';
import {
  newTaskTimerSession,
  pauseTaskTimer,
  readTaskTimer,
  reconcileTaskTimer,
  startTaskTimer,
  writeTaskTimer,
  readTaskTimerSettings,
  type TaskTimerSettings,
  type TaskTimerSession,
} from '../../../shared/task-timer';

const NO_TASK_TYPE = 'none';
type FilterOption = { value: string; label: string };

function MultiSelectFilter({
  label,
  emptyLabel,
  options,
  selected,
  onChange,
}: {
  label: string;
  emptyLabel: string;
  options: FilterOption[];
  selected: string[];
  onChange: (value: string, checked: boolean) => void;
}) {
  const labelId = useId();
  const chosen = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label);
  const summary =
    chosen.length === 0
      ? emptyLabel
      : chosen.length === 1
        ? chosen[0]
        : `${chosen.length} selected`;
  return (
    <div className="multi-filter">
      <span id={labelId}>{label}</span>
      <details>
        <summary role="button" aria-label={`${label}: ${summary}`}>
          {summary}
        </summary>
        <fieldset aria-labelledby={labelId}>
          {options.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={(event) => onChange(option.value, event.target.checked)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </fieldset>
      </details>
    </div>
  );
}

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function TasksView({
  tasks,
  clients = [],
  projects = [],
  tags = [],
}: {
  tasks: Task[];
  clients?: Client[];
  projects?: Project[];
  tags?: Tag[];
}) {
  const [params, setParams] = useSearchParams();
  const values = (key: string) => [...new Set((params.get(key) || '').split(',').filter(Boolean))];
  const selectedClients = values('client');
  const selectedProjects = values('project');
  const selectedPriorities = values('priority');
  const selectedTypes = values('type');
  const selectedFocus = values('filter');
  const selectedTags = values('tags');
  const [query, setQuery] = useState(params.get('search') || '');
  const activeTasks = useMemo(() => tasks.filter((task) => task.status !== 'COMPLETE'), [tasks]);
  const filteredTasks = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return activeTasks.filter(
      (task) =>
        (!selectedClients.length || selectedClients.includes(task.clientId || '')) &&
        (!selectedProjects.length || selectedProjects.includes(task.projectId)) &&
        (!selectedPriorities.length || selectedPriorities.includes(task.priority)) &&
        (!selectedTypes.length ||
          selectedTypes.some((type) =>
            type === NO_TASK_TYPE ? !task.taskType : task.taskType === type,
          )) &&
        (!selectedTags.length ||
          selectedTags.every((tagId) => task.tags.some((tag) => tag.id === tagId))) &&
        (!needle ||
          task.title.toLowerCase().includes(needle) ||
          task.tags.some((tag) => tag.name.toLowerCase().includes(needle))) &&
        (!selectedFocus.length ||
          selectedFocus.some(
            (flag) =>
              (flag === 'overdue' && task.overdue) ||
              (flag === 'blocked' && task.blocked) ||
              (flag === 'today' && isDueToday(task)) ||
              (flag === 'week' && isDueNextSevenDays(task)) ||
              (flag === 'none' && !task.dueDate),
          )),
    );
  }, [
    activeTasks,
    query,
    selectedClients,
    selectedProjects,
    selectedPriorities,
    selectedTypes,
    selectedTags,
    selectedFocus,
  ]);
  const [selectedId, setSelectedId] = useState('');
  const [timer, setTimer] = useState<TaskTimerSession | null>(() =>
    readTaskTimer(window.localStorage),
  );
  const activeTimer = timer ? reconcileTaskTimer(timer) : null;
  const seconds = activeTimer?.remainingSeconds ?? 25 * 60;
  const mode = activeTimer?.phase ?? 'work';
  const running = Boolean(activeTimer && !activeTimer.paused && selectedId === activeTimer.taskId);
  const selected = filteredTasks.find((task) => task.id === selectedId);
  const [settings] = useState<TaskTimerSettings>(() => readTaskTimerSettings(window.localStorage));
  const [owner, setOwner] = useState(true);
  const ownerId = useRef(crypto.randomUUID());
  const channel = useRef<BroadcastChannel | null>(null);
  const lastCycle = useRef(activeTimer?.cycleCount ?? 0);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const bus = new BroadcastChannel('hcc-task-timer');
    channel.current = bus;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === 'claim' && event.data.id !== ownerId.current) setOwner(false);
      if (event.data?.type === 'release' && event.data.id !== ownerId.current) setOwner(true);
    };
    bus.addEventListener('message', onMessage);
    return () => {
      bus.postMessage({ type: 'release', id: ownerId.current });
      bus.close();
      channel.current = null;
    };
  }, []);
  useEffect(() => {
    if (activeTimer && !activeTimer.paused && owner)
      channel.current?.postMessage({ type: 'claim', id: ownerId.current });
  }, [activeTimer, owner]);
  const notify = (body: string) => {
    if (
      settings.enabled &&
      settings.completion &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    )
      new Notification('Pomodoro complete', { body });
  };
  useEffect(() => {
    if (activeTimer && activeTimer.cycleCount > lastCycle.current)
      notify('Focus session complete. Time for a short break.');
    lastCycle.current = activeTimer?.cycleCount ?? lastCycle.current;
  }, [activeTimer]);

  useEffect(() => {
    if (timer) writeTaskTimer(window.localStorage, timer);
  }, [timer]);
  useEffect(() => {
    const refresh = () => setTimer((current) => (current ? reconcileTaskTimer(current) : current));
    const onVisibility = () => refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    const interval =
      activeTimer && !activeTimer.paused ? window.setInterval(refresh, 1000) : undefined;
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
      if (interval) window.clearInterval(interval);
    };
  }, [activeTimer]);

  useEffect(() => {
    if (filteredTasks.some((task) => task.id === selectedId)) return;
    if (!selectedId) {
      // Nothing chosen yet — default to the first available task for convenience.
      setSelectedId(filteredTasks[0]?.id ?? '');
      return;
    }
    // The task being timed left the active list (completed, deleted, or reassigned
    // elsewhere). Per the approved timer contract, stop the session and preserve its
    // elapsed state — do not pick a replacement task; the operator restarts manually.
    setTimer((current) =>
      current && current.taskId === selectedId && !current.paused
        ? pauseTaskTimer(current)
        : current,
    );
  }, [filteredTasks, selectedId]);

  const setValues = (key: string, nextValues: string[]) => {
    const next = new URLSearchParams(params);
    const canonical = [...new Set(nextValues)].sort();
    if (canonical.length) next.set(key, canonical.join(','));
    else next.delete(key);
    if (key === 'client') {
      const validProjects = selectedProjects.filter((id) => {
        const project = projects.find((candidate) => candidate.id === id);
        return project && (!canonical.length || canonical.includes(project.clientId));
      });
      if (validProjects.length) next.set('project', validProjects.sort().join(','));
      else next.delete('project');
    }
    setParams(next);
  };
  const toggle = (key: string, current: string[], value: string, checked: boolean) =>
    setValues(key, checked ? [...current, value] : current.filter((item) => item !== value));
  const activeClients = clients.filter((client) => client.status === 'ACTIVE');
  const availableProjects = projects.filter(
    (project) => !selectedClients.length || selectedClients.includes(project.clientId),
  );
  const filterOptions = [
    {
      key: 'client',
      label: 'Client',
      empty: 'All clients',
      selected: selectedClients,
      options: activeClients.map((client) => ({ value: client.id, label: client.name })),
    },
    {
      key: 'project',
      label: 'Project',
      empty: 'All projects',
      selected: selectedProjects,
      options: availableProjects.map((project) => ({ value: project.id, label: project.name })),
    },
    {
      key: 'priority',
      label: 'Priority',
      empty: 'Any priority',
      selected: selectedPriorities,
      options: ['URGENT', 'HIGH', 'MEDIUM', 'LOW'].map((value) => ({ value, label: value })),
    },
    {
      key: 'type',
      label: 'Task type',
      empty: 'Any type',
      selected: selectedTypes,
      options: [
        { value: NO_TASK_TYPE, label: 'No type' },
        ...TASK_TYPES.map((value) => ({ value, label: TASK_TYPE_LABEL[value] })),
      ],
    },
    {
      key: 'filter',
      label: 'Focus',
      empty: 'All tasks',
      selected: selectedFocus,
      options: [
        { value: 'overdue', label: 'Overdue' },
        { value: 'today', label: 'Due today' },
        { value: 'week', label: 'Due this week' },
        { value: 'none', label: 'No due date' },
        { value: 'blocked', label: 'Blocked' },
      ],
    },
  ];

  const reset = () => {
    if (selectedId) setTimer(newTaskTimerSession(selectedId));
  };

  return (
    <>
      <PageHead
        eyebrow="Focus"
        title="Tasks"
        body="Choose a Project task, then work in focused Pomodoro sessions."
      />
      <div className="tasks-layout">
        <section className="pomodoro-card" aria-label="Pomodoro timer">
          <span className="eyebrow">{mode === 'work' ? 'Work session' : 'Short break'}</span>
          <strong className="pomodoro-clock" aria-live="polite">
            {clock(seconds)}
          </strong>
          <p className="pomodoro-task">
            {selected ? `Working on ${selected.title}` : 'Select a task to begin'}
          </p>
          <div className="pomodoro-actions">
            <button
              className="primary-btn"
              type="button"
              onClick={() => {
                if (!selectedId) return;
                if (!owner) return;
                if (typeof Notification !== 'undefined' && Notification.permission === 'default')
                  void Notification.requestPermission();
                setTimer((current) =>
                  current && current.taskId === selectedId && !current.paused
                    ? pauseTaskTimer(current)
                    : startTaskTimer(
                        current && current.taskId === selectedId
                          ? current
                          : newTaskTimerSession(selectedId),
                      ),
                );
              }}
              disabled={!selected}
            >
              {running ? <Pause /> : <Play />} {running ? 'Pause' : 'Start'}
            </button>
            <button className="secondary-btn" type="button" onClick={reset}>
              <RotateCcw /> Reset
            </button>
          </div>
          <p className="pomodoro-help">25 minutes of focus, followed by a 5-minute break.</p>
        </section>
        <section className="task-picker" aria-labelledby="task-picker-heading">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Project work</span>
              <h2 id="task-picker-heading">Choose a task</h2>
            </div>
            <span className="count">{filteredTasks.length}</span>
          </div>
          <div className="board-filters">
            {filterOptions.map((filter) => (
              <MultiSelectFilter
                key={filter.key}
                label={filter.label}
                emptyLabel={filter.empty}
                options={filter.options}
                selected={filter.selected}
                onChange={(value, checked) => toggle(filter.key, filter.selected, value, checked)}
              />
            ))}
            {(filterOptions.some((filter) => filter.selected.length) ||
              selectedTags.length ||
              query) && (
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  ['client', 'project', 'priority', 'type', 'filter', 'tags', 'search'].forEach(
                    (key) => next.delete(key),
                  );
                  setQuery('');
                  setParams(next);
                }}
              >
                Clear all
              </button>
            )}
          </div>
          <SearchBox
            value={query}
            set={(value) => {
              setQuery(value);
              const next = new URLSearchParams(params);
              if (value.trim()) next.set('search', value);
              else next.delete('search');
              setParams(next);
            }}
            placeholder="Search task titles and tags…"
          />
          {tags.length > 0 && (
            <div className="tag-filter">
              <span className="tag-filter-label">
                <TagIcon /> Tags
              </span>
              <div role="group" aria-label="Task tags">
                {tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    className={`tag-chip toggle ${selectedTags.includes(tag.id) ? 'active' : ''}`}
                    aria-pressed={selectedTags.includes(tag.id)}
                    style={{ borderColor: tagAccent(tag) }}
                    onClick={() =>
                      setValues(
                        'tags',
                        selectedTags.includes(tag.id)
                          ? selectedTags.filter((id) => id !== tag.id)
                          : [...selectedTags, tag.id],
                      )
                    }
                  >
                    <span className="tag-dot" style={{ background: tagAccent(tag) }} />
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {filteredTasks.length ? (
            <div className="task-picker-list">
              {filteredTasks.map((task) => (
                <button
                  className={`task-picker-row ${task.id === selected?.id ? 'selected' : ''}`}
                  key={task.id}
                  type="button"
                  onClick={() => {
                    if (
                      running &&
                      task.id !== selectedId &&
                      !window.confirm('Stop the current timer and switch tasks?')
                    )
                      return;
                    setSelectedId(task.id);
                    setTimer(newTaskTimerSession(task.id));
                  }}
                >
                  <span className="task-picker-icon">
                    <CheckCircle2 />
                  </span>
                  <span>
                    <strong>{task.title}</strong>
                    <small>{task.projectName || 'Project task'}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-state">
              All Project tasks are complete. Add a new task to start a session.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
