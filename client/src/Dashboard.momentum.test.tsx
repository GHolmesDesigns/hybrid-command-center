import {
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  emptyDashboard,
  project,
  testState,
} from './App.test-setup';

describe('Dashboard momentum panel', () => {
  // Midday UTC, so the rendered day is the same one either side of the date line.
  const EDITED = '2026-01-05T12:00:00.000Z';
  const WORKED = '2026-03-09T12:00:00.000Z';

  it('dates each project by its activity, not by the last edit to its record', async () => {
    testState.dashboardPayload = {
      ...emptyDashboard,
      recentProjects: [
        project('p1', 'Site refresh', 'ACTIVE', { updatedAt: EDITED, lastActivityAt: WORKED }),
      ],
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    const panel = (
      await screen.findByRole('heading', { level: 2, name: 'Recently updated' })
    ).closest('section')!;
    expect(panel).toHaveTextContent('Mar 9, 2026');
    expect(panel).not.toHaveTextContent('Jan 5, 2026');
  });
});
