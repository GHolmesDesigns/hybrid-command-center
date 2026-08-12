import { type KeyboardEvent } from 'react';
import { CalendarDays, Check, Pencil } from 'lucide-react';

function escapeCancels(cancel: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
}

export function InlineTextEditor({
  label,
  value,
  emptyLabel,
  editLabel,
  editing,
  draft,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  label: string;
  value?: string;
  emptyLabel: string;
  editLabel: string;
  editing: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (editing)
    return (
      <form
        className="inline-edit"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        onKeyDown={escapeCancels(onCancel)}
      >
        <label>
          {label}
          <textarea value={draft} onChange={(e) => onDraftChange(e.target.value)} autoFocus />
        </label>
        <div className="inline-edit-actions">
          <button type="submit">
            <Check /> Save
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    );
  if (value)
    return (
      <div className="inline-field">
        <p>{value}</p>
        <button type="button" className="icon-btn" onClick={onEdit} aria-label={editLabel}>
          <Pencil />
        </button>
      </div>
    );
  return (
    <button type="button" className="text-btn inline-empty" onClick={onEdit}>
      {emptyLabel}
    </button>
  );
}

export function InlineDateChip({
  label,
  display,
  editLabel,
  editing,
  draft,
  muted,
  overdue,
  onDraftChange,
  onEdit,
  onCancel,
  onSave,
}: {
  label: string;
  display: string;
  editLabel: string;
  editing: boolean;
  draft: string;
  muted?: boolean;
  overdue?: boolean;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (editing)
    return (
      <form
        className="chip-edit-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave();
        }}
        onKeyDown={escapeCancels(onCancel)}
      >
        <label>
          {label}
          <input
            type="date"
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            autoFocus
          />
        </label>
        <button type="submit">
          <Check /> Save
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </form>
    );
  return (
    <button
      type="button"
      className={`chip-toggle${muted ? ' muted' : ''}${overdue ? ' overdue-text' : ''}`}
      onClick={onEdit}
      aria-label={editLabel}
    >
      <CalendarDays />
      {display}
    </button>
  );
}
