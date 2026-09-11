import { AgentSchedulesCard } from './components/AgentSchedulesCard';
import {
  describe,
  expect,
  it,
  render,
  screen,
  waitFor,
  fireEvent,
  requests,
  testState,
} from './App.test-setup';

const schedule = {
  id: 'schedule-1',
  createdAt: '2026-09-11T11:00:00.000Z',
  updatedAt: '2026-09-11T11:00:00.000Z',
  ownerAgentLabel: 'cursor',
  cronExpression: '0 9 * * 1',
  nextRunAt: '2026-09-14T09:00:00.000Z',
  toAgentLabel: 'claude',
  subjectType: 'freeform' as const,
  subjectId: null,
  messageTemplate: 'Review the draft.',
  dedupeKey: 'weekly-review',
  paused: false,
  failurePolicy: 'RETRY' as const,
  lastRunStatus: null,
  lastRunAt: null,
  lastRunWindow: null,
  lastHandoffId: null,
  lastError: null,
};

describe('scheduled agent runs card', () => {
  it('shows the next run and lets the operator pause and run now', async () => {
    testState.agentSchedulesPayload = [schedule];
    render(<AgentSchedulesCard flash={() => undefined} />);
    expect(await screen.findByText('Review the draft.')).toBeVisible();
    expect(screen.getByText(/Next run:/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(screen.getByText('Paused')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(screen.getByText(/Last outcome: SUCCEEDED/)).toBeVisible());
    expect(
      requests.some((entry) => entry.url.endsWith('/api/agent-schedules/schedule-1/run-now')),
    ).toBe(true);
  });

  it('shows an unavailable state without hiding the schedule form', async () => {
    testState.agentSchedulesError = 'Schedules unavailable.';
    render(<AgentSchedulesCard flash={() => undefined} />);
    expect(await screen.findByText('Schedules unavailable.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create schedule' })).toBeVisible();
  });

  it('creates a schedule and supports the manual due-run action', async () => {
    render(<AgentSchedulesCard flash={() => undefined} />);
    await screen.findByText('No schedules yet');
    fireEvent.change(screen.getByLabelText('Owner agent'), { target: { value: 'cursor' } });
    fireEvent.change(screen.getByLabelText('Message skeleton'), {
      target: { value: 'Run review.' },
    });
    fireEvent.change(screen.getByLabelText('Dedupe key'), { target: { value: 'daily-review' } });
    fireEvent.change(screen.getByLabelText('First / next run'), {
      target: { value: '2026-09-12T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create schedule' }));
    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith('/api/agent-schedules'))).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run due schedules' }));
    await waitFor(() =>
      expect(requests.some((entry) => entry.url.endsWith('/api/agent-schedules/run-due'))).toBe(
        true,
      ),
    );
  });
});
