import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Download, Copy, Pencil, Trash2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, send } from '../api';
import type { OperatorTimer, TimeCategory, TimeEntry } from '../../../shared/types';
import {
  currentWeekRange,
  readWorkspaceTimeFilters,
  workspaceTimeCsv,
} from '../../../shared/workspace-time';
import { formatDuration, formatElapsedClock } from '../../../shared/project-time';
import { Empty } from './Primitives';
import { PageHead } from './Shell';

type Report = {
  entries: TimeEntry[];
  totalSeconds: number;
  timeZone: string;
  options: {
    projects: { id: string; name: string; status: string }[];
    tasks: { id: string; title: string; status: string; projectId: string }[];
    categories: { id: string; name: string; archived: number }[];
  };
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

const datePart = (value: string, timeZone: string, part: 'date' | 'time') => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
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

const formatEntryDateTime = (entry: TimeEntry, timeZone: string) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(entry.startedAt));

export function WorkspaceTimeView() {
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editCategories, setEditCategories] = useState<TimeCategory[]>([]);
  const [editError, setEditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [timer, setTimer] = useState<OperatorTimer | null>(null);
  const [timerLoading, setTimerLoading] = useState(true);
  const [timerError, setTimerError] = useState('');
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [now] = useState(() => new Date());
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<Report>('/time/entries')
      .then((value) => {
        if (alive) {
          setReport(value);
          setError('');
        }
      })
      .catch((cause) => alive && setError((cause as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const refreshTimer = () => {
      api<OperatorTimer>('/operator-timer')
        .then((value) => {
          if (!alive) return;
          setTimer(value);
          setTimerError('');
        })
        .catch((cause) => {
          if (alive) setTimerError((cause as Error).message);
        })
        .finally(() => alive && setTimerLoading(false));
    };
    refreshTimer();
    const tick = window.setInterval(() => setTimerNow(Date.now()), 1000);
    const refresh = window.setInterval(refreshTimer, 30_000);
    const focus = () => refreshTimer();
    window.addEventListener('focus', focus);
    return () => {
      alive = false;
      window.clearInterval(tick);
      window.clearInterval(refresh);
      window.removeEventListener('focus', focus);
    };
  }, []);

  const elapsed = timer
    ? timer.elapsedSeconds +
      (timer.state === 'RUNNING'
        ? Math.max(0, Math.floor((timerNow - Date.parse(timer.serverTime)) / 1000))
        : 0)
    : 0;

  const defaults = currentWeekRange(now, report?.timeZone ?? 'UTC');
  const parsed = readWorkspaceTimeFilters(params, defaults, {
    projects: new Set(report?.options.projects.map((item) => item.id) ?? []),
    tasks: new Set(report?.options.tasks.map((item) => item.id) ?? []),
    categories: new Set(report?.options.categories.map((item) => item.id) ?? []),
  });
  const filters = parsed.filters;
  const entries = useMemo(() => {
    if (!report) return [];
    const datePart = (value: string) => {
      const parts = new Map(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: report.timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        })
          .formatToParts(new Date(value))
          .map(({ type, value }) => [type, value]),
      );
      return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
    };
    return report.entries.filter((entry) => {
      const day = datePart(entry.startedAt);
      return (
        day >= filters.from &&
        day <= filters.to &&
        (!filters.projectId || entry.projectId === filters.projectId) &&
        (!filters.taskId || entry.taskId === filters.taskId) &&
        (!filters.categoryId || entry.categoryId === filters.categoryId)
      );
    });
  }, [report, filters.from, filters.to, filters.projectId, filters.taskId, filters.categoryId]);
  const totalSeconds = entries.reduce((total, entry) => total + entry.durationSeconds, 0);
  const updateFilter = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === 'project') next.delete('task');
    setParams(next);
  };
  const csv = () => workspaceTimeCsv(entries, report?.timeZone ?? 'UTC');
  const exportCsv = async () => {
    const contents = csv();
    try {
      const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'workspace-time.csv';
      link.click();
      URL.revokeObjectURL(url);
      setNotice(`Exported ${entries.length} matching entr${entries.length === 1 ? 'y' : 'ies'}.`);
    } catch {
      try {
        await navigator.clipboard.writeText(contents);
        setNotice('Download was unavailable. CSV copied to the clipboard.');
      } catch {
        setNotice('CSV download and clipboard copy are unavailable in this browser.');
      }
    }
  };
  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(csv());
      setNotice('CSV copied to the clipboard.');
    } catch {
      setNotice('Clipboard access is unavailable in this browser.');
    }
  };
  const deleteEntry = async (entry: TimeEntry) => {
    const when = formatEntryDateTime(entry, report?.timeZone ?? 'UTC');
    if (
      !window.confirm(
        `Delete this ${formatDuration(entry.durationSeconds)} time entry for ${entry.projectName} on ${when}?`,
      )
    )
      return;

    setDeleteError('');
    setNotice('');
    try {
      await api(`/projects/${entry.projectId}/time/entries/${entry.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ revision: entry.revision }),
      });
      setReport((current) =>
        current
          ? {
              ...current,
              entries: current.entries.filter((candidate) => candidate.id !== entry.id),
            }
          : current,
      );
      try {
        setReport(await api<Report>('/time/entries'));
        setError('');
        setNotice('Time entry deleted.');
      } catch (cause) {
        setDeleteError(
          `The time entry was deleted, but the report could not refresh: ${(cause as Error).message}`,
        );
      }
    } catch (cause) {
      setDeleteError((cause as Error).message);
    }
  };

  const openEdit = async (entry: TimeEntry) => {
    setEditing(entry);
    setEditError('');
    setDraft({
      categoryId: entry.categoryId,
      taskId: entry.taskId ?? '',
      startDate: datePart(entry.startedAt, report?.timeZone ?? 'UTC', 'date'),
      startTime: datePart(entry.startedAt, report?.timeZone ?? 'UTC', 'time'),
      endDate: datePart(entry.endedAt, report?.timeZone ?? 'UTC', 'date'),
      endTime: datePart(entry.endedAt, report?.timeZone ?? 'UTC', 'time'),
      startAmbiguity: '',
      endAmbiguity: '',
      notes: entry.notes,
    });
    try {
      const categories = await api<TimeCategory[]>(`/projects/${entry.projectId}/time/categories`);
      setEditCategories(categories);
    } catch (cause) {
      setEditError((cause as Error).message);
      setEditCategories([]);
    }
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || !draft) return;
    setSaving(true);
    setEditError('');
    try {
      const updated = await send<TimeEntry>(
        `/projects/${editing.projectId}/time/entries/${editing.id}`,
        'PATCH',
        {
          categoryId: draft.categoryId,
          taskId: draft.taskId || null,
          startDate: draft.startDate,
          startTime: draft.startTime,
          ...(draft.endDate ? { endDate: draft.endDate } : {}),
          endTime: draft.endTime,
          timeZone: report?.timeZone ?? 'UTC',
          ...(draft.startAmbiguity ? { startAmbiguity: draft.startAmbiguity } : {}),
          ...(draft.endAmbiguity ? { endAmbiguity: draft.endAmbiguity } : {}),
          notes: draft.notes,
          revision: editing.revision,
        },
      );
      setReport((current) =>
        current
          ? {
              ...current,
              entries: current.entries.map((entry) => (entry.id === updated.id ? updated : entry)),
            }
          : current,
      );
      setError('');
      setEditing(null);
      setDraft(null);
      setNotice('Time entry updated.');
    } catch (cause) {
      setEditError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHead
        eyebrow="Workspace report"
        title="Logged time"
        body="Review and export saved time across projects. Dates and CSV times use the configured operator time zone."
      />
      <div className="workspace-time-layout">
        <section className="panel workspace-time-clock-panel" aria-label="Current work timer">
          <span className="eyebrow">Work timer</span>
          <output className="workspace-time-clock" aria-label="Elapsed work time">
            {formatElapsedClock(elapsed)}
          </output>
          {timerLoading ? (
            <p role="status">Loading timer…</p>
          ) : timerError ? (
            <p className="workspace-time-timer-error" role="status">
              Timer unavailable: {timerError}
            </p>
          ) : (
            <p className={`workspace-time-timer-state state-${timer?.state.toLowerCase()}`}>
              {timer?.state === 'RUNNING'
                ? 'Running'
                : timer?.state === 'PAUSED'
                  ? 'Paused'
                  : 'Ready'}
            </p>
          )}
        </section>
        <div className="workspace-time-report-column">
          {loading && <p role="status">Loading workspace time…</p>}
          {error && <Empty title="Workspace time unavailable" body={error} />}
          {!loading && !error && report && (
            <>
              {Object.values(parsed.ignored).some(Boolean) && (
                <p role="status">An invalid, retired, or unavailable filter was ignored.</p>
              )}
              <section className="panel workspace-time-filters" aria-label="Time report filters">
                <label>
                  From
                  <input
                    type="date"
                    value={filters.from}
                    onChange={(event) => updateFilter('from', event.target.value)}
                  />
                </label>
                <label>
                  To
                  <input
                    type="date"
                    value={filters.to}
                    onChange={(event) => updateFilter('to', event.target.value)}
                  />
                </label>
                <label>
                  Project
                  <select
                    value={filters.projectId}
                    onChange={(event) => updateFilter('project', event.target.value)}
                  >
                    <option value="">All projects</option>
                    {report.options.projects.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.status === 'ARCHIVED' ? ' (archived)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Task
                  <select
                    value={filters.taskId}
                    onChange={(event) => updateFilter('task', event.target.value)}
                  >
                    <option value="">All tasks</option>
                    {report.options.tasks
                      .filter((item) => !filters.projectId || item.projectId === filters.projectId)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                          {item.status === 'COMPLETE' ? ' (complete)' : ''}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Category
                  <select
                    value={filters.categoryId}
                    onChange={(event) => updateFilter('category', event.target.value)}
                  >
                    <option value="">All categories</option>
                    {report.options.categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.archived ? ' (archived)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </section>
              <section className="panel">
                <div className="section-title">
                  <div>
                    <span className="eyebrow">
                      {entries.length} matching entr{entries.length === 1 ? 'y' : 'ies'}
                    </span>
                    <h2>{entries.length ? formatDuration(totalSeconds) : 'No matching time'}</h2>
                  </div>
                  <div className="head-actions">
                    <button className="secondary" onClick={copyCsv}>
                      <Copy /> Copy CSV
                    </button>
                    <button onClick={exportCsv}>
                      <Download /> Export CSV
                    </button>
                  </div>
                </div>
                {notice && <p role="status">{notice}</p>}
                {deleteError && <p role="alert">{deleteError}</p>}
                {!entries.length ? (
                  <Empty
                    compact
                    title="No entries in this range"
                    body="Change the dates or filters to see saved time. No time total is available for this selection."
                  />
                ) : (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Project</th>
                          <th>Task</th>
                          <th>Category</th>
                          <th>Duration</th>
                          <th>Notes</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((entry) => (
                          <tr key={entry.id}>
                            <td>
                              {new Intl.DateTimeFormat(undefined, {
                                timeZone: report.timeZone,
                                dateStyle: 'medium',
                              }).format(new Date(entry.startedAt))}
                            </td>
                            <td>{entry.projectName}</td>
                            <td>
                              {entry.taskId &&
                              report.options.tasks.some((task) => task.id === entry.taskId) ? (
                                <Link to={`/countdown/${encodeURIComponent(entry.taskId)}`}>
                                  {entry.taskTitle ?? 'Open task'}
                                </Link>
                              ) : (
                                (entry.taskTitle ?? 'No task')
                              )}
                            </td>
                            <td>{entry.categoryName}</td>
                            <td>{formatDuration(entry.durationSeconds)}</td>
                            <td>{entry.notes}</td>
                            <td>
                              <button
                                className="icon-btn"
                                aria-label={`Edit time entry for ${entry.projectName} on ${formatEntryDateTime(entry, report.timeZone)}`}
                                onClick={() => void openEdit(entry)}
                              >
                                <Pencil aria-hidden="true" />
                              </button>
                              <button
                                className="icon-btn danger"
                                aria-label={`Delete time entry for ${entry.projectName} on ${formatEntryDateTime(entry, report.timeZone)}`}
                                onClick={() => void deleteEntry(entry)}
                              >
                                <Trash2 aria-hidden="true" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </div>
      {draft && editing && (
        <div className="modal-backdrop">
          <section
            className="modal workspace-time-edit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-time-edit-title"
          >
            <h2 id="workspace-time-edit-title">Edit time entry</h2>
            <p>{editing.projectName}</p>
            {editError && <p role="alert">{editError}</p>}
            <form onSubmit={(event) => void saveEdit(event)}>
              <label>
                Category
                <select
                  required
                  value={draft.categoryId}
                  onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
                >
                  {editCategories.map((category) => (
                    <option
                      key={category.id}
                      value={category.id}
                      disabled={!category.selectable && category.id !== draft.categoryId}
                    >
                      {category.name}
                      {category.archivedAt ? ' (archived)' : ''}
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
                  {report?.options.tasks
                    .filter((task) => task.projectId === editing.projectId)
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                </select>
              </label>
              <div className="workspace-time-edit-date-fields">
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
                <label>
                  End date
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
                <button type="submit" disabled={saving || !editCategories.length}>
                  {saving ? 'Saving…' : 'Save entry'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
