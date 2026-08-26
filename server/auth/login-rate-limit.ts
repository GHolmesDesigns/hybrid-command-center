/**
 * In-memory login failure budget for the single operator (C51 / #177).
 *
 * Keyed only by client address — no credential material is stored. Progressive delay grows after
 * each failure within the window; a hard lockout applies once the failure budget is spent.
 */
import {
  LOGIN_DELAY_BASE_MS,
  LOGIN_DELAY_CAP_MS,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_MAX_FAILURES,
} from '../../shared/auth.ts';

export type LoginRateLimitDecision = {
  allowed: boolean;
  retryAfterMs: number;
};

type FailureBucket = {
  /** Failure timestamps (ms) still inside the rolling window. */
  failures: number[];
};

function progressiveDelayMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  const delay = LOGIN_DELAY_BASE_MS * 2 ** (failureCount - 1);
  return Math.min(LOGIN_DELAY_CAP_MS, delay);
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, FailureBucket>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(
    maxFailures: number = LOGIN_MAX_FAILURES,
    windowMs: number = LOGIN_FAILURE_WINDOW_MS,
  ) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  /** Drop every tracked address — used by tests. */
  reset(): void {
    this.buckets.clear();
  }

  clear(address: string): void {
    this.buckets.delete(address);
  }

  recordFailure(address: string, now: number = Date.now()): void {
    const bucket = this.bucket(address);
    this.prune(bucket, now);
    bucket.failures.push(now);
  }

  /**
   * Whether a login attempt may proceed at `now`.
   * When refused, `retryAfterMs` is how long the caller should wait before trying again.
   */
  check(address: string, now: number = Date.now()): LoginRateLimitDecision {
    const bucket = this.buckets.get(address);
    if (!bucket) return { allowed: true, retryAfterMs: 0 };

    this.prune(bucket, now);
    if (bucket.failures.length === 0) {
      this.buckets.delete(address);
      return { allowed: true, retryAfterMs: 0 };
    }

    if (bucket.failures.length >= this.maxFailures) {
      const oldest = bucket.failures[0]!;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - now);
      return { allowed: false, retryAfterMs };
    }

    const lastFailure = bucket.failures[bucket.failures.length - 1]!;
    const delay = progressiveDelayMs(bucket.failures.length);
    const readyAt = lastFailure + delay;
    if (now < readyAt) {
      return { allowed: false, retryAfterMs: readyAt - now };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  private bucket(address: string): FailureBucket {
    let bucket = this.buckets.get(address);
    if (!bucket) {
      bucket = { failures: [] };
      this.buckets.set(address, bucket);
    }
    return bucket;
  }

  private prune(bucket: FailureBucket, now: number): void {
    const floor = now - this.windowMs;
    while (bucket.failures.length > 0 && bucket.failures[0]! < floor) {
      bucket.failures.shift();
    }
  }
}

/** Process-wide limiter — one operator, one budget per client address. */
export const loginRateLimiter = new LoginRateLimiter();
