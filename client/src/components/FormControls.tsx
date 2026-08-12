import { useId, useState, type KeyboardEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import type { Tag } from '../../../shared/types';
import { normalizeTagName, sameTagName } from '../../../shared/types';
import { type TagDraft, tagAccent } from './ui-shared';

export function Field({
  label,
  name,
  value,
  type = 'text',
  required,
}: {
  label: string;
  name: string;
  value?: string;
  type?: string;
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <input name={name} type={type} defaultValue={value || ''} required={required} />
    </label>
  );
}

export function TextArea({ label, name, value }: { label: string; name: string; value?: string }) {
  return (
    <label>
      {label}
      <textarea name={name} defaultValue={value || ''} rows={3} />
    </label>
  );
}

export function Select({
  label,
  name,
  value,
  options,
  labels,
  placeholder,
}: {
  label: string;
  name: string;
  value: string;
  options: readonly string[];
  /** Display text per option. Falls back to the raw value with underscores spaced out. */
  labels?: Record<string, string>;
  /** Leading empty-value option, for a field that may legitimately be left unset. */
  placeholder?: string;
}) {
  return (
    <label>
      {label}
      <select name={name} defaultValue={value}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TagChip({ tag }: { tag: TagDraft }) {
  const accent = tagAccent(tag);
  return (
    <span className="tag-chip" style={{ borderColor: accent }}>
      <span className="tag-dot" style={{ background: accent }} />
      {tag.name}
    </span>
  );
}

export function TagChipInput({
  label,
  chosen,
  available,
  onChange,
}: {
  label: string;
  chosen: TagDraft[];
  available: Tag[];
  onChange: (next: TagDraft[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const listId = useId();
  const commit = (raw: string) => {
    const name = normalizeTagName(raw);
    setDraft('');
    if (!name || chosen.some((tag) => sameTagName(tag.name, name))) return;
    onChange([...chosen, available.find((tag) => sameTagName(tag.name, name)) ?? { name }]);
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      // Enter would otherwise submit the surrounding task form with the name still unread.
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && !draft && chosen.length) onChange(chosen.slice(0, -1));
  };
  return (
    <div className="chip-input">
      <span className="chip-input-label">{label}</span>
      {chosen.length > 0 && (
        <ul className="tag-list" aria-label={`Selected ${label.toLowerCase()}`}>
          {chosen.map((tag) => (
            <li key={tag.id ?? `new-${tag.name}`}>
              <TagChip tag={tag} />
              <button
                type="button"
                className="tag-remove"
                onClick={() => onChange(chosen.filter((candidate) => candidate !== tag))}
                aria-label={`Remove tag ${tag.name}`}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chip-input-row">
        <input
          value={draft}
          list={listId}
          aria-label="Add a tag"
          placeholder="Type a tag, then press Enter"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={keyDown}
          onBlur={() => commit(draft)}
        />
        <button type="button" onClick={() => commit(draft)}>
          <Plus /> Add
        </button>
      </div>
      <datalist id={listId}>
        {available
          .filter((tag) => !chosen.some((candidate) => sameTagName(candidate.name, tag.name)))
          .map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
      </datalist>
    </div>
  );
}

export function FormEnd({ error, busy, label }: { error: string; busy: boolean; label: string }) {
  return (
    <>
      <div className="form-error" role="alert">
        {error}
      </div>
      <button className="submit" disabled={busy}>
        {busy ? (
          <>
            <RefreshCw className="spin" /> Saving…
          </>
        ) : (
          label
        )}
      </button>
    </>
  );
}
