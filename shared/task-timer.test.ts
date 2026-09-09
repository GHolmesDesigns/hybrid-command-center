import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TASK_TIMER_SETTINGS,
  newTaskTimerSession,
  pauseTaskTimer,
  readTaskTimer,
  readTaskTimerSettings,
  reconcileTaskTimer,
  startTaskTimer,
  TASK_TIMER_SETTINGS_KEY,
  TASK_TIMER_STORAGE_KEY,
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
