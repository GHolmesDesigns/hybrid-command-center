import { act } from '@testing-library/react';
import {
  render,
  screen,
  fireEvent,
  describe,
  expect,
  it,
  vi,
  afterEach,
  task,
} from './App.test-setup';
import { TasksView } from './components/TasksView';

describe('TasksView task reassignment', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops a running session, preserves its elapsed time, and requires a manual restart when its task leaves the active list', () => {
    vi.useFakeTimers();
    const running = task('running-task', 'Draft the proposal');
    const other = task('other-task', 'Review contracts');

    const { rerender } = render(<TasksView tasks={[running, other]} />);

    fireEvent.click(screen.getByText('Draft the proposal'));
    expect(screen.getByText('Working on Draft the proposal')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('24:50')).toBeVisible();

    // The running task is completed elsewhere (or deleted, or reassigned) and drops out of
    // the active list while its session is still running.
    rerender(<TasksView tasks={[{ ...running, status: 'COMPLETE' }, other]} />);

    // The session must stop, preserve the elapsed time, and not auto-continue under a
    // different task — the operator must choose one explicitly to resume.
    expect(screen.getByRole('button', { name: /^Start/ })).toBeDisabled();
    expect(screen.getByText('24:50')).toBeVisible();
    expect(screen.getByText('Select a task to begin')).toBeVisible();
    expect(screen.queryByText('Working on Draft the proposal')).toBeNull();

    // Choosing a task explicitly is still possible afterward.
    fireEvent.click(screen.getByText('Review contracts'));
    expect(screen.getByText('Working on Review contracts')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Start/ })).toBeEnabled();
  });

  it('leaves a running session alone while its task stays in the active list', () => {
    const running = task('running-task', 'Draft the proposal');
    const other = task('other-task', 'Review contracts');

    const { rerender } = render(<TasksView tasks={[running, other]} />);

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();

    // An unrelated list refresh (e.g. a new task added elsewhere) must not disturb the session.
    rerender(<TasksView tasks={[running, other, task('new-task', 'Plan kickoff')]} />);

    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();
    expect(screen.getByText('Working on Draft the proposal')).toBeVisible();
  });
});
