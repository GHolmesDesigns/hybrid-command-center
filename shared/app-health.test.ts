import { describe, expect, it } from 'vitest';
import { appHealthResponseSchema, appHealthSignalSchema } from './app-health';

const signal = (overrides: Partial<Parameters<typeof appHealthSignalSchema.parse>[0]> = {}) => ({
  state: 'healthy' as const,
  label: 'Process',
  detail: 'Running normally.',
  checkedAt: '2026-09-08T00:00:00.000Z',
  freshness: 'just now',
  ...overrides,
});

describe('app health schemas', () => {
  it('accepts a well-formed signal', () => {
    expect(appHealthSignalSchema.parse(signal())).toMatchObject({ state: 'healthy' });
  });

  it('accepts a signal with no last-checked timestamp', () => {
    expect(appHealthSignalSchema.parse(signal({ checkedAt: null })).checkedAt).toBeNull();
  });

  it('rejects a signal with an unknown state', () => {
    expect(() => appHealthSignalSchema.parse(signal({ state: 'unknown' as never }))).toThrow();
  });

  it('accepts a well-formed dashboard response', () => {
    const response = {
      generatedAt: '2026-09-08T00:00:00.000Z',
      overall: 'healthy' as const,
      signals: {
        process: signal(),
        database: signal({ label: 'Database' }),
        agentActivity: signal({ label: 'Agent activity' }),
        remoteAgents: signal({ label: 'Remote agents' }),
      },
    };
    expect(appHealthResponseSchema.parse(response)).toEqual(response);
  });

  it('rejects a dashboard response missing a signal', () => {
    const response = {
      generatedAt: '2026-09-08T00:00:00.000Z',
      overall: 'healthy',
      signals: {
        process: signal(),
        database: signal(),
        agentActivity: signal(),
      },
    };
    expect(() => appHealthResponseSchema.parse(response)).toThrow();
  });
});
