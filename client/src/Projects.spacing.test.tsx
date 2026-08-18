import {
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type Category,
  project,
  task,
  testState,
} from './App.test-setup';

/**
 * A project tile spaces its blocks with one gap on the column rather than a margin on each
 * block, so the category list can appear, disappear, or wrap without changing the distance to
 * the progress bar and the actions below it. jsdom has no layout engine and the stylesheet is
 * never loaded here, so the gap itself is `e2e/project-spacing.spec.ts`'s to measure.
 *
 * What this file guards is the structure that one gap rests on, and the half a browser cannot
 * check for free: that every block is a direct child of the tile — a block nested inside
 * another is outside the column's reach and back to spacing itself — and that the list of
 * children changes only by the category list appearing, whatever the description, the category
 * count, or the task count.
 */
describe('the project tile layout', () => {
  const retainer: Category = { id: 'cat-retainer', name: 'Retainer' };
  /** Six of them, which is what wraps a tile's list onto a second and third line. */
  const six: Category[] = [
    'Retainer',
    'Campaign',
    'Internal',
    'Brand system',
    'Paid social',
    'Content calendar',
  ].map((name, index) => ({ id: `cat-${index}`, name }));
  const LONG_DESCRIPTION =
    'A long description that runs past a single line in a tile three to a row, so the block above the categories is taller here than on the tile beside it.';

  const renderProjects = async () => {
    render(
      <MemoryRouter initialEntries={['/projects']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  };
  const tile = (name: string) =>
    screen
      .getByRole('heading', { level: 2, name })
      .closest('article.project-tile') as HTMLElement | null;
  /** The tile's own blocks, named by what they are, in the order they are laid out in. */
  const blocksIn = (root: HTMLElement) =>
    Array.from(root.children).map((child) =>
      child.tagName === 'A' ? 'link' : child.className.split(' ')[0],
    );

  it('lays every block out as a direct child of the tile', async () => {
    testState.projectsPayload = [project('p-labelled', 'Labelled', 'ACTIVE', { categories: six })];
    await renderProjects();

    const labelled = tile('Labelled')!;
    expect(labelled).not.toBeNull();
    expect(blocksIn(labelled)).toEqual([
      'project-card-head',
      'link',
      'tag-list',
      'progress',
      'project-meta',
      'card-actions',
      'keyboard-move',
    ]);
    // The category list in particular: nested inside the link or the progress block it would
    // be out of the column's reach, and its own margins would be back to deciding the gap.
    expect(labelled.querySelector('.tag-list')!.parentElement).toBe(labelled);
  });

  it('changes its blocks only by the category list, at zero, one, and six categories', async () => {
    testState.projectsPayload = [
      project('p-none', 'No categories'),
      project('p-one', 'One category', 'ACTIVE', { categories: [retainer] }),
      project('p-six', 'Six categories', 'ACTIVE', { categories: six }),
    ];
    await renderProjects();

    const withList = blocksIn(tile('Six categories')!);
    expect(blocksIn(tile('One category')!)).toEqual(withList);
    // One block fewer, and the rest in the same order: nothing takes the list's place and
    // nothing moves to cover for it, which is what leaves the column's gap to do the spacing.
    expect(blocksIn(tile('No categories')!)).toEqual(withList.filter((b) => b !== 'tag-list'));
    expect(tile('No categories')!.querySelector('.tag-list')).toBeNull();
  });

  it('keeps the same blocks for a short description and a long one', async () => {
    testState.projectsPayload = [
      project('p-short', 'Short copy', 'ACTIVE', { description: 'Short.', categories: six }),
      project('p-long', 'Long copy', 'ACTIVE', {
        description: LONG_DESCRIPTION,
        categories: six,
      }),
      project('p-empty', 'No copy', 'ACTIVE', { categories: six }),
    ];
    await renderProjects();

    // A taller description block makes the tile taller and nothing else. The gap below the
    // categories is the column's either way, and no block reads a height to place itself.
    for (const name of ['Short copy', 'Long copy', 'No copy'])
      expect(blocksIn(tile(name)!)).toEqual([
        'project-card-head',
        'link',
        'tag-list',
        'progress',
        'project-meta',
        'card-actions',
        'keyboard-move',
      ]);
    expect(tile('No copy')!.querySelector('p')!.textContent).toBe('No project description yet.');
  });

  it('keeps the same blocks with no tasks and with a full task count', async () => {
    testState.projectsPayload = [
      project('p-idle', 'No tasks', 'ACTIVE', { categories: six }),
      project('p-busy', 'Every task done', 'ACTIVE', { categories: six }),
    ];
    testState.tasksPayload = Array.from({ length: 4 }, (_, index) =>
      task(`t${index}`, `Task ${index + 1}`, { projectId: 'p-busy', status: 'COMPLETE' }),
    );
    await renderProjects();

    expect(blocksIn(tile('No tasks')!)).toEqual(blocksIn(tile('Every task done')!));
    // The progress block is there and reads as a count in both states, rather than being one
    // of the blocks that comes and goes.
    expect(tile('No tasks')!.querySelector('.progress')!.textContent).toContain('0/0');
    expect(tile('Every task done')!.querySelector('.progress')!.textContent).toContain('4/4');
  });
});
