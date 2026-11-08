import { useEffect, useMemo, useState } from 'react';
import { Download, Copy } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { OperatorTimer, TimeEntry } from '../../../shared/types';
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

export function WorkspaceTimeView() {
  const [params, setParams] = useSearchParams();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
                            <td>{entry.taskTitle ?? 'No task'}</td>
                            <td>{entry.categoryName}</td>
                            <td>{formatDuration(entry.durationSeconds)}</td>
                            <td>{entry.notes}</td>
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
    </>
  );
}
