import {
  render,
  screen,
  waitFor,
  fireEvent,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  it,
  vi,
  App,
  requests,
  testState,
} from './App.test-setup';

describe('Settings MCP health panel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs the connection test and shows the last-tested timestamp', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    testState.mcpHealthPanelPayload = {
      enabled: true,
      state: 'never_connected',
      stateReason: null,
      generatedAt: '2026-08-28T12:00:00.000Z',
      agents: [],
      errorSummary: [],
      staleHandoffs: [],
      recentCompletions: [],
      auditEventCount: 0,
    };

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Connection health' })).toBeVisible();
    expect(await screen.findByText(/No agent has connected yet/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    expect(await screen.findByText('Diagnostic passed')).toBeVisible();
    expect(screen.getByText(/Last tested:/)).toBeVisible();
    expect(
      requests.some(
        (request) => request.method === 'POST' && request.url.endsWith('/api/mcp/health/test'),
      ),
    ).toBe(true);
    await waitFor(() => expect(screen.getByText(/Capability version:/)).toBeVisible());
  });

  it('shows recent classified and legacy handoff results', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    testState.mcpHealthPanelPayload = {
      enabled: true,
      state: 'healthy',
      stateReason: null,
      generatedAt: '2026-08-28T12:00:00.000Z',
      agents: [],
      errorSummary: [],
      staleHandoffs: [],
      auditEventCount: 2,
      recentCompletions: [
        {
          id: 'done-1',
          outcome: 'SUCCEEDED',
          resultSummary: 'Draft PR opened.',
          completedAt: '2026-08-28T11:00:00.000Z',
        },
        {
          id: 'done-old',
          outcome: null,
          resultSummary: null,
          completedAt: '2026-08-28T10:00:00.000Z',
        },
      ],
    };
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Recent handoff results' })).toBeVisible();
    expect(screen.getByText('SUCCEEDED').closest('li')).toHaveTextContent('Draft PR opened.');
    expect(screen.getByText('Legacy completion').closest('li')).toHaveTextContent(
      'No recorded evidence',
    );
  });
});
