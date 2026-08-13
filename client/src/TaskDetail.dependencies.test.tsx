import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  project,
  task,
  testState,
  requests,
} from './App.test-setup';

describe('Dependency picker', () => {
  /** The open task, one dependency it already has, and four candidates in two projects. */
  const board = [
    task('t3', 'write the brief', { projectId: 'p-zephyr', projectName: 'zephyr audit' }),
    task('t1', 'Recap post', { dependencyIds: ['t2'] }),
    task('t4', 'Audit the fonts', { projectId: 'p-acme', projectName: 'Acme rebrand' }),
    task('t2', 'Shoot the b-roll'),
    task('t6', 'Ship it', { projectId: 'p-zephyr', projectName: 'zephyr audit' }),
    task('t5', 'brief the writer', { projectId: 'p-acme', projectName: 'Acme rebrand' }),
  ];
  /**
   * Declared rather than left to the shared fixture, because ModalHost hides tasks whose
   * project is archived or belongs to an archived client. Every project here is active, so
   * what the picker shows is down to this suite's own ordering.
   */
  const activeProjects = [
    project('p1', 'Site refresh'),
    project('p-acme', 'Acme rebrand'),
    project('p-zephyr', 'zephyr audit'),
  ];

  const openRecapPost = async () => {
    testState.tasksPayload = board;
    testState.projectsPayload = activeProjects;
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Recap post/ }));
    expect(await screen.findByRole('heading', { name: 'Task details' })).toBeVisible();
  };
  const picker = () =>
    within(screen.getByRole('dialog')).getByLabelText('Dependency task') as HTMLSelectElement;
  const groupLabels = () => [...picker().querySelectorAll('optgroup')].map((group) => group.label);
  /** Every option after the placeholder, in render order, under the group it belongs to. */
  const options = () =>
    [...picker().options]
      .slice(1)
      .map((option) => `${option.closest('optgroup')?.label} — ${option.text}`);

  it('groups candidates by project and orders both levels case-insensitively', async () => {
    await openRecapPost();

    const headings = within(screen.getByRole('dialog'))
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.at(-1)).toBe('Dependencies');

    // The API answers in board order — status, then column position — so any alphabetical
    // order here is the client's doing.
    expect(groupLabels()).toEqual(['Acme rebrand', 'zephyr audit']);
    expect(options()).toEqual([
      'Acme rebrand — Audit the fonts',
      'Acme rebrand — brief the writer',
      'zephyr audit — Ship it',
      'zephyr audit — write the brief',
    ]);
    expect(picker().options[0].value).toBe('');
    expect(picker().options[0].text).toBe('Choose a task…');
  });

  it('leaves out the task itself and the dependencies it already has', async () => {
    await openRecapPost();

    expect(options().join()).not.toContain('Recap post');
    expect(options().join()).not.toContain('Shoot the b-roll');
    // The one it already waits on is listed above the picker, with a way to remove it.
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove Shoot the b-roll' }),
    ).toBeVisible();
  });

  it('posts the chosen task id, which the group labels do not change', async () => {
    await openRecapPost();

    fireEvent.change(picker(), { target: { value: 't5' } });
    // Scoped to the picker's own form: the checklist above it has an Add button too.
    fireEvent.click(within(picker().closest('form')!).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(requests.some((r) => r.url.endsWith('/api/tasks/t1/dependencies'))).toBe(true),
    );
    const posted = requests.find((r) => r.url.endsWith('/api/tasks/t1/dependencies'));
    expect(posted?.method).toBe('POST');
    expect(posted?.body).toEqual({ dependencyId: 't5' });
  });
});
