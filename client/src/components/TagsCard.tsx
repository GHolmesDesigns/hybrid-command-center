import { Tag as TagIcon, Trash2 } from 'lucide-react';
import { send } from '../api';
import type { Tag, Task } from '../../../shared/types';
import { TagChip } from './FormControls';
import { Empty } from './Primitives';

export function TagsCard({
  tags,
  tasks,
  refresh,
  flash,
}: {
  tags: Tag[];
  tasks: Task[];
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const usage = (tag: Tag) => tasks.filter((t) => t.tags.some((x) => x.id === tag.id)).length;
  const remove = async (tag: Tag) => {
    try {
      await send(`/tags/${tag.id}`, 'DELETE');
      await refresh();
      flash(`Tag “${tag.name}” deleted.`);
    } catch (error: any) {
      if (error.status !== 409 || error.data?.code !== 'TAG_IN_USE')
        return flash(error.message, 'error');
      const count: number = error.data.attachedTaskCount;
      const tasksWord = `${count} task${count === 1 ? '' : 's'}`;
      if (
        !confirm(
          `“${tag.name}” is attached to ${tasksWord}.\n\nDelete the tag and remove it from ${count === 1 ? 'that task' : 'those tasks'}? The ${count === 1 ? 'task itself is' : 'tasks themselves are'} not deleted.`,
        )
      )
        return;
      try {
        await send(`/tags/${tag.id}?confirm=true`, 'DELETE');
        await refresh();
        flash(`Tag “${tag.name}” deleted from ${tasksWord}.`);
      } catch (confirmed) {
        flash((confirmed as Error).message, 'error');
      }
    }
  };
  return (
    <section className="panel settings-card">
      <div className="settings-icon neutral">
        <TagIcon />
      </div>
      <div className="section-title">
        <div>
          <span className="eyebrow">Labels</span>
          <h2>Task tags</h2>
        </div>
        <span className="version-pill">{tags.length}</span>
      </div>
      <p>
        Tags are shared by every task. Add one from a task’s details to create it; deleting one here
        removes it from every task that carries it, and never deletes a task.
      </p>
      {tags.length ? (
        <ul className="tag-manager">
          {tags.map((tag) => (
            <li key={tag.id}>
              <TagChip tag={tag} />
              <span>
                {usage(tag)} task{usage(tag) === 1 ? '' : 's'}
              </span>
              <button
                className="icon-btn danger"
                onClick={() => remove(tag)}
                aria-label={`Delete tag ${tag.name}`}
              >
                <Trash2 />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty compact title="No tags yet" body="Tag a task to start building the shared list." />
      )}
    </section>
  );
}
