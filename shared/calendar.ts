import { signalDaysInMonth, type SignalPost } from './signal.ts';
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

/** The three agenda spans exposed by the Calendar page and its `view` URL parameter. */
export const CALENDAR_VIEWS = ['today', 'week', 'month'] as const;
export type CalendarViewMode = (typeof CALENDAR_VIEWS)[number];

export interface CalendarViewRange {
  /** Inclusive local-date labels. No instant or timezone conversion is involved. */
  from: string;
  to: string;
}

const dateParts = (date: string) =>
  date.split('-').map(Number) as [year: number, month: number, day: number];

const dateLabel = (date: Date) =>
  `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;

/**
 * Adds whole calendar days to a local-date label.
 *
 * UTC is used only as a Gregorian arithmetic surface after the local parts have been extracted;
 * the result is still a date label, never an instant shown to a user.
 */
const addCalendarDays = (date: string, amount: number) => {
  const [year, month, day] = dateParts(date);
  return dateLabel(new Date(Date.UTC(year, month - 1, day + amount)));
};

/** Returns inclusive bounds for an agenda view. Weeks run Monday through Sunday. */
export function calendarViewRange(view: CalendarViewMode, anchor: string): CalendarViewRange {
  if (view === 'today') return { from: anchor, to: anchor };
  if (view === 'month') {
    const [year, month] = dateParts(anchor);
    const from = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
    return {
      from,
      to: `${from.slice(0, 8)}${String(signalDaysInMonth(year, month)).padStart(2, '0')}`,
    };
  }

  const [year, month, day] = dateParts(anchor);
  const sundayFirstDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const from = addCalendarDays(anchor, -((sundayFirstDay + 6) % 7));
  return { from, to: addCalendarDays(from, 6) };
}

/** Moves an agenda by one of its own spans while preserving a useful anchor date. */
export function shiftCalendarAnchor(
  view: CalendarViewMode,
  anchor: string,
  direction: -1 | 1,
): string {
  if (view === 'today') return addCalendarDays(anchor, direction);
  if (view === 'week') return addCalendarDays(anchor, direction * 7);

  const [year, month, day] = dateParts(anchor);
  const target = new Date(Date.UTC(year, month - 1 + direction, 1));
  const targetMonth = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return dateLabel(target);
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
