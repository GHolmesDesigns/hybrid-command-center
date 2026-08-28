import {
  render,
  screen,
  waitFor,
  within,
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
  task,
} from './App.test-setup';
import type { AgentHandoff, AgentHandoffDetail } from '../../shared/agent-coordination';

const openHandoff = (overrides: Partial<AgentHandoff> = {}): AgentHandoff => ({
  id: 'handoff-1',
  createdAt: '2026-08-26T12:00:00.000Z',
  updatedAt: '2026-08-26T12:00:00.000Z',
  fromAgentLabel: 'cursor',
  toAgentLabel: 'claude',
  subjectType: 'task',
  subjectId: 't1',
  message: 'Please finish the caption review.',
  state: 'OPEN',
  claimedBy: null,
  claimedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancelReason: null,
  clientRequestId: null,
  ...overrides,
});

describe('Settings Agent handoffs card', () => {
  afterEach(() => vi.restoreAllMocks());

  const openSettings = async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { level: 2, name: 'Agent handoffs' })).toBeVisible();
  };

  it('lists open handoffs, opens detail, and cancels with a reason', async () => {
    const row = openHandoff();
    const detail: AgentHandoffDetail = { ...row, notes: [] };
    testState.tasksPayload = [task('t1', 'Caption review')];
    testState.agentHandoffsPayload = [row];
    testState.agentHandoffDetailPayload = detail;

    await openSettings();
    await waitFor(() =>
      expect(requests.some((request) => request.url.endsWith('/api/agent-handoffs'))).toBe(true),
    );

    const card = screen
      .getByRole('heading', { level: 2, name: 'Agent handoffs' })
      .closest('.settings-card') as HTMLElement;
    expect(card).toHaveTextContent('Please finish the caption review.');
    expect(card.querySelector('a')?.getAttribute('href')).toBe('/status?project=p1');

    fireEvent.click(screen.getByRole('button', { name: /cursor/i }));
    expect(await screen.findByRole('region', { name: 'Handoff detail' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Cancel reason'), {
      target: { value: 'Operator closed it.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel handoff' }));

    await waitFor(() =>
      expect(
        requests.some(
          (request) =>
            request.method === 'POST' &&
            request.url.endsWith(`/api/agent-handoffs/${row.id}/cancel`) &&
            request.body?.reason === 'Operator closed it.',
        ),
      ).toBe(true),
    );
    await waitFor(() => {
      const openGroup = within(card)
        .getByRole('heading', { name: /Open/ })
        .closest('.handoff-group')!;
      expect(openGroup).not.toHaveTextContent('Please finish the caption review.');
    });
    expect(
      within(card)
        .getByRole('heading', { name: /Cancelled \(7d\)/ })
        .closest('.handoff-group'),
    ).toHaveTextContent('Please finish the caption review.');
  });

  it('shows an error state when the list cannot be loaded', async () => {
    testState.agentHandoffsError = 'Coordination store is offline.';
    await openSettings();
    expect(await screen.findByText('Handoffs unavailable')).toBeVisible();
    expect(screen.getByText('Coordination store is offline.')).toBeVisible();
  });

  it('shows classified completion evidence and preserves legacy completed rows', async () => {
    const completed = openHandoff({
      id: 'completed-1',
      state: 'COMPLETED',
      claimedBy: 'claude',
      claimedAt: '2026-08-26T12:30:00.000Z',
      completedAt: new Date().toISOString(),
      outcome: 'SUPERSEDED',
      resultSummary: 'Replaced by the workbook retry.',
      changedPaths: ['server/import.ts'],
      references: ['PR #410'],
      validations: [{ command: 'npm test', outcome: 'passed' }],
      remainingRisks: ['Owner import remains.'],
    });
    const legacy = openHandoff({
      id: 'completed-legacy',
      state: 'COMPLETED',
      completedAt: new Date().toISOString(),
    });
    testState.agentHandoffsPayload = [completed, legacy];
    testState.agentHandoffDetailPayload = { ...completed, notes: [] };

    await openSettings();
    expect(await screen.findByText('SUPERSEDED')).toBeVisible();
    expect(await screen.findByText('Legacy completion')).toBeVisible();
    fireEvent.click(screen.getByText('SUPERSEDED').closest('button')!);
    const detail = await screen.findByRole('region', { name: 'Handoff detail' });
    expect(detail).toHaveTextContent('Replaced by the workbook retry.');
    expect(detail).toHaveTextContent('server/import.ts');
    expect(detail).toHaveTextContent('PR #410');
    expect(detail).toHaveTextContent('npm test');
    expect(detail).toHaveTextContent('Owner import remains.');
  });
});
