import type { Db } from '../db.ts';

export function wouldCreateCycle(db: Db, taskId: string, dependencyId: string) {
  if (taskId === dependencyId) return true;
  const visited = new Set<string>();
  const stack = [dependencyId];
  const stmt = db.prepare(
    'SELECT dependency_id AS dependencyId FROM task_dependencies WHERE task_id = ?',
  );
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const row of stmt.all(current) as { dependencyId: string }[]) stack.push(row.dependencyId);
  }
  return false;
}

export function blockingDependencies(db: Db, taskId: string) {
  return db
    .prepare(
      `SELECT t.id, t.title FROM task_dependencies d JOIN tasks t ON t.id=d.dependency_id
    WHERE d.task_id=? AND t.status <> 'COMPLETE' ORDER BY t.title`,
    )
    .all(taskId) as { id: string; title: string }[];
}
