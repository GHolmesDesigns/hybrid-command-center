import { addDays, format } from 'date-fns';
import type { Db } from '../db.ts';
import { listActiveTasks, listClients, listProjects, listTasksPage } from '../repositories.ts';
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

/** Dashboard summary whose MCP task buckets are capped before relation hydration. */
export function buildBoundedDashboardSummary(
  db: Db,
  now: Date,
  taskLimit: number,
): DashboardData & {
  truncated?: { overdueTasks: boolean; dueTodayTasks: boolean; upcomingTasks: boolean };
} {
  const today = format(now, 'yyyy-MM-dd');
  const through = format(addDays(now, 7), 'yyyy-MM-dd');
  const active = "p.status<>'ARCHIVED' AND c.status<>'ARCHIVED'";
  const open = "t.status<>'COMPLETE'";
  const priority = `CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 3 ELSE 4 END`;
  const status = `CASE t.status WHEN 'BACKLOG' THEN 0 WHEN 'TODO' THEN 1 WHEN 'IN_PROGRESS' THEN 2 WHEN 'REVIEW' THEN 3 WHEN 'COMPLETE' THEN 4 ELSE 5 END`;
  const stable = `${status}, t.position, t.updated_at DESC`;
  const overdue = listTasksPage(
    db,
    `WHERE ${active} AND ${open} AND t.due_date < ?`,
    [today],
    taskLimit,
    0,
    `t.due_date, ${priority}, ${stable}`,
  );
  const dueToday = listTasksPage(
    db,
    `WHERE ${active} AND ${open} AND t.due_date = ?`,
    [today],
    taskLimit,
    0,
    `${priority}, ${stable}`,
  );
  const upcoming = listTasksPage(
    db,
    `WHERE ${active} AND ${open} AND t.due_date BETWEEN ? AND ?`,
    [today, through],
    taskLimit,
    0,
    `t.due_date, ${priority}, ${stable}`,
  );
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM clients WHERE status='ACTIVE') active_clients,
         (SELECT COUNT(*) FROM projects WHERE status='ACTIVE') active_projects,
         SUM(CASE WHEN ${open} AND t.due_date=? THEN 1 ELSE 0 END) due_today,
         SUM(CASE WHEN ${open} AND t.due_date BETWEEN ? AND ? THEN 1 ELSE 0 END) due_next_seven_days,
         SUM(CASE WHEN ${open} AND t.due_date<? THEN 1 ELSE 0 END) overdue,
         COUNT(DISTINCT CASE WHEN ${open} AND t.due_date<? THEN t.project_id END) projects_overdue
       FROM tasks t JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id
       WHERE ${active}`,
    )
    .get(today, today, through, today, today) as any;
  const projects = listProjects(db) as Project[];
  const truncated = {
    overdueTasks: overdue.truncated,
    dueTodayTasks: dueToday.truncated,
    upcomingTasks: upcoming.truncated,
  };
  return {
    counts: {
      activeClients: Number(counts.active_clients),
      activeProjects: Number(counts.active_projects),
      dueToday: Number(counts.due_today ?? 0),
      dueNextSevenDays: Number(counts.due_next_seven_days ?? 0),
      overdue: Number(counts.overdue ?? 0),
      projectsOverdue: Number(counts.projects_overdue ?? 0),
    },
    overdueTasks: overdue.tasks,
    dueTodayTasks: dueToday.tasks,
    upcomingTasks: upcoming.tasks,
    recentProjects: projects.slice().sort(compareProjectActivity).slice(0, 5),
    ...(Object.values(truncated).some(Boolean) ? { truncated } : {}),
  };
}
