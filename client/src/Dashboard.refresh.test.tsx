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
  emptyDashboard,
  testState,
} from './App.test-setup';

describe('Dashboard refresh status', () => {
  const refreshIndicator = () => document.querySelector('.refresh-status') as HTMLElement;

  it('states when dashboard data was fetched and announces the indicator', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Last refreshed just now');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });

  it('keeps stale data visible after failure and clears the error after retry succeeds', async () => {
    testState.dashboardPayload = {
      ...emptyDashboard,
      counts: { ...emptyDashboard.counts, activeProjects: 3 },
    };
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: 'Active projects: 3' })).toBeVisible();
    testState.dashboardFailures = 1;
    const syncButton = screen.getByRole('button', { name: /sync to folder/i });
    syncButton.focus();
    fireEvent.click(syncButton);

    await waitFor(() =>
      expect(refreshIndicator()).toHaveTextContent('Refresh failed. Showing data from just now.'),
    );
    const failedStatus = refreshIndicator();
    expect(failedStatus).toHaveTextContent('Dashboard refresh is temporarily unavailable.');
    expect(screen.getByRole('link', { name: 'Active projects: 3' })).toBeVisible();
    expect(syncButton).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(refreshIndicator()).toHaveTextContent('Last refreshed just now'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Active projects: 3' })).toBeVisible();
  });

  it('offers retry when the first dashboard fetch fails', async () => {
    testState.dashboardFailures = 1;
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Dashboard unavailable')).toBeVisible();
    expect(refreshIndicator()).toHaveTextContent('Refresh failed. Dashboard data is unavailable.');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('link', { name: 'Active projects: 0' })).toBeVisible();
    expect(refreshIndicator()).toHaveTextContent('Last refreshed just now');
  });
});
