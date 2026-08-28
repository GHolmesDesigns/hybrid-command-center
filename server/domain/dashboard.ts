import type { Db } from '../db.ts';
import { listActiveTasks, listClients, listProjects } from '../repositories.ts';
import { isDueNextSevenDays, isDueToday, isOverdue } from '../../shared/deadlines.ts';
import {
  compareProjectActivity,
  type Client,
  type DashboardData,
  type Priority,
  type Project,
  type Task,
} from '../../shared/types.ts';

function urgent(tasks: Task[]) {
  const rank: Record<Priority, number> = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return tasks.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      (a.dueDate || '9999').localeCompare(b.dueDate || '9999') ||
      rank[a.priority] - rank[b.priority],
  );
}

/** Today's dashboard payload: active-scope counts, deadline buckets, and recent projects. */
export function buildDashboardSummary(db: Db, now: Date = new Date()): DashboardData {
  // Active scope only: tasks under an archived project or an archived client are still
  // reachable everywhere else, but they are not work that needs attention now, so they
  // belong in none of these counts or lists.
  const tasks = listActiveTasks(db);
  const projects = listProjects(db) as Project[];
  // Each bucket filters COMPLETE out for itself, so a task that is finished cannot reach
  // a list through one of them.
  const overdue = tasks.filter((t) => isOverdue(t, now));
  const dueToday = tasks.filter((t) => isDueToday(t, now));
  // Includes today: a task due in the next few hours is the most urgent thing in the
  // window, not something the window has already passed. `dueToday` is a subset of it.
  const dueNextSevenDays = tasks.filter((t) => isDueNextSevenDays(t, now));
  return {
    counts: {
      activeClients: (listClients(db) as Client[]).filter((c) => c.status === 'ACTIVE').length,
      activeProjects: projects.filter((p) => p.status === 'ACTIVE').length,
      dueToday: dueToday.length,
      dueNextSevenDays: dueNextSevenDays.length,
      overdue: overdue.length,
      projectsOverdue: new Set(overdue.map((t) => t.projectId)).size,
    },
    overdueTasks: urgent(overdue),
    dueTodayTasks: urgent(dueToday),
    upcomingTasks: urgent(dueNextSevenDays),
    // Ordered by activity, not by `updatedAt`: the panel is asking where work is
    // happening, and renaming a project is not work on it. The comparator is shared with
    // the Projects page so the two views cannot put the same projects in a different order.
    recentProjects: projects.slice().sort(compareProjectActivity).slice(0, 5),
  };
}
