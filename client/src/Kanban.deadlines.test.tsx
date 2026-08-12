import {
  render,
  screen,
  MemoryRouter,
  beforeEach,
  describe,
  expect,
  it,
  App,
  day,
  task,
  testState,
} from './App.test-setup';

describe('Board deadline filters', () => {
  const renderBoard = async (filter: string) => {
    render(
      <MemoryRouter initialEntries={[`/kanban?filter=${filter}`]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
  };

  // Titles avoid the words on the filter dropdown, so a match means a card, not an option.
  beforeEach(() => {
    testState.tasksPayload = [
      task('b-today', 'Newsletter goes out', { dueDate: day(0) }),
      task('b-week', 'Recap draft', { dueDate: day(3) }),
      task('b-far', 'Retro deck', { dueDate: day(8) }),
      task('b-done', 'Signed off already', { dueDate: day(0), status: 'COMPLETE' }),
      task('b-none', 'Someday idea'),
    ];
  });

  it('shows the same set the Next 7 days tile counts', async () => {
    await renderBoard('week');

    // Today counts, day 8 does not, and finished work is not pending work.
    expect(screen.getByText('Newsletter goes out')).toBeVisible();
    expect(screen.getByText('Recap draft')).toBeVisible();
    expect(screen.queryByText('Retro deck')).toBeNull();
    expect(screen.queryByText('Signed off already')).toBeNull();
    expect(screen.queryByText('Someday idea')).toBeNull();
  });

  it('narrows the today filter to today, finished work aside', async () => {
    await renderBoard('today');

    expect(screen.getByText('Newsletter goes out')).toBeVisible();
    expect(screen.queryByText('Recap draft')).toBeNull();
    expect(screen.queryByText('Signed off already')).toBeNull();
  });
});
