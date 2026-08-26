import { describe, expect, it } from 'vitest';
import { RollingWindowLimiter } from './rate-limit.ts';

describe('RollingWindowLimiter', () => {
  it('prunes expired stamps and reports remaining capacity', () => {
    const limiter = new RollingWindowLimiter(2, 1000);
    expect(limiter.remaining(0)).toBe(2);
    expect(limiter.tryConsume(0)).toBe(true);
    expect(limiter.tryConsume(100)).toBe(true);
    expect(limiter.tryConsume(200)).toBe(false);
    expect(limiter.remaining(200)).toBe(0);
    expect(limiter.remaining(1100)).toBe(1);
    expect(limiter.tryConsume(1100)).toBe(true);
    expect(limiter.remaining(1100)).toBe(0);
  });
});
