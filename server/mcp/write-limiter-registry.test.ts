import { describe, expect, it } from 'vitest';
import {
  COORDINATION_WRITE_LIMIT_PER_MINUTE,
  INTEGRATION_WRITE_LIMIT_PER_MINUTE,
} from '../../shared/mcp-agent-events.ts';
import { McpWriteLimiterRegistry } from './write-limiter-registry.ts';

const ONE_MINUTE_MS = 60_000;

describe('McpWriteLimiterRegistry', () => {
  it('persists a credential + label budget across separately requested limiters', () => {
    const registry = new McpWriteLimiterRegistry();
    let now = 0;
    for (let i = 0; i < COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const limiter = registry.limiterFor('cred-a', 'cursor', now);
      expect(limiter.tryConsume(now)).toBe(true);
      now += 1;
    }
    const eleventh = registry.limiterFor('cred-a', 'cursor', now);
    expect(eleventh.tryConsume(now)).toBe(false);
    expect(eleventh.retryAfterMs(now)).toBeGreaterThan(0);
  });

  it('the outer ceiling refuses the 11th write even when every request uses a distinct label', () => {
    const registry = new McpWriteLimiterRegistry();
    let now = 0;
    for (let i = 0; i < COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const limiter = registry.limiterFor('cred-a', `label-${i}`, now);
      expect(limiter.tryConsume(now)).toBe(true);
      now += 1;
    }
    const eleventh = registry.limiterFor('cred-a', 'label-fresh', now);
    expect(eleventh.tryConsume(now)).toBe(false);
  });

  it('does not share a budget between two distinct credentials', () => {
    const registry = new McpWriteLimiterRegistry();
    let now = 0;
    for (let i = 0; i < COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(true);
      now += 1;
    }
    expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(false);
    expect(registry.limiterFor('cred-b', 'cursor', now).tryConsume(now)).toBe(true);
  });

  it('rolls the window forward so capacity returns after a minute', () => {
    const registry = new McpWriteLimiterRegistry();
    let now = 0;
    for (let i = 0; i < COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(true);
      now += 1;
    }
    expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(false);

    now += ONE_MINUTE_MS;
    expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(true);
  });

  it('reports the number of tracked credentials', () => {
    const registry = new McpWriteLimiterRegistry();
    registry.limiterFor('cred-a', 'cursor', 0).tryConsume(0);
    registry.limiterFor('cred-b', 'cursor', 0).tryConsume(0);
    expect(registry.trackedCredentialCount).toBe(2);
  });

  it('honours a custom limit of 6 for integration writes', () => {
    const registry = new McpWriteLimiterRegistry(INTEGRATION_WRITE_LIMIT_PER_MINUTE);
    let now = 0;
    for (let i = 0; i < INTEGRATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(true);
      now += 1;
    }
    expect(registry.limiterFor('cred-a', 'cursor', now).tryConsume(now)).toBe(false);
  });
});
