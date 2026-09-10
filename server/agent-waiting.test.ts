import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import { suggestMemory } from './agent-memory.ts';
import { buildWaitingInbox } from './agent-waiting.ts';
import { postHandoff } from './agent-coordination/service.ts';

describe('waiting on you inbox', () => {
  it('projects suggested memory and pending Drive writes in oldest-first order', () => {
    const db = createDb(':memory:');
    suggestMemory(
      db,
      {
        key: 'answer',
        value: 'Use the approved copy.',
        scope: { type: 'workspace' },
        source: 'test',
      },
      'agent-memory',
      new Date('2026-09-01T00:00:00.000Z'),
    );
    db.prepare(
      `INSERT INTO drive_write_requests (id,agent_label,client_request_id,plan_json,plan_hash,confirmation,status,created_at)
       VALUES ('drive-1','agent-drive','request-1','{}','hash','Approve this','PENDING','2026-08-31T00:00:00.000Z')`,
    ).run();
    const result = buildWaitingInbox(db, new Date('2026-09-02T00:00:00.000Z'));
    expect(result.warnings).toEqual([]);
    expect(result.items.map((item) => [item.kind, item.id])).toEqual([
      ['DRIVE_WRITE', 'drive-1'],
      ['AGENT_ACTIVITY', expect.any(String)],
    ]);
    expect(result.items[1]).toMatchObject({
      destination: 'Suggested memory',
      resolutionPath: '/agents#agent-memory',
      agent: 'agent-memory',
    });
  });

  it('reports a source warning while retaining available sources', () => {
    const db = createDb(':memory:');
    db.exec('DROP TABLE drive_write_requests');
    const result = buildWaitingInbox(db);
    expect(result.items).toEqual([]);
    expect(result.warnings).toContain('Drive write requests are unavailable.');
  });

  it('includes stale open handoffs but excludes fresh ones', () => {
    const db = createDb(':memory:');
    postHandoff(
      db,
      {
        fromAgentLabel: 'old-agent',
        toAgentLabel: null,
        subjectType: 'task',
        subjectId: 't1',
        message: 'Old',
      },
      new Date('2026-08-01T00:00:00.000Z'),
    );
    postHandoff(
      db,
      {
        fromAgentLabel: 'new-agent',
        toAgentLabel: null,
        subjectType: 'task',
        subjectId: 't2',
        message: 'New',
      },
      new Date('2026-09-01T00:00:00.000Z'),
    );
    const result = buildWaitingInbox(db, new Date('2026-09-02T00:00:00.000Z'));
    expect(result.items.filter((item) => item.kind === 'HANDOFF')).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ agent: 'old-agent', destination: 'Stale handoff' });
  });
});
