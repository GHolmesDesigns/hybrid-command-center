import type { CSSProperties } from 'react';
import { send } from '../api';
import type { Category, Tag, TaskStatus, TaskType } from '../../../shared/types';
import { normalizeTagName } from '../../../shared/types';
import { sidebarPalette, type Branding } from '../../../shared/branding';
import type { SignalChannelTreatment } from '../../../shared/signal';

/**
 * The chosen and derived sidebar colours, as custom properties for anything painted in the
 * sidebar's palette — the sidebar itself, the loading splash, and the Settings preview.
 */
export const brandStyle = (branding: Branding) => sidebarPalette(branding) as CSSProperties;

/**
 * A channel's three tokens as custom properties, the way `brandStyle` hands the sidebar its
 * palette: the stylesheet holds the chip's shape and this hands it the colours, so the planner,
 * the calendar, and the channel selector all paint from the map that was measured for contrast
 * rather than from a rule each of them keeps for itself.
 */
export const signalChannelStyle = ({ surface, border, text }: SignalChannelTreatment) =>
  ({
    '--channel-surface': surface,
    '--channel-border': border,
    '--channel-text': text,
  }) as CSSProperties;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To Do',
  IN_PROGRESS: 'In Progress',
  REVIEW: 'Review',
  COMPLETE: 'Complete',
};

export const STATUS_HELP: Record<TaskStatus, string> = {
  BACKLOG: 'Ideas and incoming work',
  TODO: 'Ready to begin',
  IN_PROGRESS: 'Currently moving',
  REVIEW: 'Waiting for approval',
  COMPLETE: 'Finished work',
};

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  BLOG_POST: 'Blog Post',
  VIDEO: 'Video',
  SOCIAL_POST: 'Social Post',
  GRAPHICS: 'Graphics',
  SCHEDULING: 'Scheduling',
  QA_BRAND_PASS: 'QA / Brand Pass',
  ADMIN: 'Admin',
  DEV_WORK: 'Dev Work',
  OTHER: 'Other',
};

/** A chip being chosen: an existing tag or category, or a name typed for one that is new. */
export type TagDraft = { id?: string; name: string; color?: string };
/** A saved tag or category, which is what the chip input can offer as a suggestion. */
export type ChipOption = { id: string; name: string; color?: string };

const TAG_ACCENTS = ['#2f6f52', '#315f79', '#7b4fa8', '#9b5f12', '#a33d63', '#4a6b8a'];

export const tagAccent = (tag: TagDraft) => {
  if (tag.color) return tag.color;
  const name = normalizeTagName(tag.name).toLowerCase();
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 100000;
  return TAG_ACCENTS[hash % TAG_ACCENTS.length];
};

export async function syncTaskTags(taskId: string, next: TagDraft[], previous: Tag[]) {
  const resolved: Tag[] = [];
  for (const draft of next)
    resolved.push(
      draft.id
        ? { id: draft.id, name: draft.name, color: draft.color }
        : await send<Tag>('/tags', 'POST', { name: draft.name }),
    );
  const keep = new Set(resolved.map((tag) => tag.id));
  for (const tag of previous)
    if (!keep.has(tag.id)) await send(`/tasks/${taskId}/tags/${tag.id}`, 'DELETE');
  const had = new Set(previous.map((tag) => tag.id));
  for (const tag of resolved)
    if (!had.has(tag.id)) await send(`/tasks/${taskId}/tags`, 'POST', { tagId: tag.id });
}

/**
 * Reconciles one project's categories against what the form was left holding, the way
 * `syncTaskTags` does for a task: names typed for the first time become categories, then only
 * the differences are attached and detached. Creating a name that already exists returns the
 * category holding it, so two projects typed into separately still share the one row.
 */
export async function syncProjectCategories(
  projectId: string,
  next: TagDraft[],
  previous: Category[],
) {
  const resolved: Category[] = [];
  for (const draft of next)
    resolved.push(
      draft.id
        ? { id: draft.id, name: draft.name, color: draft.color }
        : await send<Category>('/categories', 'POST', { name: draft.name }),
    );
  const keep = new Set(resolved.map((category) => category.id));
  for (const category of previous)
    if (!keep.has(category.id))
      await send(`/projects/${projectId}/categories/${category.id}`, 'DELETE');
  const had = new Set(previous.map((category) => category.id));
  for (const category of resolved)
    if (!had.has(category.id))
      await send(`/projects/${projectId}/categories`, 'POST', { categoryId: category.id });
}
