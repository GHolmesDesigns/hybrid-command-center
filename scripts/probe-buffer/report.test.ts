import { describe, expect, it } from 'vitest';
import { renderBufferMatrix, renderBufferPlan } from './report.ts';

describe('Buffer probe reports', () => {
  it('states that plan mode contacts nothing and names exact channels', () => {
    const plan = renderBufferPlan({
      mode: 'plan',
      apiKey: '',
      baseUrl: 'https://api.buffer.com',
      accountId: 'account_1',
      organizationId: 'org_1',
      scheduledAt: '2026-08-26T12:00:00.000Z',
      probeLabel: 'hcc-buffer-0826',
      channels: [{ service: 'tiktok', id: 'tt_1' }],
    });
    expect(plan).toContain('provider will not be contacted');
    expect(plan).toContain('tiktok:tt_1');
    expect(plan).toContain('50 requests');
  });

  it('renders only the three allowed result states in a dated matrix', () => {
    const matrix = renderBufferMatrix(
      {
        claims: [
          { claim: 'Create', state: 'verified', evidence: 'read back' },
          { claim: 'Delete', state: 'negative', evidence: 'still present' },
          { claim: 'Rate limit', state: 'still unverified', evidence: 'not provoked' },
        ],
        created: ['one'],
        deleted: [],
        leftovers: ['one'],
        requests: { used: 8, total: 50 },
      },
      new Date('2026-08-23T12:00:00Z'),
    );
    expect(matrix).toContain('23 August 2026');
    expect(matrix).toContain('**verified**');
    expect(matrix).toContain('**negative**');
    expect(matrix).toContain('**still unverified**');
  });

  it('renders live mode and a stopped reason', () => {
    const plan = renderBufferPlan({
      mode: 'live',
      apiKey: 'never-rendered',
      baseUrl: 'https://api.buffer.com',
      accountId: 'account_1',
      organizationId: 'org_1',
      scheduledAt: '2026-08-26T12:00:00.000Z',
      probeLabel: 'hcc-buffer-0826',
      channels: [{ service: 'youtube', id: 'yt_1' }],
    });
    expect(plan).toContain('will be created and deleted');
    expect(plan).not.toContain('never-rendered');
    const matrix = renderBufferMatrix(
      {
        claims: [],
        created: [],
        deleted: [],
        leftovers: [],
        stopped: 'owner stop',
        requests: { used: 1, total: 50 },
      },
      new Date('2026-08-23T12:00:00Z'),
    );
    expect(matrix).toContain('Stopped: owner stop');
  });
});
