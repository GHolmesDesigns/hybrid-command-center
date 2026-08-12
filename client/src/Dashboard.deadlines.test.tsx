import {
  fireEvent,
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  type DashboardData,
  day,
  emptyDashboard,
  task,
  testState,
} from './App.test-setup';

describe('Dashboard deadlines panel', () => {
  const overdueTask = task('t-late', 'Late artwork', { overdue: true, dueDate: day(-3) });
  const todayTask = task('t-today', 'Ship the newsletter', { dueDate: day(0) });
  const weekTask = task('t-week', 'Draft the recap', { dueDate: day(3) });

  const renderDashboard = async (payload: Partial<DashboardData>) => {
    testState.dashboardPayload = { ...emptyDashboard, ...payload };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    return (await screen.findByText('Deadlines')).closest('section')!;
  };
  const bucketButton = (name: RegExp) => screen.getByRole('button', { name });

  it('shows each deadline state, its list, and its own empty state', async () => {
    // Today's task is in both buckets, which is what "Next 7 days" including today means.
    const panel = await renderDashboard({
      counts: {
        ...emptyDashboard.counts,
        overdue: 1,
        projectsOverdue: 1,
        dueToday: 1,
        dueNextSevenDays: 2,
      },
      overdueTasks: [overdueTask],
      dueTodayTasks: [todayTask],
      upcomingTasks: [todayTask, weekTask],
    });

    // Overdue leads, because it is the state that already cost something.
    expect(panel).toHaveTextContent('1 overdue task');
    expect(panel).toHaveTextContent('Late artwork');
    expect(panel).not.toHaveTextContent('Draft the recap');

    fireEvent.click(bucketButton(/^Due today 1$/));
    expect(panel).toHaveTextContent('1 task due today');
    expect(panel).toHaveTextContent('Ship the newsletter');
    expect(panel).not.toHaveTextContent('Late artwork');

    fireEvent.click(bucketButton(/^Next 7 days 2$/));
    expect(panel).toHaveTextContent('2 tasks due in the next 7 days');
    expect(panel).toHaveTextContent('Ship the newsletter');
    expect(panel).toHaveTextContent('Draft the recap');
  });

  it('gives each empty bucket a message of its own', async () => {
    const panel = await renderDashboard({});

    expect(panel).toHaveTextContent('Nothing overdue');

    fireEvent.click(bucketButton(/^Due today 0$/));
    expect(panel).toHaveTextContent('Nothing due today');
    expect(panel).not.toHaveTextContent('Nothing overdue');

    fireEvent.click(bucketButton(/^Next 7 days 0$/));
    expect(panel).toHaveTextContent('A clear week ahead');
    expect(panel).not.toHaveTextContent('Nothing due today');
  });

  it('sends the Open board button to the bucket on screen', async () => {
    testState.tasksPayload = [weekTask];
    await renderDashboard({
      counts: { ...emptyDashboard.counts, dueNextSevenDays: 1 },
      upcomingTasks: [weekTask],
    });

    fireEvent.click(bucketButton(/^Next 7 days 1$/));
    fireEvent.click(screen.getByRole('button', { name: /open board/i }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(screen.getByText('Draft the recap')).toBeVisible();
  });

  it('marks the selected state for assistive tech, not by color alone', async () => {
    await renderDashboard({});

    expect(bucketButton(/^Overdue 0$/)).toHaveAttribute('aria-pressed', 'true');
    expect(bucketButton(/^Due today 0$/)).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(bucketButton(/^Due today 0$/));
    expect(bucketButton(/^Overdue 0$/)).toHaveAttribute('aria-pressed', 'false');
    expect(bucketButton(/^Due today 0$/)).toHaveAttribute('aria-pressed', 'true');
  });
});
