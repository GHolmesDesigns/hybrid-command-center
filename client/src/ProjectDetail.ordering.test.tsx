import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  beforeEach,
  describe,
  expect,
  it,
  App,
  type Task,
  project,
  task,
  testState,
  requests,
} from './App.test-setup';

/**
 * C42. The project page lists every task the project has, across statuses, so the two things
 * a flat list got wrong are what these cases hold: the stages read in workflow order rather
 * than alphabetically, and a row can be moved within its stage without a pointer.
 */
describe('Project page task ordering', () => {
  const at = (id: string, title: string, status: Task['status'], position: number, extra = {}) =>
    task(id, title, { projectId: 'p1', projectName: 'Site refresh', status, position, ...extra });

  beforeEach(() => {
    testState.projectsPayload = [project('p1', 'Site refresh')];
  });

  const renderProject = async () => {
    render(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Site refresh' })).toBeVisible();
  };
  const stageHeadings = () =>
    screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent?.replace(/\d+$/, ''));
  const rowTitles = () =>
    screen
      .getAllByRole('button', { name: /^Drag / })
      .map((grip) => grip.getAttribute('aria-label'));

  it('groups the tasks by stage in workflow order, not alphabetically', async () => {
    testState.tasksPayload = [
      at('t-complete', 'Ship it', 'COMPLETE', 0),
      at('t-todo', 'Write brief', 'TODO', 0),
      at('t-review', 'Approve copy', 'REVIEW', 0),
      at('t-backlog', 'Someday idea', 'BACKLOG', 0),
      at('t-progress', 'Draft layout', 'IN_PROGRESS', 0),
    ];
    await renderProject();

    expect(stageHeadings()).toEqual(['Backlog', 'To Do', 'In Progress', 'Review', 'Complete']);
    // Alphabetically Complete would sit second and To Do last.
    expect(rowTitles()).toEqual([
      'Drag Someday idea',
      'Drag Write brief',
      'Drag Draft layout',
      'Drag Approve copy',
      'Drag Ship it',
    ]);
  });

  it('shows a stage only when the project has work in it', async () => {
    testState.tasksPayload = [at('t-todo', 'Write brief', 'TODO', 0)];
    await renderProject();

    expect(stageHeadings()).toEqual(['To Do']);
  });

  it('reorders a row from the keyboard and sends the whole column back', async () => {
    testState.tasksPayload = [
      at('t-one', 'First', 'TODO', 0),
      at('t-two', 'Second', 'TODO', 1),
      at('t-three', 'Third', 'TODO', 2),
    ];
    await renderProject();

    fireEvent.change(screen.getByLabelText('Position of Third'), { target: { value: '1' } });

    await waitFor(() => expect(rowTitles()).toEqual(['Drag Third', 'Drag First', 'Drag Second']));
    const reorder = requests.find((r) => r.url.endsWith('/api/tasks/reorder'));
    expect(reorder?.method).toBe('POST');
    expect(reorder?.body).toMatchObject({
      taskId: 't-three',
      status: 'TODO',
      orderedIds: ['t-three', 't-one', 't-two'],
    });
    expect(await screen.findByText('Reordered in To Do.')).toBeVisible();
  });

  it('rewrites the whole column, so tasks other projects own keep their places', async () => {
    testState.projectsPayload = [project('p1', 'Site refresh'), project('p2', 'Brand system')];
    testState.tasksPayload = [
      task('theirs-first', 'Their earliest', {
        projectId: 'p2',
        projectName: 'Brand system',
        status: 'TODO',
        position: 0,
      }),
      at('mine-first', 'My earliest', 'TODO', 1),
      at('mine-second', 'My latest', 'TODO', 2),
      task('theirs-last', 'Their latest', {
        projectId: 'p2',
        projectName: 'Brand system',
        status: 'TODO',
        position: 3,
      }),
    ];
    await renderProject();

    // Only this project's two rows are on screen, and only they are offered as positions.
    expect(rowTitles()).toEqual(['Drag My earliest', 'Drag My latest']);
    fireEvent.change(screen.getByLabelText('Position of My latest'), { target: { value: '1' } });

    await waitFor(() => expect(rowTitles()).toEqual(['Drag My latest', 'Drag My earliest']));
    const reorder = requests.find((r) => r.url.endsWith('/api/tasks/reorder'));
    // The hidden tasks are still in the order they were, around the one that moved.
    expect(reorder?.body.orderedIds).toEqual([
      'theirs-first',
      'mine-second',
      'mine-first',
      'theirs-last',
    ]);
  });

  it('keeps the new order after the page is left and returned to', async () => {
    testState.tasksPayload = [at('t-one', 'First', 'TODO', 0), at('t-two', 'Second', 'TODO', 1)];
    await renderProject();

    fireEvent.change(screen.getByLabelText('Position of Second'), { target: { value: '1' } });
    await waitFor(() => expect(rowTitles()).toEqual(['Drag Second', 'Drag First']));

    // Everything the reload would read is what the server answered with, not component state.
    expect(testState.tasksPayload.map((t) => [t.id, t.position])).toEqual([
      ['t-one', 1],
      ['t-two', 0],
    ]);
  });

  it('opens the task from the row while the grip carries the drag', async () => {
    testState.tasksPayload = [at('t-one', 'First', 'TODO', 0)];
    await renderProject();

    expect(screen.getByRole('button', { name: 'Drag First' })).toHaveAttribute(
      'aria-roledescription',
      'sortable',
    );
    const row = screen.getByRole('button', { name: 'Drag First' }).closest('.task-row')!;
    fireEvent.click(within(row as HTMLElement).getByText('First'));

    expect(await screen.findByRole('heading', { level: 3, name: 'First' })).toBeVisible();
  });

  it('puts the rows back and reports the reason when the write is refused', async () => {
    testState.tasksPayload = [at('t-one', 'First', 'TODO', 0), at('t-two', 'Second', 'TODO', 1)];
    await renderProject();
    testState.taskReorderError = 'This task is blocked by incomplete dependencies.';

    fireEvent.change(screen.getByLabelText('Position of Second'), { target: { value: '1' } });

    expect(
      await screen.findByText('This task is blocked by incomplete dependencies.'),
    ).toBeVisible();
    expect(rowTitles()).toEqual(['Drag First', 'Drag Second']);
  });
});
