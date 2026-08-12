import {
  fireEvent,
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  day,
  emptyDashboard,
  task,
  testState,
} from './App.test-setup';

describe('Dashboard stat tiles', () => {
  const counts = {
    activeClients: 4,
    activeProjects: 7,
    dueToday: 2,
    dueNextSevenDays: 5,
    overdue: 0,
    projectsOverdue: 0,
  };

  const renderDashboard = async () => {
    testState.dashboardPayload = { ...emptyDashboard, counts };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Deadlines')).toBeVisible();
  };

  it('sends every tile to the view that shows the rows behind its number', async () => {
    await renderDashboard();

    // The accessible name carries the label and the figure, so a screen reader announces
    // "Due today: 2" rather than a bare "2".
    const destinations: [string, string][] = [
      ['Active clients: 4', '/clients'],
      ['Active projects: 7', '/projects'],
      ['Due today: 2', '/kanban?filter=today'],
      ['Next 7 days: 5', '/kanban?filter=week'],
    ];
    for (const [name, href] of destinations) {
      expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
    }
  });

  it('navigates on click, and is a real anchor so Enter and Tab work', async () => {
    testState.tasksPayload = [task('tile-week', 'Recap draft', { dueDate: day(3) })];
    await renderDashboard();
    const tile = screen.getByRole('link', { name: 'Next 7 days: 5' });

    // An <a href> rather than a click handler: the browser supplies keyboard activation,
    // tab order, and open-in-new-tab, none of which a div can be given back reliably.
    expect(tile.tagName).toBe('A');
    expect(tile).not.toHaveAttribute('tabindex');

    fireEvent.click(tile);

    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(screen.getByText('Recap draft')).toBeVisible();
  });

  it('counts the same rows its destination lists', async () => {
    // Two due today, five within the week, one outside it and one already finished.
    testState.tasksPayload = [
      task('n-1', 'Newsletter goes out', { dueDate: day(0) }),
      task('n-2', 'Invoices out', { dueDate: day(0) }),
      task('n-3', 'Recap draft', { dueDate: day(2) }),
      task('n-4', 'Storyboard review', { dueDate: day(5) }),
      task('n-5', 'Shot list', { dueDate: day(7) }),
      task('n-6', 'Retro deck', { dueDate: day(8) }),
      task('n-7', 'Signed off already', { dueDate: day(1), status: 'COMPLETE' }),
    ];
    await renderDashboard();

    fireEvent.click(screen.getByRole('link', { name: 'Next 7 days: 5' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(document.querySelectorAll('.kanban-card')).toHaveLength(counts.dueNextSevenDays);

    fireEvent.click(screen.getByRole('link', { name: 'Dashboard' }));
    fireEvent.click(await screen.findByRole('link', { name: 'Due today: 2' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Project Status' })).toBeVisible();
    expect(document.querySelectorAll('.kanban-card')).toHaveLength(counts.dueToday);
  });
});
