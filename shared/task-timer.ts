export const TASK_TIMER_STORAGE_KEY = 'hcc.task-timer.v1';
export const WORK_SECONDS = 25 * 60;
export const BREAK_SECONDS = 5 * 60;
export const TASK_TIMER_SETTINGS_KEY = 'hcc.task-timer-settings.v1';
export type TaskTimerSettings = {
  enabled: boolean;
  completion: boolean;
  unavailable: boolean;
  sound: boolean;
};
export const DEFAULT_TASK_TIMER_SETTINGS: TaskTimerSettings = {
  enabled: true,
  completion: true,
  unavailable: true,
  sound: false,
};
export function readTaskTimerSettings(storage: Pick<Storage, 'getItem'>): TaskTimerSettings {
  try {
    return {
      ...DEFAULT_TASK_TIMER_SETTINGS,
      ...(JSON.parse(storage.getItem(TASK_TIMER_SETTINGS_KEY) || 'null') || {}),
    };
  } catch {
    return DEFAULT_TASK_TIMER_SETTINGS;
  }
}
export function writeTaskTimerSettings(
  storage: Pick<Storage, 'setItem'>,
  value: TaskTimerSettings,
) {
  try {
    storage.setItem(TASK_TIMER_SETTINGS_KEY, JSON.stringify(value));
  } catch {
    /* optional */
  }
}

export type TaskTimerSession = {
  version: 1;
  taskId: string;
  phase: 'work' | 'break';
  startedAt: string | null;
  targetEndAt: string | null;
  paused: boolean;
  remainingSeconds: number;
  cycleCount: number;
};

export function newTaskTimerSession(taskId: string): TaskTimerSession {
  return {
    version: 1,
    taskId,
    phase: 'work',
    startedAt: null,
    targetEndAt: null,
    paused: true,
    remainingSeconds: WORK_SECONDS,
    cycleCount: 0,
  };
}

function validSession(value: unknown): value is TaskTimerSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<TaskTimerSession>;
  return (
    s.version === 1 &&
    typeof s.taskId === 'string' &&
    (s.phase === 'work' || s.phase === 'break') &&
    (s.startedAt === null || typeof s.startedAt === 'string') &&
    (s.targetEndAt === null || typeof s.targetEndAt === 'string') &&
    typeof s.paused === 'boolean' &&
    typeof s.remainingSeconds === 'number' &&
    Number.isInteger(s.remainingSeconds) &&
    s.remainingSeconds >= 0 &&
    s.remainingSeconds <= WORK_SECONDS &&
    typeof s.cycleCount === 'number' &&
    Number.isInteger(s.cycleCount) &&
    s.cycleCount >= 0
  );
}

export function readTaskTimer(
  storage: Pick<Storage, 'getItem'>,
  now = Date.now(),
): TaskTimerSession | null {
  try {
    const raw = storage.getItem(TASK_TIMER_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!validSession(parsed)) return null;
    return reconcileTaskTimer(parsed, now);
  } catch {
    return null;
  }
}

export function writeTaskTimer(storage: Pick<Storage, 'setItem'>, session: TaskTimerSession) {
  try {
    storage.setItem(TASK_TIMER_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage is optional */
  }
}

export function reconcileTaskTimer(session: TaskTimerSession, now = Date.now()): TaskTimerSession {
  if (session.paused || !session.targetEndAt) return session;
  const remaining = Math.max(0, Math.ceil((Date.parse(session.targetEndAt) - now) / 1000));
  if (remaining > 0) return { ...session, remainingSeconds: remaining };
  const phase = session.phase === 'work' ? 'break' : 'work';
  return {
    ...session,
    phase,
    paused: true,
    startedAt: null,
    targetEndAt: null,
    remainingSeconds: phase === 'work' ? WORK_SECONDS : BREAK_SECONDS,
    cycleCount: session.phase === 'work' ? session.cycleCount + 1 : session.cycleCount,
  };
}

export function startTaskTimer(session: TaskTimerSession, now = Date.now()): TaskTimerSession {
  return {
    ...session,
    paused: false,
    startedAt: new Date(now).toISOString(),
    targetEndAt: new Date(now + session.remainingSeconds * 1000).toISOString(),
  };
}

export function pauseTaskTimer(session: TaskTimerSession, now = Date.now()): TaskTimerSession {
  const current = reconcileTaskTimer(session, now);
  return { ...current, paused: true, startedAt: null, targetEndAt: null };
}
