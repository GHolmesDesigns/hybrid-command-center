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
import { MemoryRouter } from 'react-router-dom';
import { WORK_SECONDS } from '../../shared/task-timer';

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

class FakeNotification {
  static permission: 'default' | 'granted' | 'denied' = 'default';
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  static instances: Array<{ title: string; body?: string }> = [];
  constructor(title: string, options?: { body?: string }) {
    FakeNotification.instances.push({ title, body: options?.body });
  }
}

const renderTasks = (tasks = [task('t1', 'Draft the proposal')]) =>
  render(
    <MemoryRouter>
      <TasksView tasks={tasks} />
    </MemoryRouter>,
  );

describe('TasksView timer notifications and tab ownership', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeBroadcastChannel.channels.clear();
    FakeNotification.instances = [];
    FakeNotification.permission = 'default';
  });

  it('requests notification permission the first time the timer starts', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'default';
    renderTasks();

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();
  });

  it('does not re-request permission once granted', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    renderTasks();

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it('notifies when a work session completes', () => {
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('Notification', FakeNotification);
    FakeNotification.permission = 'granted';
    renderTasks();

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    act(() => {
      vi.advanceTimersByTime(WORK_SECONDS * 1000 + 1_000);
    });

    expect(FakeNotification.instances).toEqual([
      { title: 'Pomodoro complete', body: 'Focus session complete. Time for a short break.' },
    ]);
  });

  it('defers to another tab that already claimed the running timer', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('Notification', FakeNotification);
    renderTasks();

    // A second tab announces it owns the running session.
    const otherTab = new FakeBroadcastChannel('hcc-task-timer');
    act(() => {
      otherTab.postMessage({ type: 'claim', id: 'other-tab' });
    });

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    // This tab is not the owner, so Start is a no-op: still showing Start, not Pause.
    expect(screen.getByRole('button', { name: /^Start/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /^Pause/ })).toBeNull();
  });

  it('regains ownership once the other tab releases it', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('Notification', FakeNotification);
    renderTasks();

    const otherTab = new FakeBroadcastChannel('hcc-task-timer');
    act(() => {
      otherTab.postMessage({ type: 'claim', id: 'other-tab' });
    });
    act(() => {
      otherTab.postMessage({ type: 'release', id: 'other-tab' });
    });

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));

    expect(screen.getByRole('button', { name: /^Pause/ })).toBeVisible();
  });

  it('confirms before switching away from a running task, and respects a decline', () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('Notification', FakeNotification);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderTasks([task('t1', 'Draft the proposal'), task('t2', 'Review contracts')]);

    fireEvent.click(screen.getByText('Draft the proposal'));
    fireEvent.click(screen.getByRole('button', { name: /^Start/ }));
    fireEvent.click(screen.getByText('Review contracts'));

    expect(confirmSpy).toHaveBeenCalledWith('Stop the current timer and switch tasks?');
    expect(screen.getByText('Working on Draft the proposal')).toBeVisible();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByText('Review contracts'));
    expect(screen.getByText('Working on Review contracts')).toBeVisible();
  });
});
