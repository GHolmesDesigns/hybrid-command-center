import { describe, expect, it } from 'vitest';
import { compareTasksByProjectThenTitle, type Task } from './types.ts';

/** Only the four fields the order reads; the rest of a Task never enters the comparison. */
const task = (id: string, projectId: string, projectName: string | undefined, title: string) =>
  ({ id, projectId, projectName, title }) as Task;

/** The order the picker renders, as `project/title` pairs. */
const sorted = (tasks: Task[]) =>
  [...tasks].sort(compareTasksByProjectThenTitle).map((t) => `${t.projectName ?? ''}/${t.title}`);

describe('task picker order', () => {
  it('sorts by project, then title, ignoring case', () => {
    expect(
      sorted([
        task('t1', 'p2', 'brand system', 'Write copy'),
        task('t2', 'p1', 'Acme rebrand', 'wireframes'),
        task('t3', 'p2', 'brand system', 'audit fonts'),
        task('t4', 'p1', 'Acme rebrand', 'Brief'),
      ]),
    ).toEqual([
      'Acme rebrand/Brief',
      'Acme rebrand/wireframes',
      'brand system/audit fonts',
      'brand system/Write copy',
    ]);
  });

  it('ignores accents as well as case, so a name is never split across the alphabet', () => {
    expect(
      sorted([
        task('t1', 'p3', 'Zephyr audit', 'Ship it'),
        task('t2', 'p2', 'ácme rebrand', 'Second'),
        task('t3', 'p1', 'Acme rebrand', 'First'),
      ]),
    ).toEqual(['Acme rebrand/First', 'ácme rebrand/Second', 'Zephyr audit/Ship it']);
  });

  it('keeps two same-named projects in separate runs rather than interleaving them', () => {
    const order = [
      task('t1', 'p-globex', 'Website refresh', 'Audit'),
      task('t2', 'p-acme', 'Website refresh', 'Build'),
      task('t3', 'p-globex', 'Website refresh', 'Copy'),
      task('t4', 'p-acme', 'Website refresh', 'Design'),
    ]
      .sort(compareTasksByProjectThenTitle)
      .map((t) => t.projectId);

    expect(order).toEqual(['p-acme', 'p-acme', 'p-globex', 'p-globex']);
  });

  it('is total, so neither the input order nor a duplicate title can reshuffle it', () => {
    const tasks = [
      task('t1', 'p1', 'Acme', 'Same title'),
      task('t2', 'p1', 'Acme', 'same TITLE'),
      task('t3', 'p1', 'Acme', 'Other'),
    ];
    const forwards = [...tasks].sort(compareTasksByProjectThenTitle).map((t) => t.id);
    const backwards = [...tasks]
      .reverse()
      .sort(compareTasksByProjectThenTitle)
      .map((t) => t.id);

    expect(forwards).toEqual(['t3', 't1', 't2']);
    expect(backwards).toEqual(forwards);
  });

  it('sorts a task with no project name first rather than throwing', () => {
    expect(
      sorted([task('t1', 'p1', 'Acme', 'Brief'), task('t2', 'p0', undefined, 'Orphan')]),
    ).toEqual(['/Orphan', 'Acme/Brief']);
  });
});
