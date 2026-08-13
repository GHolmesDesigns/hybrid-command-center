import type { Db } from './db.ts';
import { listTasks } from './repositories.ts';
import type { SignalProvider } from './signal/provider.ts';
import type { CalendarRange } from '../shared/calendar.ts';

/**
 * The calendar read: Signal's schedule and task due dates over one range (FR7, §8.7).
 *
 * Read-only, and composed rather than joined. The two kinds are fetched separately and handed
 * back separately, so nothing here can merge a due date into the schedule or the other way
 * round — see `shared/calendar.ts` for why that distinction is structural and not cosmetic.
 *
 * The schedule arrives through `SignalProvider` and nothing else. That interface has no write
 * method, so this module — and therefore the page it feeds — cannot reach a change to a
 * schedule. Signal stays authoritative for what is scheduled (decision §5.7).
 */

/**
 * Tasks due in a range, under a live client and a live project.
 *
 * Archived work is excluded for the same reason the dashboard excludes it: a calendar claims to
 * show what is happening, and work under an archived client is not. A direct link to such a task
 * still opens, exactly as `listActiveTasks` leaves it reachable — it just does not fill a day
 * here. Completed tasks *are* included, with their status carried through: a calendar that
 * silently dropped finished work would make a busy week look empty in hindsight.
 */
function tasksDueInRange(db: Db, from: string, to: string) {
  return listTasks(
    db,
    `WHERE t.due_date IS NOT NULL AND t.due_date >= ? AND t.due_date <= ?
       AND p.status <> 'ARCHIVED' AND c.status <> 'ARCHIVED'`,
    [from, to],
  );
}

/**
 * One range of the calendar.
 *
 * A failing schedule degrades rather than propagates: the tasks still return, and `signal`
 * carries the reason the other half is missing. That is the difference between a page that says
 * "the schedule could not be read" and a page that says nothing is scheduled — only one of those
 * is true, and only one is actionable.
 *
 * Tasks are fetched first and deliberately outside the `try`: a failure there is a local
 * database problem, which is not something to render half a page about.
 */
export async function readCalendarRange(
  db: Db,
  provider: SignalProvider,
  from: string,
  to: string,
): Promise<CalendarRange> {
  const tasks = tasksDueInRange(db, from, to);

  if (!provider.available) {
    return {
      from,
      to,
      posts: [],
      tasks,
      signal: { available: false, error: 'Signal Campaign is unavailable.', truncated: false },
    };
  }

  try {
    const range = await provider.listPosts({ from, to });
    return {
      from,
      to,
      posts: range.posts,
      tasks,
      signal: { available: true, error: null, truncated: range.truncated },
    };
  } catch (error) {
    return {
      from,
      to,
      posts: [],
      tasks,
      signal: {
        available: false,
        error: error instanceof Error ? error.message : 'The schedule could not be read.',
        truncated: false,
      },
    };
  }
}
