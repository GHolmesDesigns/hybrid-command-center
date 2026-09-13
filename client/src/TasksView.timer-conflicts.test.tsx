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
  projects,
  client,
} from './App.test-setup';
import { TasksView } from './components/TasksView';
import { MemoryRouter } from 'react-router-dom';
import {
  newTaskTimerSession,
  startTaskTimer,
  TASK_TIMER_REPLACE_CONFIRM,
  TASK_TIMER_RESET_CONFIRM,
  TASK_TIMER_STORAGE_KEY,
  WORK_SECONDS,
} from '../../shared/task-timer';

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<(event: { data: unknown }) => void>();
  constructor(public name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }
  addEventListener(_type: 'message', listener: (event: { data: unknown }) => void) {
    this.listeners.add(listener);
  }
  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? [])
      if (peer !== this) for (const listener of peer.listeners) listener({ data });
  }
  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

const tasks = [task('t1', 'Draft the proposal'), task('t2', 'Review contracts')];

const renderTasks = (route = '/tasks') =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <TasksView tasks={tasks} projects={projects} clients={[client('client-p1', 'Acme')]} />
    </MemoryRouter>,
  );

describe('TasksView timer session conflicts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeBroadcastChannel.channels.clear();
  });

  it('shows the selected task idle clock while another task is timed', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    window.localStorage.setItem(
      TASK_TIMER_STORAGE_KEY,
      JSON.stringify(startTaskTimer(newTaskTimerSession('t1'), Date.now())),
    );
    renderTasks('/tasks?task=t2');

    expect(screen.getByText('25:00')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      /Timer running on Draft the proposal — \d{2}:\d{2} remaining/,
    );
    expect(screen.getByText('Working on Review contracts')).toBeVisible();
    window.localStorage.removeItem(TASK_TIMER_STORAGE_KEY);
  });

  it('confirms before Start replaces another task session and respects cancel', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    window.localStorage.setItem(
      TASK_TIMER_STORAGE_KEY,
      JSON.stringify(startTaskTimer(newTaskTimerSession('t1'), Date.now())),
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTasks('/tasks?task=t2');

    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    expect(confirmSpy).toHaveBeenCalledWith(TASK_TIMER_REPLACE_CONFIRM);
    expect(screen.getByRole('button', { name: /^Start/ })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/Timer running on Draft the proposal/);
    window.localStorage.removeItem(TASK_TIMER_STORAGE_KEY);
  });

  it('confirms before Reset replaces another task session', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    window.localStorage.setItem(
      TASK_TIMER_STORAGE_KEY,
      JSON.stringify(startTaskTimer(newTaskTimerSession('t1'), Date.now())),
    );
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTasks('/tasks?task=t2');

    fireEvent.click(screen.getByRole('button', { name: /^Reset/ }));

    expect(confirmSpy).toHaveBeenCalledWith(TASK_TIMER_REPLACE_CONFIRM);
    expect(screen.getByRole('status')).toHaveTextContent(/Timer running on Draft the proposal/);
    window.localStorage.removeItem(TASK_TIMER_STORAGE_KEY);
  });

  it('confirms before re-selecting the timed task resets its clock', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTasks();

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    fireEvent.click(screen.getByText('Draft the proposal'));

    expect(confirmSpy).toHaveBeenCalledWith(TASK_TIMER_RESET_CONFIRM);
    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();
  });

  it('confirms before switching away from a paused session', () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTasks();

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    fireEvent.click(screen.getByRole('button', { name: /^Pause/ }));
    fireEvent.click(screen.getByText('Review contracts'));

    expect(confirmSpy).toHaveBeenCalledWith('Stop the current timer and switch tasks?');
    expect(screen.getByText('Working on Draft the proposal')).toBeVisible();
    vi.useRealTimers();
  });

  it('does not confirm when the selected task already has a fresh idle session', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderTasks();

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        `${Math.floor(WORK_SECONDS / 60)
          .toString()
          .padStart(2, '0')}:00`,
      ),
    ).toBeVisible();
  });
});
