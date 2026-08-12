import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Check, FolderKanban, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { send } from '../api';
import type { Tag, Task } from '../../../shared/types';
import { InlineDateChip, InlineTextEditor } from './InlineEditors';
import { dateInput, formatDate } from './formatting';
import { TagChipInput } from './FormControls';
import { PriorityBadge, TaskTypeBadge } from './Primitives';
import { TaskChecklist, TaskDependencies } from './TaskDetailSections';
import { STATUS_LABEL, syncTaskTags } from './ui-shared';

export function TaskDetail({
  task,
  tasks,
  tags,
  close,
  edit,
  refresh,
  flash,
}: {
  task: Task;
  tasks: Task[];
  tags: Tag[];
  close: () => void;
  edit: () => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [text, setText] = useState(''),
    [dep, setDep] = useState(''),
    [renaming, setRenaming] = useState(false),
    [title, setTitle] = useState(task.title),
    [editingDescription, setEditingDescription] = useState(false),
    [description, setDescription] = useState(task.description ?? ''),
    [editingDue, setEditingDue] = useState(false),
    [dueDate, setDueDate] = useState(dateInput(task.dueDate)),
    [editingStart, setEditingStart] = useState(false),
    [startDate, setStartDate] = useState(dateInput(task.startDate)),
    [editingNotes, setEditingNotes] = useState(false),
    [notes, setNotes] = useState(task.notes ?? '');
  useEffect(() => {
    setTitle(task.title);
    setRenaming(false);
  }, [task.id, task.title]);
  // Saving one field refreshes the task; resetting only on id keeps other editors open.
  useEffect(() => {
    setDescription(task.description ?? '');
    setEditingDescription(false);
    setDueDate(dateInput(task.dueDate));
    setEditingDue(false);
    setStartDate(dateInput(task.startDate));
    setEditingStart(false);
    setNotes(task.notes ?? '');
    setEditingNotes(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the open task changes
  }, [task.id]);
  const mutate = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work();
      await refresh();
      flash(message);
      return true;
    } catch (e) {
      flash((e as Error).message, 'error');
      return false;
    }
  };
  const patchField = async (body: Record<string, string>, message: string, done: () => void) => {
    if (await mutate(() => send(`/tasks/${task.id}`, 'PATCH', body), message)) done();
  };
  const saveDescription = () => {
    const next = description.trim();
    if (next === (task.description ?? '').trim()) {
      setEditingDescription(false);
      setDescription(task.description ?? '');
      return;
    }
    void patchField({ description: next }, 'Description updated.', () =>
      setEditingDescription(false),
    );
  };
  const saveDue = () => {
    const next = dueDate;
    if (next === dateInput(task.dueDate)) {
      setEditingDue(false);
      return;
    }
    void patchField({ dueDate: next }, 'Due date updated.', () => setEditingDue(false));
  };
  const saveStart = () => {
    const next = startDate;
    if (next === dateInput(task.startDate)) {
      setEditingStart(false);
      return;
    }
    void patchField({ startDate: next }, 'Start date updated.', () => setEditingStart(false));
  };
  const saveNotes = () => {
    const next = notes.trim();
    if (next === (task.notes ?? '').trim()) {
      setEditingNotes(false);
      setNotes(task.notes ?? '');
      return;
    }
    void patchField({ notes: next }, 'Notes updated.', () => setEditingNotes(false));
  };
  const complete = async () => {
    try {
      await send(`/tasks/${task.id}`, 'PATCH', { status: 'COMPLETE' });
      await refresh();
      flash('Task completed.');
      close();
    } catch (e: any) {
      if (e.status === 409 && confirm(`${e.message}\n\nOverride the block and complete anyway?`)) {
        await send(`/tasks/${task.id}`, 'PATCH', { status: 'COMPLETE', overrideBlocked: true });
        await refresh();
        flash('Task completed with override.');
        close();
      } else flash(e.message, 'error');
    }
  };
  const rename = async (e: FormEvent) => {
    e.preventDefault();
    const next = title.trim();
    if (!next || next === task.title) {
      setRenaming(false);
      setTitle(task.title);
      return;
    }
    try {
      await send(`/tasks/${task.id}`, 'PATCH', { title: next });
      await refresh();
      setRenaming(false);
      flash('Task renamed.');
    } catch (err) {
      flash((err as Error).message, 'error');
    }
  };
  const remove = async () => {
    if (
      !confirm(
        `Delete task “${task.title}”?\n\nThis removes the task from Command Center only. Drive folders and files are not touched.`,
      )
    )
      return;
    try {
      await send(`/tasks/${task.id}`, 'DELETE');
      await refresh();
      flash('Task deleted from Command Center. Drive files were left alone.');
      close();
    } catch (err) {
      flash((err as Error).message, 'error');
    }
  };
  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <div className="card-labels">
          <PriorityBadge priority={task.priority} />
          {task.taskType && <TaskTypeBadge type={task.taskType} />}
          {task.blocked && (
            <span className="blocked-label">
              <ShieldAlert /> Blocked
            </span>
          )}
          {task.overdue && (
            <span className="overdue-label">
              <AlertCircle /> Overdue
            </span>
          )}
        </div>
        {renaming ? (
          <form className="rename-form" onSubmit={rename}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              aria-label="Task title"
            />
            <button type="submit">
              <Check /> Save
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setRenaming(false);
                setTitle(task.title);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="title-row">
            <h3>{task.title}</h3>
            <button className="icon-btn" onClick={() => setRenaming(true)} aria-label="Rename task">
              <Pencil />
            </button>
          </div>
        )}
        <span>
          {task.clientName} · {task.projectName}
        </span>
        <InlineTextEditor
          label="Description"
          value={task.description}
          emptyLabel="Add a description"
          editLabel="Edit description"
          editing={editingDescription}
          draft={description}
          onDraftChange={setDescription}
          onEdit={() => {
            setDescription(task.description ?? '');
            setEditingDescription(true);
          }}
          onCancel={() => {
            setDescription(task.description ?? '');
            setEditingDescription(false);
          }}
          onSave={saveDescription}
        />
        <div className="detail-chips">
          <span>
            <FolderKanban />
            {STATUS_LABEL[task.status]}
          </span>
          <InlineDateChip
            label="Due date"
            display={
              task.dueDate ? `${task.overdue ? 'Due ' : ''}${formatDate(task.dueDate)}` : 'No date'
            }
            editLabel={task.dueDate ? 'Edit due date' : 'Add due date'}
            editing={editingDue}
            draft={dueDate}
            muted={!task.dueDate}
            overdue={task.overdue}
            onDraftChange={setDueDate}
            onEdit={() => {
              setDueDate(dateInput(task.dueDate));
              setEditingDue(true);
            }}
            onCancel={() => {
              setDueDate(dateInput(task.dueDate));
              setEditingDue(false);
            }}
            onSave={saveDue}
          />
          <InlineDateChip
            label="Start date"
            display={task.startDate ? formatDate(task.startDate) : 'No start date'}
            editLabel={task.startDate ? 'Edit start date' : 'Add start date'}
            editing={editingStart}
            draft={startDate}
            muted={!task.startDate}
            onDraftChange={setStartDate}
            onEdit={() => {
              setStartDate(dateInput(task.startDate));
              setEditingStart(true);
            }}
            onCancel={() => {
              setStartDate(dateInput(task.startDate));
              setEditingStart(false);
            }}
            onSave={saveStart}
          />
        </div>
      </div>
      {task.blocked && (
        <div className="inline-warning blocked">
          <ShieldAlert />
          <div>
            <strong>
              Waiting on {task.blockingDependencies.length} task
              {task.blockingDependencies.length === 1 ? '' : 's'}
            </strong>
            <span>{task.blockingDependencies.map((d) => d.title).join(', ')}</span>
          </div>
        </div>
      )}
      <section>
        <div className="section-title">
          <div>
            <span className="eyebrow">Labels</span>
            <h2>Tags</h2>
          </div>
        </div>
        <TagChipInput
          label="Tags"
          chosen={task.tags}
          available={tags}
          onChange={(next) => mutate(() => syncTaskTags(task.id, next, task.tags), 'Tags updated.')}
        />
      </section>
      <TaskChecklist task={task} text={text} setText={setText} mutate={mutate} />
      <section>
        <div className="section-title">
          <div>
            <span className="eyebrow">Private</span>
            <h2>Notes</h2>
          </div>
        </div>
        <InlineTextEditor
          label="Notes"
          value={task.notes}
          emptyLabel="Add notes"
          editLabel="Edit notes"
          editing={editingNotes}
          draft={notes}
          onDraftChange={setNotes}
          onEdit={() => {
            setNotes(task.notes ?? '');
            setEditingNotes(true);
          }}
          onCancel={() => {
            setNotes(task.notes ?? '');
            setEditingNotes(false);
          }}
          onSave={saveNotes}
        />
      </section>
      <TaskDependencies task={task} tasks={tasks} dep={dep} setDep={setDep} mutate={mutate} />
      <footer>
        <button className="secondary danger-outline" onClick={remove}>
          <Trash2 /> Delete task
        </button>
        <button className="secondary" onClick={edit}>
          <Pencil /> Edit details
        </button>
        {task.status !== 'COMPLETE' && (
          <button onClick={complete}>
            <Check /> Mark complete
          </button>
        )}
        <button className="secondary" onClick={close}>
          Close
        </button>
      </footer>
    </div>
  );
}
