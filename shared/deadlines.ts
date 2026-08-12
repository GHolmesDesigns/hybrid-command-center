import { addDays, format, parseISO } from 'date-fns';

/**
 * One definition of every deadline bucket, imported by both the API and the UI.
 *
 * It lives in `shared/` rather than `server/domain/` because the browser needs the same
 * answers the server gives — the board's `?filter=` and the dashboard's counts were two
 * implementations of these rules, and they disagreed about whether today counts and about
 * whether finished work counts. Keeping deadline arithmetic out of React components is a
 * rule in `AGENTS.md`; this module is where it goes instead.
 *
 * Every function takes the whole task rather than a bare due date, so a caller cannot
 * forget the status half of the rule, and takes an injectable `now` so the boundaries can
 * be tested at a fixed clock.
 */
export interface DeadlineTask {
  dueDate?: string | null;
  status?: string;
}

/** Local calendar day as `yyyy-MM-dd`, the comparison `AGENTS.md` asks for. */
const localDay = (value: Date) => format(value, 'yyyy-MM-dd');
/**
 * The local day a due date falls on. Due dates are stored as `yyyy-MM-dd` and interpreted
 * in local time; parsing and re-formatting also pins a full ISO timestamp to its local day,
 * so neither shape can drift across a timezone or a DST boundary.
 */
const dueDay = (dueDate: string) => localDay(parseISO(dueDate));

/**
 * A finished task has no deadline left to watch, so it belongs to no bucket. This is the
 * half of the rule the client's old `dueWithinDays` left out.
 */
const isOpen = (task: DeadlineTask) => task.status !== 'COMPLETE';

/** Due on a day before today. */
export function isOverdue(task: DeadlineTask, now: Date = new Date()) {
  if (!task.dueDate || !isOpen(task)) return false;
  return dueDay(task.dueDate) < localDay(now);
}

/** Due on today's local calendar day. */
export function isDueToday(task: DeadlineTask, now: Date = new Date()) {
  if (!task.dueDate || !isOpen(task)) return false;
  return dueDay(task.dueDate) === localDay(now);
}

/**
 * Due between today and `days` days from now, both ends inclusive. Today counts: a task due
 * in the next few hours is the most urgent thing in the window, not something that window
 * has already passed.
 */
export function isDueWithinDays(task: DeadlineTask, days: number, now: Date = new Date()) {
  if (!task.dueDate || !isOpen(task)) return false;
  const due = dueDay(task.dueDate);
  return due >= localDay(now) && due <= localDay(addDays(now, days));
}

/** The "Next 7 days" bucket, today included. */
export function isDueNextSevenDays(task: DeadlineTask, now: Date = new Date()) {
  return isDueWithinDays(task, 7, now);
}
