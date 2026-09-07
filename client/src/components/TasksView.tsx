import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Pause, Play, RotateCcw } from 'lucide-react';
import type { Task } from '../../../shared/types';
import { PageHead } from './Shell';

const WORK_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

function clock(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function TasksView({ tasks }: { tasks: Task[] }) {
  const activeTasks = useMemo(() => tasks.filter((task) => task.status !== 'COMPLETE'), [tasks]);
  const [selectedId, setSelectedId] = useState('');
  const [seconds, setSeconds] = useState(WORK_SECONDS);
  const [mode, setMode] = useState<'work' | 'break'>('work');
  const [running, setRunning] = useState(false);
  const selected = activeTasks.find((task) => task.id === selectedId) ?? activeTasks[0];

  useEffect(() => {
    if (selected && !activeTasks.some((task) => task.id === selectedId)) setSelectedId(selected.id);
  }, [activeTasks, selected, selectedId]);

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => {
      setSeconds((remaining) => {
        if (remaining > 1) return remaining - 1;
        setRunning(false);
        setMode((current) => (current === 'work' ? 'break' : 'work'));
        return mode === 'work' ? BREAK_SECONDS : WORK_SECONDS;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [mode, running]);

  const reset = () => {
    setRunning(false);
    setMode('work');
    setSeconds(WORK_SECONDS);
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
              onClick={() => setRunning((value) => !value)}
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
            <span className="count">{activeTasks.length}</span>
          </div>
          {activeTasks.length ? (
            <div className="task-picker-list">
              {activeTasks.map((task) => (
                <button
                  className={`task-picker-row ${task.id === selected?.id ? 'selected' : ''}`}
                  key={task.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(task.id);
                    reset();
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
