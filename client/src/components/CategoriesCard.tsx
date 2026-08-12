import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Check, Pencil, Plus, Tags as TagsIcon, Trash2 } from 'lucide-react';
import { send } from '../api';
import type { Category, Project } from '../../../shared/types';
import { normalizeCategoryName, sameCategoryName } from '../../../shared/types';
import { TagChip } from './FormControls';
import { Empty } from './Primitives';

/**
 * The workspace's project categories: the one place a category is renamed or removed, beside
 * how many projects carry it. Renaming here reaches every project at once because the name
 * lives on the category row, not on the projects — and deleting one detaches it without
 * touching a single project.
 */
export function CategoriesCard({
  categories,
  projects,
  refresh,
  flash,
}: {
  categories: Category[];
  projects: Project[];
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<string | null>(null),
    [rename, setRename] = useState('');
  const usage = (category: Category) =>
    projects.filter((project) => project.categories.some((c) => c.id === category.id)).length;
  const projectsWord = (count: number) => `${count} project${count === 1 ? '' : 's'}`;
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = normalizeCategoryName(draft);
    if (!name) return;
    // The server reuses an existing name rather than refusing it, so say which happened.
    const existing = categories.find((category) => sameCategoryName(category.name, name));
    setBusy(true);
    try {
      await send('/categories', 'POST', { name });
      setDraft('');
      await refresh();
      flash(
        existing
          ? `“${existing.name}” is already in the list.`
          : `Category “${name}” added to the list.`,
      );
    } catch (error) {
      flash((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const startRename = (category: Category) => {
    setEditing(category.id);
    setRename(category.name);
  };
  const cancelRename = () => {
    setEditing(null);
    setRename('');
  };
  const saveRename = async (category: Category, event: FormEvent) => {
    event.preventDefault();
    const name = normalizeCategoryName(rename);
    if (!name || name === category.name) return cancelRename();
    try {
      await send(`/categories/${category.id}`, 'PATCH', { name });
      cancelRename();
      await refresh();
      flash(`Category renamed to “${name}” on ${projectsWord(usage(category))}.`);
    } catch (error) {
      // The name is still in the field, so the correction is one edit away.
      flash((error as Error).message, 'error');
    }
  };
  const remove = async (category: Category) => {
    try {
      await send(`/categories/${category.id}`, 'DELETE');
      await refresh();
      flash(`Category “${category.name}” deleted.`);
    } catch (error: any) {
      if (error.status !== 409 || error.data?.code !== 'CATEGORY_IN_USE')
        return flash(error.message, 'error');
      const count: number = error.data.attachedProjectCount;
      if (
        !confirm(
          `“${category.name}” is attached to ${projectsWord(count)}.\n\nDelete the category and remove it from ${count === 1 ? 'that project' : 'those projects'}? The ${count === 1 ? 'project itself is' : 'projects themselves are'} not deleted.`,
        )
      )
        return;
      try {
        await send(`/categories/${category.id}?confirm=true`, 'DELETE');
        await refresh();
        flash(`Category “${category.name}” deleted from ${projectsWord(count)}.`);
      } catch (confirmed) {
        flash((confirmed as Error).message, 'error');
      }
    }
  };
  const escapeCancels = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancelRename();
  };
  return (
    <section className="panel settings-card">
      <div className="settings-icon neutral">
        <TagsIcon />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Organization</span>
          <h2>Project categories</h2>
        </div>
        <span className="version-pill">{categories.length}</span>
      </div>
      <p>
        Categories are shared by every project, and a project can carry as many as it needs. Add one
        here or straight from a project’s form; renaming one renames it on every project, and
        deleting one only removes the label — never a project.
      </p>
      <form className="chip-input-row" onSubmit={create}>
        <label className="sr-only" htmlFor="new-category">
          New category name
        </label>
        <input
          id="new-category"
          value={draft}
          maxLength={60}
          placeholder="Add a category, e.g. Retainer"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={busy || !normalizeCategoryName(draft)}>
          <Plus /> Add
        </button>
      </form>
      {categories.length ? (
        <ul className="tag-manager">
          {categories.map((category) => (
            <li key={category.id}>
              {editing === category.id ? (
                <form
                  className="inline-rename"
                  onSubmit={(event) => saveRename(category, event)}
                  onKeyDown={escapeCancels}
                >
                  <label>
                    <span className="sr-only">{`New name for ${category.name}`}</span>
                    <input
                      value={rename}
                      maxLength={60}
                      autoFocus
                      onChange={(event) => setRename(event.target.value)}
                    />
                  </label>
                  <button type="submit">
                    <Check /> Save
                  </button>
                  <button type="button" className="secondary" onClick={cancelRename}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <TagChip tag={category} />
                  <span>{projectsWord(usage(category))}</span>
                  <button
                    className="icon-btn"
                    onClick={() => startRename(category)}
                    aria-label={`Rename category ${category.name}`}
                  >
                    <Pencil />
                  </button>
                  <button
                    className="icon-btn danger"
                    onClick={() => remove(category)}
                    aria-label={`Delete category ${category.name}`}
                  >
                    <Trash2 />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Empty
          compact
          title="No categories yet"
          body="Add one above, or type one into a project to create it."
        />
      )}
    </section>
  );
}
