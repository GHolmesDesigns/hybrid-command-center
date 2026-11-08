import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pause, Play, Save, Timer, Trash2 } from 'lucide-react';
import { api, send } from '../api';
import type {
  OperatorTimer as TimerSnapshot,
  Project,
  Task,
  TimeCategory,
} from '../../../shared/types';
import { formatDuration } from '../../../shared/project-time';

export function OperatorTimer({ projects, tasks }: { projects: Project[]; tasks: Task[] }) {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);
  const [serverOffset, setServerOffset] = useState(0);
  const [tick, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [categories, setCategories] = useState<TimeCategory[]>([]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previousTitle] = useState(() => document.title);
  const activeProjects = useMemo(
    () =>
      projects
        .filter((project) => project.status !== 'ARCHIVED')
        .sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE')),
    [projects],
  );
  const elapsed = snapshot
    ? snapshot.elapsedSeconds +
      (snapshot.state === 'RUNNING' ? Math.max(0, Math.floor((tick - serverOffset) / 1000)) : 0)
    : 0;

  const refresh = useCallback(async (clearError = true) => {
    try {
      const next = await api<TimerSnapshot>('/operator-timer');
      setSnapshot(next);
      setServerOffset(Date.parse(next.serverTime));
      setTick(Date.now());
      if (clearError) setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      setTick(Date.now());
      if (document.visibilityState === 'visible') void refresh();
    }, 30_000);
    const focus = () => void refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (snapshot?.state === 'RUNNING') {
      document.title = `${formatDuration(elapsed)} · HCC`;
      return () => {
        document.title = previousTitle;
      };
    }
    document.title = previousTitle;
    return undefined;
  }, [elapsed, previousTitle, snapshot?.state]);

  useEffect(() => {
    if (!projectId) {
      setCategories([]);
      setCategoryId('');
      return;
    }
    let cancelled = false;
    api<TimeCategory[]>(`/projects/${projectId}/time/categories`)
      .then((values) => {
        if (cancelled) return;
        const selectable = values.filter((category) => category.selectable);
        setCategories(selectable);
        setCategoryId(selectable[0]?.id ?? '');
      })
      .catch((cause) => {
        if (!cancelled) setError((cause as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const act = async (path: string, body: unknown) => {
    if (!snapshot) return;
    setBusy(true);
    setError('');
    try {
      const result = await send<TimerSnapshot | unknown>(`/operator-timer/${path}`, 'POST', body);
      if (path === 'stop') {
        await refresh();
        setOpen(false);
      } else {
        setSnapshot(result as TimerSnapshot);
        setServerOffset(Date.parse((result as TimerSnapshot).serverTime));
        setTick(Date.now());
        setConfirmDiscard(false);
      }
    } catch (cause) {
      setError((cause as Error).message);
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!snapshot || !projectId || !categoryId) return;
    void act('start', {
      projectId,
      categoryId,
      taskId: taskId || null,
      revision: snapshot.revision,
    });
  };
  const canStart = Boolean(projectId && categoryId && !busy);
  const overEightHours = snapshot?.state === 'RUNNING' && elapsed > 8 * 60 * 60;

  return (
    <div className="operator-timer-control">
      <button
        className={`top-action operator-timer-trigger${snapshot?.state === 'RUNNING' ? ' is-running' : ''}`}
        type="button"
        aria-expanded={open}
        aria-controls="operator-timer-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <Timer aria-hidden="true" />
        {snapshot?.state === 'READY' || !snapshot
          ? 'Work timer'
          : `${formatDuration(elapsed)} · ${snapshot.state === 'RUNNING' ? 'Running' : 'Paused'}`}
      </button>
      {open && (
        <section className="operator-timer-panel" id="operator-timer-panel" aria-label="Work timer">
          <div className="operator-timer-heading">
            <div>
              <strong>Work timer</strong>
              <span className={`operator-timer-state state-${snapshot?.state.toLowerCase()}`}>
                {snapshot?.state === 'RUNNING'
                  ? 'Running'
                  : snapshot?.state === 'PAUSED'
                    ? 'Paused'
                    : 'Ready'}
              </span>
            </div>
            <output aria-live="off" aria-label="Elapsed work time" className="operator-timer-clock">
              {formatDuration(elapsed)}
            </output>
          </div>
          {snapshot?.state !== 'READY' ? (
            <div className="operator-timer-details">
              <p>
                <b>Project</b> {snapshot?.projectName}
              </p>
              <p>
                <b>Task</b> {snapshot?.taskTitle ?? 'No task'}
              </p>
              <p>
                <b>Category</b> {snapshot?.categoryName}
              </p>
              <div className="operator-timer-actions">
                {snapshot?.state === 'RUNNING' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act('pause', { revision: snapshot.revision })}
                  >
                    <Pause aria-hidden="true" /> Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act('resume', { revision: snapshot!.revision })}
                  >
                    <Play aria-hidden="true" /> Resume
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    snapshot?.timerId &&
                    void act('stop', { timerId: snapshot.timerId, revision: snapshot.revision })
                  }
                >
                  <Save aria-hidden="true" /> Stop and save
                </button>
                {confirmDiscard ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() =>
                      snapshot?.timerId &&
                      void act('discard', {
                        timerId: snapshot.timerId,
                        revision: snapshot.revision,
                      })
                    }
                  >
                    Confirm discard
                  </button>
                ) : (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => setConfirmDiscard(true)}
                  >
                    <Trash2 aria-hidden="true" /> Discard…
                  </button>
                )}
              </div>
              {overEightHours && (
                <p className="operator-timer-warning" role="status">
                  This timer has run for over eight hours. It will keep running.
                </p>
              )}
            </div>
          ) : (
            <form
              className="operator-timer-form"
              onSubmit={(event) => {
                event.preventDefault();
                start();
              }}
            >
              <label>
                Project
                <select
                  required
                  value={projectId}
                  onChange={(event) => {
                    setProjectId(event.target.value);
                    setTaskId('');
                  }}
                >
                  <option value="">Choose a project</option>
                  {activeProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Category
                <select
                  required
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  disabled={!categories.length}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                  {!categories.length && <option value="">Choose a project first</option>}
                </select>
              </label>
              <label>
                Task <span className="muted">(optional)</span>
                <select
                  value={taskId}
                  onChange={(event) => setTaskId(event.target.value)}
                  disabled={!projectId}
                >
                  <option value="">No task</option>
                  {tasks
                    .filter((task) => task.projectId === projectId)
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.title}
                      </option>
                    ))}
                </select>
              </label>
              <button className="operator-timer-start" type="submit" disabled={!canStart}>
                <Play aria-hidden="true" /> Start timer
              </button>
              <p className="operator-timer-hint">
                Elapsed time is saved on this workspace and follows you across tabs and devices.
              </p>
            </form>
          )}
          {error && (
            <p className="operator-timer-error" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
