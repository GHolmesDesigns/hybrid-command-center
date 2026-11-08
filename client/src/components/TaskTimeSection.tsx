import { useCallback, useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, send } from '../api';
import type { OperatorTimer, Task, TimeCategory, TimeEntry } from '../../../shared/types';
import { formatDuration } from '../../../shared/project-time';

type Summary = {
  taskId: string;
  entries: TimeEntry[];
  totalSeconds: number;
  budgetMinutes: number | null;
  budgetStatus: 'NORMAL' | 'WARNING' | 'OVER' | 'UNSET';
};
const STATUS_COPY = {
  NORMAL: 'On track',
  WARNING: 'Approaching budget',
  OVER: 'Over budget',
  UNSET: 'No budget set',
} as const;

export function TaskTimeSection({
  task,
  refresh,
  flash,
}: {
  task: Task;
  refresh: () => Promise<void>;
  flash: (message: string, tone?: 'success' | 'error') => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [timer, setTimer] = useState<OperatorTimer | null>(null);
  const [categories, setCategories] = useState<TimeCategory[]>([]);
  const [budget, setBudget] = useState(task.timeBudgetMinutes?.toString() ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError('');
    try {
      const [nextSummary, nextTimer, nextCategories] = await Promise.all([
        api<Summary>(`/tasks/${task.id}/time-summary`),
        api<OperatorTimer>('/operator-timer'),
        api<TimeCategory[]>(`/projects/${task.projectId}/time/categories`),
      ]);
      setSummary(nextSummary);
      setTimer(nextTimer);
      setCategories(nextCategories.filter((category) => category.selectable));
      setBudget(nextSummary.budgetMinutes?.toString() ?? '');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [task.id, task.projectId]);
  useEffect(() => void load(), [load]);

  const saveBudget = async () => {
    if (budget && (!Number.isInteger(Number(budget)) || Number(budget) < 1)) {
      setError('Enter a whole number of budget minutes, or leave it blank.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await send(`/tasks/${task.id}/time-budget`, 'PATCH', {
        minutes: budget ? Number(budget) : null,
        revision: task.revision,
      });
      await Promise.all([load(), refresh()]);
      flash('Task time budget saved.');
    } catch (cause) {
      setError((cause as Error).message);
      if ((cause as { status?: number }).status === 409) await Promise.all([load(), refresh()]);
    } finally {
      setBusy(false);
    }
  };

  const startOrSwitch = async () => {
    const category = categories[0];
    if (!timer || !category) return;
    setBusy(true);
    setError('');
    try {
      const next = await send<OperatorTimer>('/operator-timer/switch', 'POST', {
        projectId: task.projectId,
        categoryId: category.id,
        taskId: task.id,
        revision: timer.revision,
      });
      setTimer(next);
      await load();
      flash(
        timer.state === 'READY'
          ? 'Work timer started for this task.'
          : 'Timer switched to this task.',
      );
    } catch (cause) {
      setError((cause as Error).message);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const timerOnTask = timer?.state !== 'READY' && timer?.taskId === task.id;
  const actionLabel = timerOnTask
    ? 'Timer running on this task'
    : timer?.state !== 'READY'
      ? 'Switch to this task'
      : 'Start timer for this task';

  return (
    <section className="task-time-section" aria-labelledby="task-time-heading">
      <div className="section-title">
        <div>
          <span className="eyebrow">Time tracking</span>
          <h2 id="task-time-heading">Time</h2>
        </div>
      </div>
      {error && (
        <p className="task-time-error" role="alert">
          {error}
        </p>
      )}
      <div className="task-time-budget">
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
        <button type="button" disabled={busy} onClick={() => void saveBudget()}>
          Save budget
        </button>
        {summary && (
          <p className={`time-budget-status ${summary.budgetStatus.toLowerCase()}`}>
            <strong>{formatDuration(summary.totalSeconds)}</strong> logged ·{' '}
            {STATUS_COPY[summary.budgetStatus]}
          </p>
        )}
        <button
          type="button"
          className="secondary"
          disabled={busy || !categories.length || timerOnTask}
          onClick={() => void startOrSwitch()}
        >
          <Play /> {actionLabel}
        </button>
      </div>
      <div className="task-time-entries">
        <h3>Logged time</h3>
        {!summary ? (
          <p>Loading task time…</p>
        ) : summary.entries.length ? (
          <ul>
            {summary.entries.map((entry) => (
              <li key={entry.id}>
                <span>
                  {new Date(entry.startedAt).toLocaleDateString()} · {entry.categoryName}
                  {entry.notes ? ` · ${entry.notes}` : ''}
                </span>
                <strong>{formatDuration(entry.durationSeconds)}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No time logged for this task yet.</p>
        )}
        <Link to={`/projects/${task.projectId}?tab=time`}>
          Log or edit time entries in project time
        </Link>
      </div>
    </section>
  );
}
