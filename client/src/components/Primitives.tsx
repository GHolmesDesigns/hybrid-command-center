import { useEffect, useState, type ReactNode } from 'react';
import { CalendarDays, FolderKanban, Search, X } from 'lucide-react';
import type { DriveStatus, Priority, Task, TaskStatus, TaskType } from '../../../shared/types';
import type { Branding } from '../../../shared/branding';
import { formatDate } from './formatting';
import { STATUS_LABEL, TASK_TYPE_LABEL } from './ui-shared';

/**
 * The logo when one is set, the text mark otherwise. A logo is a remote address, so it can
 * fail to load long after it was saved; falling back to the mark keeps the brand present
 * rather than leaving a broken image where it used to be.
 */
export function BrandMark({ branding }: { branding: Branding }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [branding.logoUrl]);
  if (branding.logoUrl && !failed)
    return (
      <img
        className="brand-logo"
        src={branding.logoUrl}
        alt={branding.logoAlt}
        onError={() => setFailed(true)}
      />
    );
  return (
    <div className="brand-mark" title={branding.title}>
      {branding.mark}
    </div>
  );
}

export function SearchBox({
  value,
  set,
  placeholder,
}: {
  value: string;
  set: (s: string) => void;
  placeholder: string;
}) {
  return (
    <label className="search-box">
      <Search />
      <span className="sr-only">Search</span>
      <input value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder} />
      {value && (
        <button onClick={() => set('')} aria-label="Clear search">
          <X />
        </button>
      )}
    </label>
  );
}

export function DriveBadge({ status }: { status: DriveStatus | string | undefined }) {
  const value = (status || 'DISCONNECTED').toLowerCase();
  return (
    <span className={`drive-badge ${value}`}>
      <span />
      {value === 'connected'
        ? 'Drive ready'
        : value === 'pending'
          ? 'Drive pending'
          : value === 'failed'
            ? 'Drive issue'
            : 'Drive offline'}
    </span>
  );
}

export function TaskTypeBadge({ type }: { type: TaskType }) {
  return <span className="task-type-badge">{TASK_TYPE_LABEL[type]}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`priority-badge ${priority.toLowerCase()}`}>{priority}</span>;
}

export function StatusDot({ status }: { status: TaskStatus }) {
  return <span className={`status-dot ${status.toLowerCase()}`} title={STATUS_LABEL[status]} />;
}

export function Due({ task }: { task: Task }) {
  if (!task.dueDate)
    return (
      <span className="due muted">
        <CalendarDays /> No date
      </span>
    );
  return (
    <span className={`due ${task.overdue ? 'overdue-text' : ''}`}>
      <CalendarDays />
      {task.overdue ? 'Due ' : ''}
      {formatDate(task.dueDate)}
    </span>
  );
}

export function Empty({
  title,
  body,
  action,
  compact,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty ${compact ? 'compact' : ''}`}>
      <div>
        <FolderKanban />
      </div>
      <strong>{title}</strong>
      <p>{body}</p>
      {action}
    </div>
  );
}
