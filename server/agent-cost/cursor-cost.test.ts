import { describe, expect, it } from 'vitest';
import { CursorCostProvider, normalizeCursorUsage } from './cursor-cost.ts';

describe('CursorCostProvider', () => {
  it('refuses to list when no API key is configured', async () => {
    const provider = new CursorCostProvider({ apiKey: '' });
    expect(provider.available).toBe(false);
    await expect(provider.list()).rejects.toThrow(/CURSOR_ADMIN_API_KEY/);
  });

  it('surfaces provider HTTP failures without storing a response body', async () => {
    const provider = new CursorCostProvider({
      apiKey: 'secret',
      fetch: async () =>
        ({
          ok: false,
          status: 503,
          text: async () => 'temporary outage',
        }) as Response,
    });
    await expect(provider.list()).rejects.toThrow(/503/);
  });

  it('validates a successful JSON payload before returning records', async () => {
    const provider = new CursorCostProvider({
      apiKey: 'secret',
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          json: async () =>
            normalizeCursorUsage({
              usage: [
                {
                  model_name: 'gpt-4.1',
                  token_count: 900,
                  currency: 'USD',
                  period_start: '2026-09-01T00:00:00.000Z',
                  period_end: '2026-09-11T23:59:59.999Z',
                  agent_label: 'planner-agent',
                },
              ],
            }),
        }) as Response,
    });
    const listed = await provider.list();
    expect(listed.records[0]?.quantity).toBe(900);
    expect(listed.records[0]?.agentLabel).toBe('planner-agent');
  });
});
