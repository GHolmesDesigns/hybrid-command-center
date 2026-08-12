import { useState, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { send } from '../api';
import type { Category, Client, Project, Tag, Task } from '../../../shared/types';
import { TASK_STATUSES, TASK_TYPES } from '../../../shared/types';
import { type Modal } from './App';
import { dateInput } from './formatting';
import { Field, FormEnd, Select, TagChipInput, TextArea } from './FormControls';
import { TASK_TYPE_LABEL, type TagDraft, syncProjectCategories, syncTaskTags } from './ui-shared';
import { TaskDetail } from './TaskDetail';

export function ModalHost({
  modal,
  clients,
  projects,
  tasks,
  tags,
  categories,
  close,
  edit,
  saved,
  refresh,
  flash,
}: {
  modal: NonNullable<Modal>;
  clients: Client[];
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  categories: Category[];
  close: () => void;
  /** Swaps the detail view for the full edit form. */
  edit: (task: Task) => void;
  saved: (s: string) => Promise<void>;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  if (modal.type === 'client')
    return (
      <EntityModal title={modal.value ? 'Edit client' : 'New client'} close={close}>
        <ClientForm value={modal.value} saved={saved} />
      </EntityModal>
    );
  if (modal.type === 'project')
    return (
      <EntityModal title={modal.value ? 'Edit project' : 'New project'} close={close}>
        <ProjectForm
          value={modal.value}
          defaultClient={modal.clientId}
          clients={clients}
          categories={categories}
          saved={saved}
        />
      </EntityModal>
    );
  if (modal.type === 'task')
    return (
      <EntityModal title={modal.value ? 'Edit task' : 'New task'} close={close}>
        <TaskForm
          value={modal.value}
          defaultProject={modal.projectId}
          projects={projects.filter(
            (project) =>
              (project.status !== 'ARCHIVED' &&
                !clients.some(
                  (client) => client.id === project.clientId && client.status === 'ARCHIVED',
                )) ||
              project.id === modal.value?.projectId,
          )}
          tags={tags}
          saved={saved}
        />
      </EntityModal>
    );
  const task = tasks.find((t) => t.id === modal.value.id) || modal.value;
  const activeProjectIds = new Set(
    projects
      .filter(
        (project) =>
          project.status !== 'ARCHIVED' &&
          !clients.some((client) => client.id === project.clientId && client.status === 'ARCHIVED'),
      )
      .map((project) => project.id),
  );
  const dependencyVisibleTasks = tasks.filter(
    (candidate) =>
      activeProjectIds.has(candidate.projectId) ||
      candidate.id === task.id ||
      task.dependencyIds.includes(candidate.id),
  );
  return (
    <EntityModal title="Task details" wide close={close}>
      <TaskDetail
        task={task}
        tasks={dependencyVisibleTasks}
        tags={tags}
        close={close}
        edit={() => edit(task)}
        refresh={refresh}
        flash={flash}
      />
    </EntityModal>
  );
}

function EntityModal({
  title,
  close,
  children,
  wide,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <div>
            <span className="eyebrow">Command Center</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ClientForm({ value, saved }: { value?: Client; saved: (s: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await send(value ? `/clients/${value.id}` : '/clients', value ? 'PATCH' : 'POST', data);
      await saved(
        value ? 'Client updated.' : 'Client created. Drive setup is continuing in the background.',
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Client name" name="name" value={value?.name} required />
      <div className="form-row">
        <Field label="Contact name" name="contactName" value={value?.contactName} />
        <Field label="Email" name="email" type="email" value={value?.email} />
      </div>
      <div className="form-row">
        <Field label="Phone" name="phone" value={value?.phone} />
        <Field label="Website" name="website" type="url" value={value?.website} />
      </div>
      <TextArea label="Notes" name="notes" value={value?.notes} />
      <FormEnd error={error} busy={busy} label={value ? 'Save changes' : 'Create client'} />
    </form>
  );
}

function ProjectForm({
  value,
  defaultClient,
  clients,
  categories,
  saved,
}: {
  value?: Project;
  defaultClient?: string;
  clients: Client[];
  categories: Category[];
  saved: (s: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // Categories are the one field FormData cannot carry, for the same reason task tags are
  // not: a multi-value list resolved against the shared table, so it is held in state and
  // reconciled once the project has an id to attach to.
  const [chosen, setChosen] = useState<TagDraft[]>(value?.categories ?? []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const project = await send<Project>(
        value ? `/projects/${value.id}` : '/projects',
        value ? 'PATCH' : 'POST',
        data,
      );
      await syncProjectCategories(project.id, chosen, value?.categories ?? []);
      await saved(
        value ? 'Project updated.' : 'Project created. Drive folders are being prepared.',
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Client
        <select name="clientId" defaultValue={value?.clientId || defaultClient || ''} required>
          <option value="" disabled>
            Select a client
          </option>
          {clients
            .filter((c) => c.status === 'ACTIVE' || c.id === value?.clientId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <Field label="Project name" name="name" value={value?.name} required />
      <TextArea label="Description" name="description" value={value?.description} />
      <div className="form-row">
        <Select
          label="Status"
          name="status"
          value={value?.status || 'ACTIVE'}
          options={['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETE']}
        />
        <Select
          label="Priority"
          name="priority"
          value={value?.priority || 'MEDIUM'}
          options={['LOW', 'MEDIUM', 'HIGH', 'URGENT']}
        />
      </div>
      <div className="form-row">
        <Field
          label="Start date"
          name="startDate"
          type="date"
          value={dateInput(value?.startDate)}
        />
        <Field
          label="Target deadline"
          name="targetDeadline"
          type="date"
          value={dateInput(value?.targetDeadline)}
        />
      </div>
      <TagChipInput
        label="Categories"
        noun="category"
        chosen={chosen}
        available={categories}
        onChange={setChosen}
      />
      <TextArea label="Notes" name="notes" value={value?.notes} />
      <FormEnd error={error} busy={busy} label={value ? 'Save changes' : 'Create project'} />
    </form>
  );
}

function TaskForm({
  value,
  defaultProject,
  projects,
  tags,
  saved,
}: {
  value?: Task;
  defaultProject?: string;
  projects: Project[];
  tags: Tag[];
  saved: (s: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // Tags are the one field FormData cannot carry: they are a multi-value list resolved
  // against the global tag table, so they are held in state and reconciled after the save.
  const [chosen, setChosen] = useState<TagDraft[]>(value?.tags ?? []);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const task = await send<Task>(
        value ? `/tasks/${value.id}` : '/tasks',
        value ? 'PATCH' : 'POST',
        data,
      );
      await syncTaskTags(task.id, chosen, value?.tags ?? []);
      await saved(value ? 'Task updated.' : 'Task added to the board.');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label>
        Project
        <select name="projectId" defaultValue={value?.projectId || defaultProject || ''} required>
          <option value="" disabled>
            Select a project
          </option>
          {projects
            .filter((p) => p.status !== 'ARCHIVED')
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.clientName} — {p.name}
              </option>
            ))}
        </select>
      </label>
      <Field label="Task title" name="title" value={value?.title} required />
      <TextArea label="Description" name="description" value={value?.description} />
      <div className="form-row triple">
        <Select
          label="Status"
          name="status"
          value={value?.status || 'BACKLOG'}
          options={TASK_STATUSES}
        />
        <Select
          label="Priority"
          name="priority"
          value={value?.priority || 'MEDIUM'}
          options={['LOW', 'MEDIUM', 'HIGH', 'URGENT']}
        />
        <Select
          label="Type"
          name="taskType"
          value={value?.taskType || ''}
          options={TASK_TYPES}
          labels={TASK_TYPE_LABEL}
          placeholder="No type"
        />
      </div>
      <div className="form-row">
        <Field
          label="Start date"
          name="startDate"
          type="date"
          value={dateInput(value?.startDate)}
        />
        <Field label="Due date" name="dueDate" type="date" value={dateInput(value?.dueDate)} />
      </div>
      <TagChipInput label="Tags" chosen={chosen} available={tags} onChange={setChosen} />
      <TextArea label="Notes" name="notes" value={value?.notes} />
      <FormEnd error={error} busy={busy} label={value ? 'Save changes' : 'Create task'} />
    </form>
  );
}
