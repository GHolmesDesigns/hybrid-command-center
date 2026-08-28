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

describe('Settings Agent credentials card', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a new secret once, lists metadata, and revokes only that credential', async () => {
    testState.mcpAgentRegistryPayload = { enabled: true, credentials: [] };
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Agent credentials' })).toBeVisible();

    fireEvent.change(screen.getByLabelText('Agent label'), {
      target: { value: 'cursor-planning' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Issue credential' }));

    expect(await screen.findByText('hcc_mcp_shown-once')).toBeVisible();
    expect(screen.getByText('cursor-planning')).toBeVisible();
    expect(screen.getByText(/Last used: Never/)).toBeVisible();
    expect(
      requests.some(
        (request) =>
          request.method === 'POST' &&
          request.url.endsWith('/api/auth/mcp-agents') &&
          request.body.label === 'cursor-planning',
      ),
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke cursor-planning' }));
    await waitFor(() => expect(screen.queryByText('cursor-planning')).not.toBeInTheDocument());
    expect(screen.getByText('No active agent credentials.')).toBeVisible();
  });
});
