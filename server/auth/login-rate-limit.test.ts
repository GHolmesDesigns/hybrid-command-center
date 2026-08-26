import { describe, expect, it } from 'vitest';
import {
  LOGIN_DELAY_BASE_MS,
  LOGIN_DELAY_CAP_MS,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_MAX_FAILURES,
} from '../../shared/auth.ts';
import { LoginRateLimiter } from './login-rate-limit.ts';

describe('LoginRateLimiter', () => {
  it('allows the first attempt with no delay', () => {
    const limiter = new LoginRateLimiter();
    expect(limiter.check('1.2.3.4', 1_000)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('applies progressive delay after failures: 1s, 2s, 4s…', () => {
    const limiter = new LoginRateLimiter();
    const address = '1.2.3.4';
    let now = 10_000;

    limiter.recordFailure(address, now);
    expect(limiter.check(address, now)).toEqual({
      allowed: false,
      retryAfterMs: LOGIN_DELAY_BASE_MS,
    });
    expect(limiter.check(address, now + LOGIN_DELAY_BASE_MS)).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });

    now = now + LOGIN_DELAY_BASE_MS;
    limiter.recordFailure(address, now);
    expect(limiter.check(address, now).retryAfterMs).toBe(LOGIN_DELAY_BASE_MS * 2);

    now = now + LOGIN_DELAY_BASE_MS * 2;
    limiter.recordFailure(address, now);
    expect(limiter.check(address, now).retryAfterMs).toBe(LOGIN_DELAY_BASE_MS * 4);
  });

  it('caps the progressive delay', () => {
    const limiter = new LoginRateLimiter(20, LOGIN_FAILURE_WINDOW_MS);
    const address = '5.6.7.8';
    let now = 0;
    for (let i = 0; i < 10; i += 1) {
      limiter.recordFailure(address, now);
      const decision = limiter.check(address, now);
      if (decision.allowed) break;
      expect(decision.retryAfterMs).toBeLessThanOrEqual(LOGIN_DELAY_CAP_MS);
      now += decision.retryAfterMs;
    }
    limiter.recordFailure(address, now);
    const delayed = limiter.check(address, now);
    expect(delayed.retryAfterMs).toBeLessThanOrEqual(LOGIN_DELAY_CAP_MS);
  });

  it('locks out after the failure budget until the window rolls', () => {
    const limiter = new LoginRateLimiter();
    const address = '9.9.9.9';
    let now = 100_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      const gate = limiter.check(address, now);
      if (!gate.allowed) now += gate.retryAfterMs;
      limiter.recordFailure(address, now);
      now += 1;
    }
    const locked = limiter.check(address, now);
    expect(locked.allowed).toBe(false);
    expect(locked.retryAfterMs).toBeGreaterThan(0);

    const afterWindow = now + LOGIN_FAILURE_WINDOW_MS;
    expect(limiter.check(address, afterWindow)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('clear removes the budget for an address after a successful login', () => {
    const limiter = new LoginRateLimiter();
    limiter.recordFailure('1.1.1.1', 0);
    limiter.clear('1.1.1.1');
    expect(limiter.check('1.1.1.1', 0)).toEqual({ allowed: true, retryAfterMs: 0 });
  });

  it('tracks addresses independently', () => {
    const limiter = new LoginRateLimiter();
    limiter.recordFailure('a', 0);
    expect(limiter.check('b', 0).allowed).toBe(true);
    expect(limiter.check('a', 0).allowed).toBe(false);
  });
});
