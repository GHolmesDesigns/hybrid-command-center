import {
  fireEvent,
  render,
  screen,
  waitFor,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type Task,
  task,
  testState,
} from './App.test-setup';

describe('Task type on the board', () => {
  const renderBoard = async (tasks: Task[]) => {
    testState.tasksPayload = tasks;
    render(
      <MemoryRouter initialEntries={['/kanban']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  };

  it('shows the type on the card and again in the task detail', async () => {
    await renderBoard([task('t1', 'Recap post', { taskType: 'QA_BRAND_PASS' })]);

    expect(screen.getByText('QA / Brand Pass')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /^Recap post/ }));

    await waitFor(() => expect(screen.getAllByText('QA / Brand Pass').length).toBe(2));
  });

  it('renders an untyped task with no badge at all', async () => {
    await renderBoard([task('t1', 'Legacy chore')]);

    expect(screen.getByRole('button', { name: /^Legacy chore/ })).toBeVisible();
    expect(document.querySelector('.task-type-badge')).toBeNull();
    // The priority badge beside it still renders, so the row itself is not missing.
    expect(document.querySelector('.priority-badge')).not.toBeNull();
  });
});
