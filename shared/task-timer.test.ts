import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_TIMER_SETTINGS,
  newTaskTimerSession,
  pauseTaskTimer,
  readTaskTimer,
  readTaskTimerSettings,
  reconcileTaskTimer,
  startTaskTimer,
  TASK_TIMER_REPLACE_CONFIRM,
  TASK_TIMER_RESET_CONFIRM,
  TASK_TIMER_SETTINGS_KEY,
  TASK_TIMER_STORAGE_KEY,
  TASK_TIMER_SWITCH_CONFIRM,
  taskTimerDisplayClock,
  taskTimerIsFreshIdle,
  taskTimerPickerReselectConfirm,
  taskTimerPickerSwitchConfirm,
  taskTimerReplaceConfirm,
  taskTimerSessionIsDestroyable,
  writeTaskTimerSettings,
  WORK_SECONDS,
} from './task-timer';

function storage(value: string | null) {
  const data = new Map([[TASK_TIMER_STORAGE_KEY, value]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, next: string) => data.set(key, next),
  };
}

function settingsStorage(value: string | null) {
  const data = new Map([[TASK_TIMER_SETTINGS_KEY, value]]);
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, next: string) => data.set(key, next),
  };
}

describe('persistent task timer', () => {
  it('derives running time from the target wall-clock timestamp', () => {
    const started = startTaskTimer(newTaskTimerSession('t1'), 1_000);
    expect(reconcileTaskTimer(started, 11_001).remainingSeconds).toBe(WORK_SECONDS - 10);
    expect(reconcileTaskTimer(started, 1_000 + WORK_SECONDS * 1000 + 1).paused).toBe(true);
  });
  it('recovers malformed storage as no active session', () => {
    expect(readTaskTimer(storage('{bad'))).toBeNull();
    expect(readTaskTimer(storage(JSON.stringify({ version: 2 })))).toBeNull();
  });
  it('preserves paused remaining time across a write and read', () => {
    const store = storage(null);
    const paused = pauseTaskTimer(startTaskTimer(newTaskTimerSession('t1'), 1_000), 5_000);
    store.setItem(TASK_TIMER_STORAGE_KEY, JSON.stringify(paused));
    expect(readTaskTimer(store)?.remainingSeconds).toBe(WORK_SECONDS - 4);
  });
});

describe('task timer session conflicts', () => {
  it('treats a paused full work session as fresh idle', () => {
    expect(taskTimerIsFreshIdle(newTaskTimerSession('t1'))).toBe(true);
  });
  it('treats a running or partial session as destroyable', () => {
    const running = startTaskTimer(newTaskTimerSession('t1'), 1_000);
    expect(taskTimerSessionIsDestroyable(running)).toBe(true);
    const partial = pauseTaskTimer(startTaskTimer(newTaskTimerSession('t1'), 1_000), 5_000);
    expect(taskTimerSessionIsDestroyable(partial)).toBe(true);
  });
  it('shows the selected task idle clock when another task is timed', () => {
    const running = startTaskTimer(newTaskTimerSession('t1'), 1_000);
    const elapsed = reconcileTaskTimer(running, 11_001);
    expect(taskTimerDisplayClock(elapsed, 't2')).toEqual({ seconds: WORK_SECONDS, phase: 'work' });
    expect(taskTimerDisplayClock(elapsed, 't1').seconds).toBeLessThan(WORK_SECONDS);
  });
  it('returns the expected confirmation messages', () => {
    const running = startTaskTimer(newTaskTimerSession('t1'), 1_000);
    expect(taskTimerPickerSwitchConfirm(running, 't2')).toBe(TASK_TIMER_SWITCH_CONFIRM);
    expect(taskTimerPickerSwitchConfirm(running, 't1')).toBeNull();
    expect(taskTimerPickerReselectConfirm(running, 't1')).toBe(TASK_TIMER_RESET_CONFIRM);
    expect(taskTimerReplaceConfirm(running, 't2', 'start')).toBe(TASK_TIMER_REPLACE_CONFIRM);
    expect(taskTimerReplaceConfirm(newTaskTimerSession('t1'), 't1', 'reset')).toBeNull();
  });
});

describe('task timer notification settings', () => {
  it('defaults when nothing is stored', () => {
    expect(readTaskTimerSettings(settingsStorage(null))).toEqual(DEFAULT_TASK_TIMER_SETTINGS);
  });
  it('merges stored fields over the defaults', () => {
    const store = settingsStorage(JSON.stringify({ sound: true }));
    expect(readTaskTimerSettings(store)).toEqual({ ...DEFAULT_TASK_TIMER_SETTINGS, sound: true });
  });
  it('recovers malformed storage as the defaults', () => {
    expect(readTaskTimerSettings(settingsStorage('{bad'))).toEqual(DEFAULT_TASK_TIMER_SETTINGS);
  });
  it('round-trips a write through storage', () => {
    const store = settingsStorage(null);
    const next = { ...DEFAULT_TASK_TIMER_SETTINGS, enabled: false };
    writeTaskTimerSettings(store, next);
    expect(readTaskTimerSettings(store)).toEqual(next);
  });
  it('swallows a storage write failure', () => {
    const store = {
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    expect(() => writeTaskTimerSettings(store, DEFAULT_TASK_TIMER_SETTINGS)).not.toThrow();
  });
});
