import type { Db } from './db.ts';

export type WorkspaceTimeFilters = {
  from?: string;
  to?: string;
  projectId?: string;
  taskId?: string;
  categoryId?: string;
  timeZone: string;
};

function dayInZone(value: string, timeZone: string): string {
  const parts = new Map(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(value))
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

function mapEntry(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    projectName: row.project_name as string,
    ...(row.task_id ? { taskId: row.task_id as string, taskTitle: row.task_title as string } : {}),
    categoryId: row.category_id as string,
    categoryName: row.category_name as string,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string,
    durationSeconds: row.duration_seconds as number,
    notes: row.notes as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revision: row.revision as number,
  };
}

export function listWorkspaceTimeEntries(db: Db) {
  const rows = db
    .prepare(
      `SELECT e.id,e.project_id,e.task_id,e.category_id,e.started_at,e.ended_at,
              e.duration_seconds,e.notes,e.created_at,e.updated_at,e.revision,
              p.name project_name,t.title task_title,c.name category_name
       FROM time_entries e JOIN projects p ON p.id=e.project_id
       LEFT JOIN tasks t ON t.id=e.task_id JOIN time_categories c ON c.id=e.category_id
       ORDER BY e.started_at DESC,e.id`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapEntry);
}

export function filterWorkspaceTimeEntries(
  entries: ReturnType<typeof listWorkspaceTimeEntries>,
  filters: WorkspaceTimeFilters,
) {
  return entries.filter((entry) => {
    const day = dayInZone(entry.startedAt, filters.timeZone);
    return (
      (!filters.from || day >= filters.from) &&
      (!filters.to || day <= filters.to) &&
      (!filters.projectId || entry.projectId === filters.projectId) &&
      (!filters.taskId || entry.taskId === filters.taskId) &&
      (!filters.categoryId || entry.categoryId === filters.categoryId)
    );
  });
}

export function workspaceTimeOptions(db: Db) {
  return {
    projects: db
      .prepare(
        `SELECT DISTINCT p.id,p.name,p.status FROM projects p JOIN time_entries e ON e.project_id=p.id
         ORDER BY p.name COLLATE NOCASE,p.id`,
      )
      .all() as { id: string; name: string; status: string }[],
    tasks: db
      .prepare(
        `SELECT DISTINCT t.id,t.title,t.status,t.project_id projectId FROM tasks t
         JOIN time_entries e ON e.task_id=t.id ORDER BY t.title COLLATE NOCASE,t.id`,
      )
      .all() as { id: string; title: string; status: string; projectId: string }[],
    categories: db
      .prepare(
        `SELECT DISTINCT c.id,c.name,(c.archived_at IS NOT NULL) archived FROM time_categories c
         JOIN time_entries e ON e.category_id=c.id ORDER BY c.name COLLATE NOCASE,c.id`,
      )
      .all() as { id: string; name: string; archived: number }[],
  };
}

export function workspaceTimeDashboard(db: Db, now = new Date(), timeZone = 'UTC') {
  const day = dayInZone(now.toISOString(), timeZone);
  const [year, month, date] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  const monday = new Date(Date.UTC(year, month - 1, date - ((weekday + 6) % 7)));
  const sunday = new Date(Date.UTC(year, month - 1, date + (7 - ((weekday + 6) % 7))));
  const from = monday.toISOString().slice(0, 10);
  const to = sunday.toISOString().slice(0, 10);
  const weekEntries = listWorkspaceTimeEntries(db).filter((entry) => {
    const entryDay = dayInZone(entry.startedAt, timeZone);
    return entryDay >= from && entryDay <= to;
  });
  const overBudgetTasks = db
    .prepare(
      `SELECT COUNT(*) count FROM (
         SELECT t.id,t.time_budget_minutes,SUM(e.duration_seconds) logged_seconds
         FROM tasks t JOIN projects p ON p.id=t.project_id JOIN clients c ON c.id=p.client_id
         JOIN time_entries e ON e.task_id=t.id
         WHERE p.status<>'ARCHIVED' AND c.status<>'ARCHIVED' AND t.status<>'COMPLETE'
         GROUP BY t.id HAVING t.time_budget_minutes>0
           AND SUM(e.duration_seconds)>t.time_budget_minutes*60
       )`,
    )
    .get() as { count: number };
  return {
    loggedSeconds: weekEntries.reduce((total, entry) => total + entry.durationSeconds, 0),
    overBudgetTasks: Number(overBudgetTasks.count),
  };
}
