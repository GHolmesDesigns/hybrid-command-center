import type { SignalPost } from './signal.ts';
import type { Task } from './types.ts';

/**
 * The calendar: Signal's schedule and task due dates over one span of days (FR7, §8.7).
 *
 * ## Two kinds, kept apart
 *
 * A scheduled post and a task due date are not the same thing and this shape refuses to pretend
 * otherwise. They arrive as two arrays, never as one list of "events" with a type tag — because
 * the moment they share a list, something downstream sorts them together, counts them together,
 * and the distinction survives only as a colour. They answer different questions: one is content
 * going out, the other is work coming due.
 *
 * ## Days
 *
 * Both kinds are placed by the same rule, which is the one already stated in `shared/signal.ts`:
 * a `YYYY-MM-DD` string in local time, compared as a string, with no instant derived from it.
 * Task due dates are already stored that way (`AGENTS.md`), so the two kinds agree on what a day
 * is without either being converted.
 *
 * ## When Signal cannot answer
 *
 * `signal.available` false means the schedule could not be read; `tasks` is still populated and
 * still correct. Half a calendar with a visible reason beats an empty one, and beats a page that
 * fails whole because one of its two sources did.
 */

/** How the schedule half of a range turned out. */
export interface CalendarSignalState {
  /** False when the provider could not answer. `posts` is empty and `error` says why. */
  available: boolean;
  /** The provider's own words, never a credential. Null unless `available` is false. */
  error: string | null;
  /** True when the range held more posts than one request returns. */
  truncated: boolean;
}

export interface CalendarRange {
  /** Inclusive `YYYY-MM-DD` bounds, in local time. */
  from: string;
  to: string;
  /** Signal's scheduled content: every dated post in the range, whatever its status. */
  posts: SignalPost[];
  /** Tasks whose due date falls in the range, under a live client and a live project. */
  tasks: Task[];
  signal: CalendarSignalState;
}

/** One day's worth of the calendar, with the two kinds still apart. */
export interface CalendarDay {
  date: string;
  posts: SignalPost[];
  tasks: Task[];
}

/**
 * Groups a range into the days that actually carry something, in date order.
 *
 * Empty days are dropped rather than rendered blank: an agenda answers "what is happening and
 * when", and a month of empty rows buries the answer. A range with nothing in it produces an
 * empty array, which the caller shows as an empty state.
 */
export function calendarDays(range: Pick<CalendarRange, 'posts' | 'tasks'>): CalendarDay[] {
  const days = new Map<string, CalendarDay>();
  const dayFor = (date: string) => {
    const existing = days.get(date);
    if (existing) return existing;
    const created: CalendarDay = { date, posts: [], tasks: [] };
    days.set(date, created);
    return created;
  };

  for (const post of range.posts) {
    // Unscheduled posts have no date and belong to no day. The provider does not return them;
    // this guard means a caller that hands over a queue anyway cannot invent a cell for one.
    if (post.date) dayFor(post.date).posts.push(post);
  }
  for (const task of range.tasks) {
    if (task.dueDate) dayFor(task.dueDate).tasks.push(task);
  }

  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** How many things a range holds, counted by kind rather than as one total. */
export const calendarCounts = (range: Pick<CalendarRange, 'posts' | 'tasks'>) => ({
  posts: range.posts.length,
  tasks: range.tasks.length,
});
