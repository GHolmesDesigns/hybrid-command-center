import { Plus, X } from 'lucide-react';
import { send } from '../api';
import type { Task } from '../../../shared/types';
import { compareTasksByProjectThenTitle } from '../../../shared/types';
import { StatusDot } from './Primitives';

type Mutate = (work: () => Promise<unknown>, message: string) => Promise<boolean>;

export function TaskChecklist({
  task,
  text,
  setText,
  mutate,
}: {
  task: Task;
  text: string;
  setText: (value: string) => void;
  mutate: Mutate;
}) {
  return (
    <section>
      <div className="section-title">
        <div>
          <span className="eyebrow">Progress</span>
          <h2>
            Checklist{' '}
            <small>
              {task.checklistCompleted}/{task.checklistTotal}
            </small>
          </h2>
        </div>
      </div>
      <div className="checklist">
        {task.checklist.map((item) => (
          <label key={item.id}>
            <input
              type="checkbox"
              checked={item.completed}
              onChange={() =>
                mutate(
                  () => send(`/checklist/${item.id}`, 'PATCH', { completed: !item.completed }),
                  'Checklist updated.',
                )
              }
            />
            <span>{item.text}</span>
            <button
              type="button"
              onClick={() =>
                mutate(() => send(`/checklist/${item.id}`, 'DELETE'), 'Checklist item removed.')
              }
              aria-label={`Delete ${item.text}`}
            >
              <X />
            </button>
          </label>
        ))}
      </div>
      <form
        className="inline-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim()) return;
          mutate(
            () => send(`/tasks/${task.id}/checklist`, 'POST', { text }),
            'Checklist item added.',
          );
          setText('');
        }}
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Add a checklist item"
        />
        <button>
          <Plus /> Add
        </button>
      </form>
    </section>
  );
}

/**
 * The Dependencies picker's options: every task that could still become a dependency of
 * `task`, alphabetical by project and then by title, grouped so a project's name is written
 * once above its tasks rather than repeated on every line. Groups follow the same order, and
 * `compareTasksByProjectThenTitle` keeps one project's tasks in a single run, so walking the
 * sorted list is all it takes to build them.
 *
 * The only exclusions applied here are the task itself and the dependencies it already has,
 * both of which `ModalHost` deliberately leaves in `tasks` so the list above the picker can
 * still name them. Which tasks are visible at all is the caller's decision — archived
 * clients' work is filtered out before this sees it — and the rules that refuse an edge,
 * circular dependencies above all, stay on the server.
 */
function dependencyOptions(task: Task, tasks: Task[]) {
  const groups: { projectId: string; label: string; tasks: Task[] }[] = [];
  const candidates = tasks
    .filter((candidate) => candidate.id !== task.id && !task.dependencyIds.includes(candidate.id))
    .sort(compareTasksByProjectThenTitle);
  for (const candidate of candidates) {
    const last = groups.at(-1);
    if (last?.projectId === candidate.projectId) last.tasks.push(candidate);
    else
      groups.push({
        projectId: candidate.projectId,
        label: candidate.projectName ?? 'Unnamed project',
        tasks: [candidate],
      });
  }
  return groups;
}

export function TaskDependencies({
  task,
  tasks,
  dep,
  setDep,
  mutate,
}: {
  task: Task;
  tasks: Task[];
  dep: string;
  setDep: (value: string) => void;
  mutate: Mutate;
}) {
  return (
    <section>
      <div className="section-title">
        <div>
          <span className="eyebrow">Sequencing</span>
          <h2>Dependencies</h2>
        </div>
      </div>
      {task.dependencyIds.length > 0 && (
        <div className="dependency-list">
          {task.dependencyIds.map((depId) => {
            const dependency = tasks.find((candidate) => candidate.id === depId);
            return (
              dependency && (
                <div key={depId}>
                  <StatusDot status={dependency.status} />
                  <span>{dependency.title}</span>
                  <button
                    onClick={() =>
                      mutate(
                        () => send(`/tasks/${task.id}/dependencies/${depId}`, 'DELETE'),
                        'Dependency removed.',
                      )
                    }
                    aria-label={`Remove ${dependency.title}`}
                  >
                    <X />
                  </button>
                </div>
              )
            );
          })}
        </div>
      )}
      <form
        className="inline-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!dep) return;
          mutate(
            () => send(`/tasks/${task.id}/dependencies`, 'POST', { dependencyId: dep }),
            'Dependency added.',
          );
          setDep('');
        }}
      >
        <select
          aria-label="Dependency task"
          value={dep}
          onChange={(event) => setDep(event.target.value)}
        >
          <option value="">Choose a task…</option>
          {dependencyOptions(task, tasks).map((group) => (
            <optgroup key={group.projectId} label={group.label}>
              {group.tasks.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button disabled={!dep}>
          <Plus /> Add
        </button>
      </form>
    </section>
  );
}
