import {
  fireEvent,
  render,
  screen,
  MemoryRouter,
  describe,
  expect,
  it,
  requests,
  testState,
} from './App.test-setup';
import { act } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { WorkspaceTimeView } from './components/WorkspaceTimeView';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TimeEntry } from '../../shared/types';

function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <output aria-label="Current query">{location.search}</output>
      <button onClick={() => navigate(-1)}>Back</button>
      <button onClick={() => navigate(1)}>Forward</button>
    </>
  );
}

const entry: TimeEntry = {
  id: 'entry-1',
  projectId: 'project-1',
  projectName: 'Studio',
  taskId: 'task-1',
  taskTitle: 'Research',
  categoryId: 'category-1',
  categoryName: 'Design',
  startedAt: '2026-11-08T05:30:00.000Z',
  endedAt: '2026-11-08T06:30:00.000Z',
  durationSeconds: 3600,
  notes: 'Draft review',
  createdAt: '2026-11-08T06:30:00.000Z',
  updatedAt: '2026-11-08T06:30:00.000Z',
  revision: 1,
};

describe('Workspace time report', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a running timer advancing by seconds without writing timer or entry data', async () => {
    const serverTime = '2026-11-08T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(serverTime));
    testState.operatorTimerPayload = {
      state: 'RUNNING',
      timerId: 'timer-1',
      elapsedSeconds: 10,
      accumulatedSeconds: 10,
      runningSince: serverTime,
      serverTime,
      revision: 3,
    };
    testState.workspaceTimePayload.entries = [entry];
    const snapshot = { ...testState.operatorTimerPayload };
    render(
      <MemoryRouter initialEntries={['/time?from=2026-11-02&to=2026-11-08']}>
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Elapsed work time')).toHaveTextContent('00:00:10');
    expect(screen.getByText('Running')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByLabelText('Elapsed work time')).toHaveTextContent('00:00:11');
    expect(screen.getByText('Draft review')).toBeVisible();
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(testState.operatorTimerPayload).toEqual(snapshot);
  });

  it('holds a paused timer steady and keeps the ready state clear', async () => {
    const serverTime = '2026-11-08T12:00:00.000Z';
    vi.useFakeTimers();
    vi.setSystemTime(new Date(serverTime));
    testState.operatorTimerPayload = {
      state: 'PAUSED',
      timerId: 'timer-1',
      elapsedSeconds: 95,
      accumulatedSeconds: 95,
      serverTime,
      revision: 4,
    };
    render(
      <MemoryRouter initialEntries={['/time']}>
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByLabelText('Elapsed work time')).toHaveTextContent('00:01:35');
    expect(screen.getByText('Paused')).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(screen.getByLabelText('Elapsed work time')).toHaveTextContent('00:01:35');
  });

  it('shows a ready timer as zero elapsed', async () => {
    render(
      <MemoryRouter initialEntries={['/time']}>
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    await screen.findByText('Ready');
    expect(screen.getByLabelText('Elapsed work time')).toHaveTextContent('00:00:00');
  });

  it('shows timer failure while leaving the saved-entry report usable', async () => {
    testState.workspaceTimePayload.entries = [entry];
    testState.operatorTimerError = 'Timer service is unavailable.';
    render(
      <MemoryRouter initialEntries={['/time?from=2026-11-02&to=2026-11-08']}>
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(/Timer unavailable: Timer service is unavailable/),
    ).toBeVisible();
    expect(screen.getByText('Draft review')).toBeVisible();
    expect(screen.getByRole('button', { name: /Export CSV/ })).toBeEnabled();
  });

  it('keeps filters in browser history and restores the prior selection', async () => {
    testState.workspaceTimePayload.entries = [entry];
    render(
      <MemoryRouter initialEntries={['/time?from=2026-11-02&to=2026-11-08&project=project-1']}>
        <HistoryControls />
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    await screen.findByText('Draft review');
    expect(screen.getByLabelText('Project')).toHaveValue('project-1');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'category-1' } });
    expect(await screen.findByLabelText('Current query')).toHaveTextContent('category=category-1');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen
      .findByLabelText('Current query')
      .then((query) => expect(query).not.toHaveTextContent('category=category-1'));
    expect(screen.getByLabelText('Category')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(await screen.findByLabelText('Category')).toHaveValue('category-1');
  });

  it('shows an empty state without a zero total when no entries match', async () => {
    render(
      <MemoryRouter initialEntries={['/time?from=2026-12-01&to=2026-12-07']}>
        <WorkspaceTimeView />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No matching time')).toBeVisible();
    expect(screen.getByText('No entries in this range')).toBeVisible();
  });
});
