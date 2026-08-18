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
 * Project Detail opens with one column — what the project is, its categories, what can be done
 * to it, and the note about deleting — spaced by one gap on the column rather than a margin on
 * each block. The categories used to carry a top margin and nothing below, so the actions sat
 * flush against the chips; with no categories the gap was the summary's bottom margin instead,
 * a different number in the same place.
 *
 * A distance is a measurement and only a browser has one, so `e2e/project-spacing.spec.ts`
 * checks the pixels. Here: that all four blocks are direct children of the overview, in one
 * order, and that the only thing a project's own content changes is whether the category list
 * is among them.
 */
describe('the Project Detail overview', () => {
  const retainer: Category = { id: 'cat-retainer', name: 'Retainer' };
  /** Six of them, which is what wraps the list onto a second line at page width. */
  const six: Category[] = [
    'Retainer',
    'Campaign',
    'Internal',
    'Brand system',
    'Paid social',
    'Content calendar',
  ].map((name, index) => ({ id: `cat-${index}`, name }));
  /** The column, in order, for a project that carries categories. */
  const COLUMN = ['project-summary', 'tag-list', 'detail-actions', 'field-hint'];
  const LONG_DESCRIPTION =
    'A description long enough to wrap the page head onto a second and a third line, which is the block directly above the overview.';

  const renderDetail = async (categories: Category[], overrides: object = {}) => {
    testState.projectsPayload = [
      project('p-detail', 'Site refresh', 'ACTIVE', { categories, ...overrides }),
    ];
    render(
      <MemoryRouter initialEntries={['/projects/p-detail']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Site refresh' })).toBeVisible();
    return document.querySelector('.project-overview') as HTMLElement;
  };
  /** The overview's own blocks, named by what they are, in the order they are laid out in. */
  const blocksIn = (root: HTMLElement) =>
    Array.from(root.children).map((child) => child.className.split(' ')[0]);
  const fourTasks = (status: 'TODO' | 'COMPLETE') =>
    Array.from({ length: 4 }, (_, index) =>
      task(`t${index}`, `Task ${index + 1}`, { projectId: 'p-detail', status }),
    );

  it('lays the summary, categories, actions, and the delete note out as one column', async () => {
    const overview = await renderDetail(six);

    expect(overview).not.toBeNull();
    expect(blocksIn(overview)).toEqual(COLUMN);
    // The actions in particular. Nested anywhere else they would be out of the column's reach,
    // and the gap above them would be whatever the category list happened to leave — nothing.
    expect(overview.querySelector('.detail-actions')!.parentElement).toBe(overview);
    expect(overview.querySelector('.tag-list')!.parentElement).toBe(overview);
  });

  it('lays the same column out for one category', async () => {
    expect(blocksIn(await renderDetail([retainer]))).toEqual(COLUMN);
  });

  it('drops only the list when the project has no categories', async () => {
    const overview = await renderDetail([]);

    // One block fewer, and the rest in the same order: nothing takes the list's place and
    // nothing moves to cover for it, so the actions follow the summary at the distance the
    // list would have been followed at.
    expect(blocksIn(overview)).toEqual(COLUMN.filter((block) => block !== 'tag-list'));
    expect(overview.querySelector('.tag-list')).toBeNull();
  });

  it('lays the same column out under a description that wraps', async () => {
    const overview = await renderDetail(six, { description: LONG_DESCRIPTION });

    // A taller page head above the overview moves the whole column down and changes nothing
    // inside it. No block here is sized to the page or to what sits above it.
    expect(screen.getByText(LONG_DESCRIPTION)).toBeVisible();
    expect(blocksIn(overview)).toEqual(COLUMN);
  });

  it('lays the same column out with no tasks and with a full task count', async () => {
    const overview = await renderDetail(six);

    expect(blocksIn(overview)).toEqual(COLUMN);
    expect(screen.getByText('No tasks yet')).toBeVisible();
    // Task health is a figure in the summary rather than a block that comes and goes, so the
    // column is the same one whether the project has tasks or not.
    expect(overview.querySelector('.project-summary')!.textContent).toContain('0 overdue');
  });

  it('keeps the column when every stage of the task table is filled', async () => {
    testState.tasksPayload = fourTasks('COMPLETE');
    const overview = await renderDetail(six);

    expect(blocksIn(overview)).toEqual(COLUMN);
    // The task table is a panel below the overview. A project's task count reaches the column
    // above it only if something there sizes itself to the page, and nothing does.
    expect(screen.getByRole('heading', { level: 2, name: 'All project tasks' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: /Drag Task/ })).toHaveLength(4);
  });
});
