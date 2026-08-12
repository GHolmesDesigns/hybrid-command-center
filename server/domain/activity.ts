import type { Db } from '../db.ts';

/**
 * Records that work happened on a project, which is what the dashboard's Momentum
 * panel orders by. Every write to a project's children — tasks, checklists, task
 * tags, dependencies — calls this from inside its own transaction, so the child row
 * and the parent's activity land together or not at all. An import does the same for
 * every project it touches, whether it created that project or attached to one.
 *
 * It deliberately leaves `projects.updated_at` alone. That field means "the project
 * record itself was edited", every existing consumer reads it that way, and two
 * distinct questions ("when was this project last edited" and "when was work last
 * done on it") need two fields to stay answerable. Direct edits to a project stamp
 * both; rearranging tiles and background Drive provisioning stamp neither.
 *
 * Callers pass the stamp they are already writing to the child row so one request
 * produces one timestamp throughout.
 */
export function touchProjectActivity(db: Db, projectId: string, stamp: string) {
  db.prepare('UPDATE projects SET last_activity_at=? WHERE id=?').run(stamp, projectId);
}

/**
 * Records an edit to the project record itself, moving both stamps the way
 * `PATCH /api/projects/:id` does. Attaching or detaching a category is a change to how the
 * project is described — the same kind of change as renaming it — not work done inside it,
 * so it does not go through `touchProjectActivity` alone.
 */
export function touchProjectRecord(db: Db, projectId: string, stamp: string) {
  db.prepare('UPDATE projects SET updated_at=?, last_activity_at=? WHERE id=?').run(
    stamp,
    stamp,
    projectId,
  );
}
