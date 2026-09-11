import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from '../db.ts';
import { createApp } from '../app.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import { MockAgentCostProvider } from './mock-cost-provider.ts';
import { AgentCostService, readAgentCostSnapshots, readAgentCostSync } from './cost.ts';
import { UnavailableAgentCostProvider } from './cost-provider.ts';
import { normalizeCursorUsage } from './cursor-cost.ts';

let db: Db;
const NOW = new Date('2026-09-11T12:00:00.000Z');
const clock = () => NOW;

const sampleRecord = {
  provider: 'cursor',
  model: 'gpt-4.1',
  quantity: 42_000,
  unit: 'tokens' as const,
  currency: 'USD',
  windowStart: '2026-09-01T00:00:00.000Z',
  windowEnd: '2026-09-11T23:59:59.999Z',
  attributionConfidence: 'exact',
  agentLabel: 'queue-agent',
};

beforeEach(() => {
  db = createDb(':memory:');
});

describe('AgentCostService', () => {
  it('reads stored snapshots without calling the provider', async () => {
    const provider = new MockAgentCostProvider();
    provider.records = [sampleRecord];
    const service = new AgentCostService(db, provider, clock);
    await service.refresh();
    provider.listFailure = new Error('must not be called on read');
    const summary = service.read();
    expect(summary.snapshots).toHaveLength(1);
    expect(summary.snapshots[0]?.quantity).toBe(42_000);
    expect(summary.lastRefreshAt).toBe(NOW.toISOString());
  });

  it('stores provider numbers verbatim and records an integration event', async () => {
    const provider = new MockAgentCostProvider();
    provider.records = [
      sampleRecord,
      { ...sampleRecord, agentLabel: 'planner-agent', quantity: 9_500 },
    ];
    const service = new AgentCostService(db, provider, clock);
    const summary = await service.refresh();
    expect(summary.snapshots).toHaveLength(2);
    expect(readAgentCostSnapshots(db)).toHaveLength(2);
    const event = listIntegrationEvents(db)[0];
    expect(event?.operation).toBe('agent.cost-refresh');
    expect(event?.source).toBe('agent-hub');
    expect(event?.outcome).toBe('SUCCESS');
  });

  it('keeps the latest snapshot per agent on read', async () => {
    const provider = new MockAgentCostProvider();
    let tick = NOW.getTime();
    const advancingClock = () => new Date((tick += 60_000));
    const service = new AgentCostService(db, provider, advancingClock);
    provider.records = [{ ...sampleRecord, quantity: 100 }];
    await service.refresh();
    provider.records = [{ ...sampleRecord, quantity: 250 }];
    await service.refresh();
    const summary = service.read();
    expect(summary.snapshots).toHaveLength(1);
    expect(summary.snapshots[0]?.quantity).toBe(250);
    expect(readAgentCostSnapshots(db)).toHaveLength(2);
  });

  it('leaves prior snapshots in place when refresh fails', async () => {
    const provider = new MockAgentCostProvider();
    provider.records = [sampleRecord];
    const service = new AgentCostService(db, provider, clock);
    await service.refresh();
    provider.listFailure = new Error('provider unavailable');
    const summary = await service.refresh();
    expect(summary.snapshots[0]?.quantity).toBe(42_000);
    expect(summary.reason).toMatch(/provider unavailable/);
    expect(readAgentCostSync(db).reason).toMatch(/provider unavailable/);
    const events = listIntegrationEvents(db);
    expect(events.map((event) => event.outcome)).toEqual(['FAILURE', 'SUCCESS']);
  });

  it('refuses refresh without a configured provider', async () => {
    const service = new AgentCostService(db, new UnavailableAgentCostProvider(), clock);
    const summary = await service.refresh();
    expect(summary.available).toBe(false);
    expect(summary.reason).toMatch(/CURSOR_ADMIN_API_KEY/);
    expect(readAgentCostSnapshots(db)).toHaveLength(0);
  });

  it('refuses to write when the provider returns no valid rows', async () => {
    const provider = new MockAgentCostProvider();
    provider.records = [{ ...sampleRecord, quantity: -1 }];
    const service = new AgentCostService(db, provider, clock);
    const summary = await service.refresh();
    expect(readAgentCostSnapshots(db)).toHaveLength(0);
    expect(summary.reason).toMatch(/no usage rows/);
  });
});

describe('agent cost routes', () => {
  it('serves read and refresh through the HTTP boundary', async () => {
    const provider = new MockAgentCostProvider();
    provider.records = [sampleRecord];
    const app = createApp(db, { agentCost: provider, now: clock });
    const read = await request(app).get('/api/agents/cost').expect(200);
    expect(read.body.snapshots).toEqual([]);
    const refreshed = await request(app).post('/api/agents/cost/refresh').expect(200);
    expect(refreshed.body.snapshots[0]?.agentLabel).toBe('queue-agent');
  });
});

describe('normalizeCursorUsage', () => {
  it('maps documented Cursor envelope fields into validated records', () => {
    const normalized = normalizeCursorUsage({
      usage: [
        {
          model_name: 'gpt-4.1',
          token_count: 1200,
          currency: 'USD',
          period_start: '2026-09-01T00:00:00.000Z',
          period_end: '2026-09-11T23:59:59.999Z',
          attribution_confidence: 'estimated',
          agent_label: 'queue-agent',
        },
      ],
    }) as { records: unknown[] };
    expect(normalized.records[0]).toMatchObject({
      provider: 'cursor',
      model: 'gpt-4.1',
      quantity: 1200,
      unit: 'usd',
      agentLabel: 'queue-agent',
    });
  });
});
