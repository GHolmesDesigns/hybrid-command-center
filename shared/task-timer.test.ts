import { describe, expect, it } from 'vitest';
import {
  newTaskTimerSession,
  pauseTaskTimer,
  readTaskTimer,
  reconcileTaskTimer,
  startTaskTimer,
  TASK_TIMER_STORAGE_KEY,
  WORK_SECONDS,
} from './task-timer';

function storage(value: string | null) {
  const data = new Map([[TASK_TIMER_STORAGE_KEY, value]]);
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
