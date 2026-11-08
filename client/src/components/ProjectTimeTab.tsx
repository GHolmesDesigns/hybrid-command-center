import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Plus, Archive, ArrowUp, ArrowDown, Pencil, Trash2 } from 'lucide-react';
import { api, send } from '../api';
import type { Project, Task, TimeCategory, TimeEntry } from '../../../shared/types';
import { formatDuration, projectTimeBudgetStatus } from '../../../shared/project-time';
import { Empty } from './Primitives';

type Summary = {
  projectId: string;
  totalSeconds: number;
  entryCount: number;
  budgetMinutes: number | null;
  budgetStatus: 'NORMAL' | 'WARNING' | 'OVER' | 'UNSET';
  byTask: { taskId?: string; taskTitle: string; durationSeconds: number; entries: number }[];
  byCategory: {
    categoryId: string;
    categoryName: string;
    durationSeconds: number;
    entries: number;
  }[];
};

type Draft = {
  categoryId: string;
  taskId: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  startAmbiguity: string;
  endAmbiguity: string;
  notes: string;
};
const blankDraft = (categoryId = ''): Draft => ({
  categoryId,
  taskId: '',
  startDate: '',
  startTime: '',
  endDate: '',
  endTime: '',
  startAmbiguity: '',
  endAmbiguity: '',
  notes: '',
});
const datePart = (value: string, zone: string, part: 'date' | 'time') => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(part === 'time' ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
    })
      .formatToParts(new Date(value))
      .map((item) => [item.type, item.value]),
  );
  return part === 'date'
    ? `${parts.year}-${parts.month}-${parts.day}`
    : `${parts.hour}:${parts.minute}`;
};
const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

export function ProjectTimeTab({
  project,
  tasks,
  flash,
  refresh,
}: {
  project: Project;
  tasks: Task[];
  flash: (message: string, type?: 'success' | 'error') => void;
  refresh: () => Promise<void>;
}) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [zone, setZone] = useState(browserZone);
  const [zoneDraft, setZoneDraft] = useState(browserZone);
  const [categories, setCategories] = useState<TimeCategory[]>([]);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [budget, setBudget] = useState(project.timeBudgetMinutes?.toString() ?? '');
  const [categoryName, setCategoryName] = useState('');

  useEffect(() => {
    void api<{ timeZone: string | null }>('/settings/time-zone')
      .then((value) => {
        if (value.timeZone) {
          setZone(value.timeZone);
          setZoneDraft(value.timeZone);
        }
      })
      .catch((cause) => setError((cause as Error).message));
  }, []);

  const query = new URLSearchParams({ timeZone: zone });
  if (taskFilter) query.set('taskId', taskFilter);
  if (categoryFilter) query.set('categoryId', categoryFilter);
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextCategories, nextEntries, nextSummary] = await Promise.all([
        api<TimeCategory[]>(`/projects/${project.id}/time/categories`),
        api<TimeEntry[]>(`/projects/${project.id}/time/entries?${query.toString()}`),
        api<Summary>(`/projects/${project.id}/time/summary`),
      ]);
      setCategories(nextCategories);
      setEntries(nextEntries);
      setSummary(nextSummary);
      setBudget(nextSummary.budgetMinutes?.toString() ?? '');
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
    // The filters are intentionally read as scalar dependencies so each selection reloads the same project view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, zone, taskFilter, categoryFilter, from, to]);
  useEffect(() => {
    void load();
  }, [load]);

  const activeCategories = categories.filter((category) => category.selectable);
  const ownCategories = categories.filter((category) => category.projectId === project.id);
  const categoryNames = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name])),
    [categories],
  );
  const tasksForProject = tasks.filter((task) => task.projectId === project.id);
  const budgetStatus = projectTimeBudgetStatus(summary?.totalSeconds ?? 0, summary?.budgetMinutes);

  const openNew = () => {
    const first = activeCategories[0]?.id ?? '';
    const now = new Date();
    setEditing(null);
    setDraft({
      ...blankDraft(first),
      startDate: datePart(now.toISOString(), zone, 'date'),
      startTime: datePart(now.toISOString(), zone, 'time'),
    });
  };
  const openEdit = (entry: TimeEntry) => {
    setEditing(entry);
    setDraft({
      categoryId: entry.categoryId,
      taskId: entry.taskId ?? '',
      startDate: datePart(entry.startedAt, zone, 'date'),
      startTime: datePart(entry.startedAt, zone, 'time'),
      endDate: datePart(entry.endedAt, zone, 'date'),
      endTime: datePart(entry.endedAt, zone, 'time'),
      startAmbiguity: '',
      endAmbiguity: '',
      notes: entry.notes,
    });
  };

  const submitEntry = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    const payload = {
      categoryId: draft.categoryId,
      taskId: draft.taskId || null,
      startDate: draft.startDate,
      startTime: draft.startTime,
      ...(draft.endDate ? { endDate: draft.endDate } : {}),
      endTime: draft.endTime,
      timeZone: zone,
      ...(draft.startAmbiguity ? { startAmbiguity: draft.startAmbiguity } : {}),
      ...(draft.endAmbiguity ? { endAmbiguity: draft.endAmbiguity } : {}),
      notes: draft.notes,
    };
    try {
      if (editing)
        await send(`/projects/${project.id}/time/entries/${editing.id}`, 'PATCH', {
          ...payload,
          revision: editing.revision,
        });
      else await send(`/projects/${project.id}/time/entries`, 'POST', payload);
      setDraft(null);
      setEditing(null);
      await load();
      flash(editing ? 'Time entry updated.' : 'Time entry added.');
    } catch (cause) {
      flash((cause as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const saveBudget = async () => {
    const minutes = budget.trim() ? Number(budget) : null;
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0)) {
      flash('Enter a whole number of budget minutes.', 'error');
      return;
    }
    try {
      await send(`/projects/${project.id}/time-budget`, 'PATCH', {
        minutes,
        revision: project.revision,
      });
      await refresh();
      await load();
      flash('Project time budget saved.');
    } catch (cause) {
      flash((cause as Error).message, 'error');
    }
  };
  const saveTimeZone = async () => {
    try {
      const result = await send<{ timeZone: string }>('/settings/time-zone', 'PUT', {
        timeZone: zoneDraft,
      });
      setZone(result.timeZone);
      flash(`Operator time zone set to ${result.timeZone}.`);
    } catch (cause) {
      flash((cause as Error).message, 'error');
    }
  };

  const addCategory = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await send(`/projects/${project.id}/time/categories`, 'POST', { name: categoryName });
      setCategoryName('');
      await load();
    } catch (cause) {
      flash((cause as Error).message, 'error');
    }
  };
  const moveCategory = async (index: number, offset: number) => {
    const next = [...ownCategories];
    const target = index + offset;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    try {
      await send(`/projects/${project.id}/time/categories/order`, 'PUT', {
        categoryIds: next.map((item) => item.id),
      });
      await load();
    } catch (cause) {
      flash((cause as Error).message, 'error');
    }
  };
  const archiveCategory = async (category: TimeCategory) => {
    if (
      !window.confirm(
        `Archive “${category.name}”? Existing entries will keep showing this category.`,
      )
    )
      return;
    try {
      await send(`/projects/${project.id}/time/categories/${category.id}/archive`, 'POST');
      await load();
    } catch (cause) {
      flash((cause as Error).message, 'error');
    }
  };
  const removeEntry = async (entry: TimeEntry) => {
    if (!window.confirm(`Delete this ${formatDuration(entry.durationSeconds)} time entry?`)) return;
    try {
      await send(`/projects/${project.id}/time/entries/${entry.id}`, 'DELETE', {
        revision: entry.revision,
      });
      await load();
      flash('Time entry deleted.');
    } catch (cause) {
      flash((cause as Error).message, 'error');
    }
  };
  const exportCsv = () => {
    const columns = [
      'Date',
      'Start time',
      'End date',
      'End time',
      'Duration (hours)',
      'Project',
      'Task',
      'Category',
      'Notes',
    ];
    const lines = entries.map((entry) =>
      [
        datePart(entry.startedAt, zone, 'date'),
        datePart(entry.startedAt, zone, 'time'),
        datePart(entry.endedAt, zone, 'date'),
        datePart(entry.endedAt, zone, 'time'),
        (entry.durationSeconds / 3600).toFixed(4),
        entry.projectName,
        entry.taskTitle ?? '',
        entry.categoryName,
        entry.notes,
      ]
        .map(csvCell)
        .join(','),
    );
    const blob = new Blob([[columns.map(csvCell).join(','), ...lines].join('\r\n')], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${project.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()}-time.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !summary)
    return (
      <section className="panel" aria-busy="true">
        Loading project time…
      </section>
    );
  if (error && !summary)
    return (
      <section className="panel">
        <p role="alert">{error}</p>
        <button onClick={() => void load()}>Try again</button>
      </section>
    );
  if (!summary)
    return (
      <Empty
        compact
        title="Project time unavailable"
        body={error || 'Reload this page to try again.'}
      />
    );
  const statusCopy = {
    NORMAL: 'On track',
    WARNING: 'Approaching budget',
    OVER: 'Over budget',
    UNSET: 'No budget set',
  }[budgetStatus];

  return (
    <div className="project-time" aria-busy={loading}>
      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">Time budget</span>
            <h2>Project time</h2>
          </div>
        </div>
        <div className="time-budget-row">
          <label>
            Budget (minutes)
            <input
              type="number"
              min="1"
              step="1"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
              placeholder="No budget"
            />
          </label>
          <button type="button" onClick={() => void saveBudget()}>
            Save budget
          </button>
          <p className={`time-budget-status ${budgetStatus.toLowerCase()}`}>
            <strong>{formatDuration(summary.totalSeconds)}</strong> logged · {statusCopy}
          </p>
        </div>
        <div className="project-time-totals">
          <div>
            <h3>By task</h3>
            {summary.byTask.length ? (
              summary.byTask.map((item) => (
                <p key={item.taskId ?? 'none'}>
                  {item.taskTitle}
                  <strong>{formatDuration(item.durationSeconds)}</strong>
                </p>
              ))
            ) : (
              <span>No logged time yet.</span>
            )}
          </div>
          <div>
            <h3>By category</h3>
            {summary.byCategory.length ? (
              summary.byCategory.map((item) => (
                <p key={item.categoryId}>
                  {item.categoryName}
                  <strong>{formatDuration(item.durationSeconds)}</strong>
                </p>
              ))
            ) : (
              <span>No logged time yet.</span>
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">Manual entries</span>
            <h2>Time entries</h2>
          </div>
          <div className="head-actions">
            <button
              type="button"
              className="secondary"
              onClick={exportCsv}
              disabled={!entries.length}
            >
              <Download /> Export CSV
            </button>
            <button type="button" onClick={openNew}>
              <Plus /> Log time
            </button>
          </div>
        </div>
        <p className="field-hint">
          Entry dates and CSV use the configured operator time zone. Durations and budget status use
          exact seconds.
        </p>
        <div className="time-zone-setting">
          <label>
            Operator time zone
            <input
              value={zoneDraft}
              onChange={(event) => setZoneDraft(event.target.value)}
              placeholder="America/New_York"
            />
          </label>
          <button className="secondary" type="button" onClick={() => void saveTimeZone()}>
            Save time zone
          </button>
          <span>Current: {zone}</span>
        </div>
        <div className="time-filters">
          <label>
            Task
            <select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value)}>
              <option value="">All tasks</option>
              {tasksForProject.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select
              value={categoryFilter}
              onChange={(event) => setCategoryFilter(event.target.value)}
            >
              <option value="">All categories</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                  {category.archivedAt ? ' (archived)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
        </div>
        {error && <p role="alert">{error}</p>}
        {entries.length ? (
          <div className="time-entry-list">
            {entries.map((entry) => (
              <article className="time-entry" key={entry.id}>
                <div>
                  <strong>
                    {datePart(entry.startedAt, zone, 'date')} ·{' '}
                    {datePart(entry.startedAt, zone, 'time')}–
                    {datePart(entry.endedAt, zone, 'time')}
                    {datePart(entry.startedAt, zone, 'date') !==
                    datePart(entry.endedAt, zone, 'date')
                      ? ` → ${datePart(entry.endedAt, zone, 'date')}`
                      : ''}
                  </strong>
                  <span>
                    {entry.taskTitle ?? 'No task'} ·{' '}
                    {categoryNames.get(entry.categoryId) ?? entry.categoryName} ·{' '}
                    {formatDuration(entry.durationSeconds)}
                  </span>
                  {entry.notes && <p>{entry.notes}</p>}
                </div>
                <div>
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`Edit time entry for ${entry.taskTitle ?? 'no task'}`}
                    onClick={() => openEdit(entry)}
                  >
                    <Pencil />
                  </button>
                  <button
                    type="button"
                    className="secondary danger-outline"
                    aria-label="Delete time entry"
                    onClick={() => void removeEntry(entry)}
                  >
                    <Trash2 />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            compact
            title="No time entries match"
            body="Adjust the filters or log a manual entry for this project."
          />
        )}
      </section>

      <section className="panel">
        <div className="section-title">
          <div>
            <span className="eyebrow">Project setup</span>
            <h2>Time categories</h2>
          </div>
        </div>
        <p className="field-hint">
          Active project categories replace the workspace defaults in the entry picker. Archived
          categories remain on existing entries.
        </p>
        <form className="time-category-create" onSubmit={addCategory}>
          <label>
            New category
            <input
              value={categoryName}
              onChange={(event) => setCategoryName(event.target.value)}
              maxLength={60}
              required
            />
          </label>
          <button type="submit">
            <Plus /> Add category
          </button>
        </form>
        {ownCategories.length ? (
          <ol className="time-category-list">
            {ownCategories.map((category, index) => (
              <li key={category.id}>
                <span>
                  {category.name}
                  {category.archivedAt && <small>Archived</small>}
                </span>
                {!category.archivedAt && (
                  <div>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Move ${category.name} up`}
                      onClick={() => void moveCategory(index, -1)}
                      disabled={index === 0}
                    >
                      <ArrowUp />
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Move ${category.name} down`}
                      onClick={() => void moveCategory(index, 1)}
                      disabled={index === ownCategories.length - 1}
                    >
                      <ArrowDown />
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`Archive ${category.name}`}
                      onClick={() => void archiveCategory(category)}
                    >
                      <Archive />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p>No project categories. Workspace defaults are in use.</p>
        )}
      </section>

      {draft && (
        <div className="modal-backdrop">
          <section
            className="modal project-time-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="time-entry-title"
          >
            <h2 id="time-entry-title">{editing ? 'Edit time entry' : 'Log time'}</h2>
            <form onSubmit={(event) => void submitEntry(event)}>
              <label>
                Category
                <select
                  required
                  value={draft.categoryId}
                  onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
                >
                  <option value="">Choose a category</option>
                  {categories.map((category) => (
                    <option
                      key={category.id}
                      value={category.id}
                      disabled={!category.selectable && draft.categoryId !== category.id}
                    >
                      {category.name}
                      {category.archivedAt
                        ? ' (archived)'
                        : !category.selectable
                          ? ' (defaults replaced)'
                          : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Task (optional)
                <select
                  value={draft.taskId}
                  onChange={(event) => setDraft({ ...draft, taskId: event.target.value })}
                >
                  <option value="">No task</option>
                  {tasksForProject.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
              <div className="time-date-fields">
                <label>
                  Start date
                  <input
                    required
                    type="date"
                    value={draft.startDate}
                    onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
                  />
                </label>
                <label>
                  Start time
                  <input
                    required
                    type="time"
                    value={draft.startTime}
                    onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                  />
                </label>
              </div>
              <label>
                Repeated start time
                <select
                  value={draft.startAmbiguity}
                  onChange={(event) => setDraft({ ...draft, startAmbiguity: event.target.value })}
                >
                  <option value="">Choose only if asked</option>
                  <option value="earlier">Earlier occurrence</option>
                  <option value="later">Later occurrence</option>
                </select>
              </label>
              <div className="time-date-fields">
                <label>
                  End date (required across midnight)
                  <input
                    type="date"
                    value={draft.endDate}
                    onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
                  />
                </label>
                <label>
                  End time
                  <input
                    required
                    type="time"
                    value={draft.endTime}
                    onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                  />
                </label>
              </div>
              <label>
                Repeated end time
                <select
                  value={draft.endAmbiguity}
                  onChange={(event) => setDraft({ ...draft, endAmbiguity: event.target.value })}
                >
                  <option value="">Choose only if asked</option>
                  <option value="earlier">Earlier occurrence</option>
                  <option value="later">Later occurrence</option>
                </select>
              </label>
              <label>
                Notes
                <textarea
                  maxLength={2000}
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setDraft(null);
                    setEditing(null);
                  }}
                >
                  Cancel
                </button>
                <button type="submit" disabled={saving || !activeCategories.length}>
                  {saving ? 'Saving…' : 'Save entry'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
