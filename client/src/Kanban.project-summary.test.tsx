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
  client,
  project,
  task,
  testState,
  requests,
} from './App.test-setup';

const campaign = { id: 'cat-campaign', name: 'Campaign' };

function renderBoard(entry: string) {
  testState.clientsPayload = [client('c1', 'Acme')];
  testState.projectsPayload = [
    project('p1', 'Autumn launch', 'BUILDING', {
      clientId: 'c1',
      clientName: 'Acme',
      description: 'Launch the autumn collection.',
      startDate: '2026-09-01',
      launchDate: '2026-10-01',
      priority: 'HIGH',
      categories: [campaign],
      notes: 'Private planning notes',
    }),
    project('p2', 'Winter launch', 'PLANNING', { clientId: 'c1', clientName: 'Acme' }),
  ];
  testState.tasksPayload = [
    task('t1', 'Fix homepage', { projectId: 'p1', overdue: true }),
    task('t2', 'Plan catalog', { projectId: 'p2', overdue: true }),
  ];
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  return screen.findByRole('heading', { level: 1, name: 'Project Status' });
}

describe('focused project summary on Status', () => {
  it('shows the selected project facts, status icon, categories, and actions outside the page head', async () => {
    await renderBoard('/status?project=p1');

    const summary = screen.getByRole('region', { name: 'Project summary' });
    expect(summary.previousElementSibling).toHaveClass('page-head');
    expect(summary.nextElementSibling).toHaveClass('board-filters');
    expect(within(summary).getByText('Launch the autumn collection.')).toBeVisible();
    expect(within(summary).queryByText('Private planning notes')).toBeNull();
    expect(within(summary).getByText('Sep 1, 2026')).toBeVisible();
    expect(within(summary).getByText('Oct 1, 2026')).toBeVisible();
    expect(within(summary).getByText('Not set')).toBeVisible();
    expect(within(summary).getByText('HIGH')).toBeVisible();
    expect(within(summary).getByText('1 overdue')).toBeVisible();
    const chip = summary.querySelector('.status-label')!;
    expect(chip).toHaveTextContent('Building');
    expect(chip.querySelector('svg')).toBeTruthy();
    expect(chip).toHaveAttribute('data-status', 'BUILDING');
    expect(
      within(summary).getByRole('list', { name: 'Categories on Autumn launch' }),
    ).toHaveTextContent('Campaign');
    expect(within(summary).getByRole('link', { name: 'Open project' })).toHaveAttribute(
      'href',
      '/projects/p1',
    );
    expect(within(summary).getByRole('button', { name: 'Edit project' })).toBeVisible();
    expect(document.querySelector('.page-head')).toHaveTextContent('1 visible tasks');
  });

  it('hides the summary when the project filter is cleared or selects multiple projects', async () => {
    await renderBoard('/status');
    expect(screen.queryByRole('region', { name: 'Project summary' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Autumn launch' }));
    expect(screen.getByRole('region', { name: 'Project summary' })).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Winter launch' }));
    expect(screen.queryByRole('region', { name: 'Project summary' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.queryByRole('region', { name: 'Project summary' })).toBeNull();
  });

  it('does not show a summary for an unknown project ID', async () => {
    await renderBoard('/status?project=missing');
    expect(screen.queryByRole('region', { name: 'Project summary' })).toBeNull();
    expect(document.querySelector('.page-head')).toHaveTextContent('0 visible tasks');
  });

  it('uses the detail-page description fallback and opens the same shared summary there', async () => {
    await renderBoard('/status?project=p2');
    const summary = screen.getByRole('region', { name: 'Project summary' });
    expect(
      within(summary).getByText('Project tasks, launch plan, deadline, and Drive workspace.'),
    ).toBeVisible();
    expect(within(summary).getAllByText('Not set')).toHaveLength(3);
    fireEvent.click(within(summary).getByRole('link', { name: 'Open project' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Winter launch' })).toBeVisible();
    expect(document.querySelector('.project-overview .project-summary')).toHaveTextContent(
      'Planning',
    );
    expect(document.querySelector('.project-overview .status-label svg')).toBeTruthy();
  });

  it('refreshes the focused summary after saving in the existing project modal', async () => {
    await renderBoard('/status?project=p1');
    fireEvent.click(screen.getByRole('button', { name: 'Edit project' }));
    expect(await screen.findByRole('heading', { name: 'Edit project' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: 'Revised launch plan.' },
    });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ACTIVE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Project summary' })).toHaveTextContent(
        'Revised launch plan.',
      ),
    );
    const summary = screen.getByRole('region', { name: 'Project summary' });
    expect(summary.querySelector('.status-label')).toHaveTextContent('Active');
    expect(summary.querySelector('.status-label svg')).toBeTruthy();
    expect(
      requests.some(
        (request) => request.method === 'PATCH' && request.url.endsWith('/api/projects/p1'),
      ),
    ).toBe(true);
    expect(document.querySelector('.page-head')).toHaveTextContent('1 visible tasks');
  });
});
