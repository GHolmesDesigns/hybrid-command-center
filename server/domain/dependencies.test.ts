import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { blockingDependencies, wouldCreateCycle } from './dependencies.ts';

/**
 * These rules are reached through the API in `app.test.ts`, which can only ask them the
 * questions a request can express. The traversal itself is what is worth pinning here: the
 * API refuses to store a cycle, so the only way to prove the walk survives one already in
 * the file — an older release, a hand-edited database — is to write it directly.
 */

const NOW = '2026-08-11T12:00:00.000Z';
let db: Db;

/** Tasks need a live project and client under them, and foreign keys are enforced. */
function addTask(id: string, title = id, status = 'TODO') {
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at)
     VALUES (?, 'p1', ?, ?, 'MEDIUM', ?, ?)`,
  ).run(id, title, status, NOW, NOW);
}

/** Writes the edge straight in, bypassing the API's cycle refusal. */
const addDependency = (taskId: string, dependencyId: string) =>
  db
    .prepare('INSERT INTO task_dependencies (task_id, dependency_id) VALUES (?, ?)')
    .run(taskId, dependencyId);

/** `a` waits on `b` waits on `c`… reading left to right the way the chain is described. */
const chain = (...ids: string[]) => {
  for (let i = 0; i < ids.length - 1; i++) addDependency(ids[i], ids[i + 1]);
};

beforeEach(() => {
  db = createDb(':memory:');
  db.prepare(
    `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
     VALUES ('c1', 'Acme Studio', 'acme-studio', 'ACTIVE', 'DISCONNECTED', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, priority, created_at, updated_at)
     VALUES ('p1', 'c1', 'Identity System', 'ACTIVE', 'MEDIUM', ?, ?)`,
  ).run(NOW, NOW);
});

describe('wouldCreateCycle', () => {
  it('refuses a task that waits on itself', () => {
    addTask('a');
    expect(wouldCreateCycle(db, 'a', 'a')).toBe(true);
  });

  it('allows an edge between two tasks that are not related yet', () => {
    addTask('a');
    addTask('b');
    expect(wouldCreateCycle(db, 'a', 'b')).toBe(false);
  });

  it('refuses the edge that closes a direct pair', () => {
    addTask('a');
    addTask('b');
    addDependency('b', 'a');
    expect(wouldCreateCycle(db, 'a', 'b')).toBe(true);
  });

  it('refuses an edge that closes a loop several links away', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) addTask(id);
    chain('e', 'd', 'c', 'b', 'a');
    expect(wouldCreateCycle(db, 'a', 'e')).toBe(true);
    // One link short of the loop: 'd' does not lead back to 'a' without 'e'.
    expect(wouldCreateCycle(db, 'e', 'a')).toBe(false);
  });

  it('follows every branch, not just the first one it takes', () => {
    for (const id of ['a', 'b', 'c', 'd']) addTask(id);
    // 'd' waits on both 'b' and 'c'; only the 'c' arm leads back to 'a'.
    addDependency('d', 'b');
    addDependency('d', 'c');
    addDependency('c', 'a');
    expect(wouldCreateCycle(db, 'a', 'd')).toBe(true);
  });

  it('reaches a node by two paths without walking it twice', () => {
    for (const id of ['a', 'b', 'c', 'd']) addTask(id);
    // A diamond: 'd' reaches 'a' through 'b' and through 'c'.
    addDependency('d', 'b');
    addDependency('d', 'c');
    addDependency('b', 'a');
    addDependency('c', 'a');
    expect(wouldCreateCycle(db, 'a', 'd')).toBe(true);
    expect(wouldCreateCycle(db, 'd', 'a')).toBe(false);
  });

  it('terminates on a cycle that is already stored rather than walking it forever', () => {
    for (const id of ['a', 'x', 'y']) addTask(id);
    addDependency('x', 'y');
    addDependency('y', 'x');
    // 'a' is nowhere near the loop, but the walk still crosses it.
    expect(wouldCreateCycle(db, 'a', 'x')).toBe(false);
  });

  it('ignores dependencies that belong to a different task', () => {
    for (const id of ['a', 'b', 'c']) addTask(id);
    addDependency('b', 'c');
    expect(wouldCreateCycle(db, 'a', 'b')).toBe(false);
  });
});

describe('blockingDependencies', () => {
  it('returns nothing for a task that waits on no one', () => {
    addTask('a');
    expect(blockingDependencies(db, 'a')).toEqual([]);
  });

  it('leaves out the dependencies that are already finished', () => {
    addTask('a');
    addTask('done', 'Finished work', 'COMPLETE');
    addTask('open', 'Unfinished work', 'REVIEW');
    addDependency('a', 'done');
    addDependency('a', 'open');
    expect(blockingDependencies(db, 'a')).toEqual([{ id: 'open', title: 'Unfinished work' }]);
  });

  it('reports nothing once every dependency is complete', () => {
    addTask('a');
    addTask('b', 'Groundwork', 'COMPLETE');
    addDependency('a', 'b');
    expect(blockingDependencies(db, 'a')).toEqual([]);
  });

  it('orders by title rather than by the order the edges were added', () => {
    addTask('a');
    addTask('t3', 'Copy review');
    addTask('t1', 'Art direction');
    addTask('t2', 'Budget sign-off');
    for (const id of ['t3', 't1', 't2']) addDependency('a', id);
    expect(blockingDependencies(db, 'a').map((task) => task.title)).toEqual([
      'Art direction',
      'Budget sign-off',
      'Copy review',
    ]);
  });

  it('counts only what blocks the task it was asked about', () => {
    addTask('a');
    addTask('b');
    addTask('c', 'Shared groundwork');
    addDependency('a', 'c');
    addDependency('b', 'c');
    expect(blockingDependencies(db, 'a')).toHaveLength(1);
    expect(blockingDependencies(db, 'c')).toEqual([]);
  });

  it('stops blocking as soon as the dependency is completed', () => {
    addTask('a');
    addTask('b', 'Groundwork');
    addDependency('a', 'b');
    expect(blockingDependencies(db, 'a')).toHaveLength(1);
    db.prepare("UPDATE tasks SET status='COMPLETE' WHERE id='b'").run();
    expect(blockingDependencies(db, 'a')).toEqual([]);
  });
});
