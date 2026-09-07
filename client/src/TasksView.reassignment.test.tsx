import { render, screen, fireEvent, describe, expect, it, task } from './App.test-setup';
import { TasksView } from './components/TasksView';

describe('TasksView task reassignment', () => {
  it('stops a running session instead of relabeling it when its task leaves the active list', () => {
    const running = task('running-task', 'Draft the proposal');
    const other = task('other-task', 'Review contracts');

    const { rerender } = render(<TasksView tasks={[running, other]} />);

    fireEvent.click(screen.getByText('Draft the proposal'));
    expect(screen.getByText('Working on Draft the proposal')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();

    // The running task is completed elsewhere (or deleted, or reassigned) and drops out of
    // the active list while its session is still running.
    rerender(<TasksView tasks={[{ ...running, status: 'COMPLETE' }, other]} />);

    // The session must stop, not silently continue relabeled under whichever task fills in.
    expect(screen.getByRole('button', { name: /^Start/ })).toBeVisible();
    expect(screen.getByText('25:00')).toBeVisible();
    expect(screen.queryByText('Working on Draft the proposal')).toBeNull();
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
