import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { OperatorTimer } from './components/OperatorTimer';
import type {
  OperatorTimer as TimerSnapshot,
  Project,
  Task,
  TimeCategory,
  TimeEntry,
} from '../../shared/types';

const mocks = vi.hoisted(() => ({ api: vi.fn(), send: vi.fn() }));
vi.mock('./api', () => ({ api: mocks.api, send: mocks.send }));

const project = { id: 'project-1', name: 'Project alpha', status: 'ACTIVE' } as Project;
const task = { id: 'task-1', projectId: project.id, title: 'Write proposal' } as Task;
const category: TimeCategory = {
  id: 'category-1',
  name: 'Client work',
  position: 0,
  isDefault: true,
  selectable: true,
};
const ready: TimerSnapshot = {
  state: 'READY',
  accumulatedSeconds: 0,
  elapsedSeconds: 0,
  serverTime: '2026-11-08T12:00:00.000Z',
  revision: 0,
};
const running: TimerSnapshot = {
  ...ready,
  state: 'RUNNING',
  timerId: 'timer-1',
  projectId: project.id,
  projectName: project.name,
  taskId: task.id,
  taskTitle: task.title,
  categoryId: category.id,
  categoryName: category.name,
  startedAt: '2026-11-08T11:00:00.000Z',
  runningSince: '2026-11-08T11:00:00.000Z',
  elapsedSeconds: 28_801,
  revision: 1,
};
const paused: TimerSnapshot = { ...running, state: 'PAUSED', runningSince: undefined, revision: 2 };
const saved: TimeEntry = {
  id: 'entry-1',
  projectId: project.id,
  projectName: project.name,
  taskId: task.id,
  taskTitle: task.title,
  categoryId: category.id,
  categoryName: category.name,
  startedAt: running.startedAt!,
  endedAt: running.serverTime,
  durationSeconds: 120,
  notes: 'Timer entry',
  createdAt: running.serverTime,
  updatedAt: running.serverTime,
  revision: 1,
};

describe('OperatorTimer', () => {
  beforeEach(() => {
    mocks.api.mockReset();
    mocks.send.mockReset();
    mocks.api.mockImplementation((path: string) =>
      path === '/operator-timer' ? Promise.resolve(ready) : Promise.resolve([category]),
    );
    mocks.send.mockResolvedValue(ready);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with a project and category, lists matching tasks, and confirms discard in the page', async () => {
    mocks.send
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(ready);
    render(<OperatorTimer projects={[project]} tasks={[task]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Work timer' }));
    const panel = screen.getByRole('region', { name: 'Work timer' });
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Project' }), {
      target: { value: project.id },
    });
    expect(await within(panel).findByRole('option', { name: category.name })).toBeVisible();
    fireEvent.change(within(panel).getByRole('combobox', { name: 'Task (optional)' }), {
      target: { value: task.id },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Start timer' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith('/operator-timer/start', 'POST', {
        projectId: project.id,
        categoryId: category.id,
        taskId: task.id,
        revision: 0,
      }),
    );
    expect(await within(panel).findByText('Running')).toBeVisible();
    expect(
      await within(panel).findByText(
        'This timer has run for over eight hours. It will keep running.',
      ),
    ).toBeVisible();
    fireEvent.click(within(panel).getByRole('button', { name: 'Pause' }));
    expect(await within(panel).findByRole('button', { name: 'Resume' })).toBeVisible();
    fireEvent.click(within(panel).getByRole('button', { name: 'Discard…' }));
    expect(within(panel).getByRole('button', { name: 'Confirm discard' })).toBeVisible();
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm discard' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenLastCalledWith('/operator-timer/discard', 'POST', {
        timerId: 'timer-1',
        revision: 2,
      }),
    );
  });

  it('saves the timer entry and restores the tab title after returning to Ready', async () => {
    const title = document.title;
    mocks.api.mockResolvedValueOnce(running).mockResolvedValueOnce(ready);
    mocks.send.mockResolvedValue(saved);
    render(<OperatorTimer projects={[project]} tasks={[task]} />);
    fireEvent.click(await screen.findByRole('button', { name: /Running/ }));
    const panel = screen.getByRole('region', { name: 'Work timer' });
    expect(document.title).toMatch(/HCC/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop and save' }));
    await waitFor(() =>
      expect(mocks.send).toHaveBeenCalledWith('/operator-timer/stop', 'POST', {
        timerId: 'timer-1',
        revision: 1,
      }),
    );
    await waitFor(() => expect(document.title).toBe(title));
  });

  it('shows elapsed seconds in the global timer summary and detail clock', async () => {
    mocks.api.mockResolvedValueOnce({
      ...running,
      elapsedSeconds: 10,
      serverTime: new Date().toISOString(),
    });
    render(<OperatorTimer projects={[project]} tasks={[task]} />);
    const trigger = await screen.findByRole('button', { name: /Running/ });
    expect(trigger).toHaveTextContent('00:00:10');
    fireEvent.click(trigger);
    expect(screen.getByLabelText('Elapsed work time')).toHaveTextContent('00:00:10');
  });

  it('refreshes after a transition error and reports the server message', async () => {
    mocks.api.mockImplementation((path: string) =>
      path === '/operator-timer' ? Promise.resolve(running) : Promise.resolve([category]),
    );
    mocks.send.mockRejectedValue(new Error('Timer changed elsewhere.'));
    render(<OperatorTimer projects={[project]} tasks={[task]} />);
    fireEvent.click(await screen.findByRole('button', { name: /Running/ }));
    const panel = screen.getByRole('region', { name: 'Work timer' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Pause' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('Timer changed elsewhere.');
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/operator-timer'));
  });
});
