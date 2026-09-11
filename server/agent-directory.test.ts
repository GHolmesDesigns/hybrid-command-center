import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import { listAgentDirectory, updateAgentCharter, upsertAgentProfile } from './agent-directory.ts';

describe('agent directory', () => {
  it('derives identity and distinguishes current from historical availability', () => {
    const db = createDb(':memory:');
    db.prepare(
      'INSERT INTO agent_registrations(id,display_label,created_at,last_used_at,last_origin) VALUES(?,?,?,?,?)',
    ).run('a1', 'reviewer', '2026-01-01T00:00:00.000Z', '2026-09-08T12:00:00.000Z', 'test');
    upsertAgentProfile(
      db,
      'a1',
      {
        displayName: 'Review Agent',
        trustLevel: 'VERIFIED',
        capabilities: [{ name: 'code-review', description: 'Reviews code.' }],
      },
      Date.parse('2026-09-08T12:05:00.000Z'),
    );
    const current = listAgentDirectory(db, Date.parse('2026-09-08T12:10:00.000Z')).find(
      (agent) => agent.label === 'reviewer',
    )!;
    expect(current).toMatchObject({
      label: 'reviewer',
      displayName: 'Review Agent',
      charter: null,
      availability: 'CURRENT',
      trustLevel: 'VERIFIED',
    });
    expect(current.capabilities).toEqual([{ name: 'code-review', description: 'Reviews code.' }]);
    expect(
      listAgentDirectory(db, Date.parse('2026-09-08T13:00:00.000Z')).find(
        (agent) => agent.label === 'reviewer',
      )!.availability,
    ).toBe('HISTORICAL');
    expect(JSON.stringify(current)).not.toContain('token');
  });

  it('updates only the charter and preserves trust and capabilities', () => {
    const db = createDb(':memory:');
    db.prepare(
      'INSERT INTO agent_registrations(id,display_label,created_at,last_used_at,last_origin) VALUES(?,?,?,?,?)',
    ).run('a1', 'reviewer', '2026-01-01T00:00:00.000Z', null, null);
    upsertAgentProfile(db, 'a1', {
      displayName: 'Review Agent',
      bio: 'Reviews changes.',
      trustLevel: 'VERIFIED',
      capabilities: [{ name: 'code-review', description: 'Reviews code.' }],
    });
    expect(updateAgentCharter(db, 'a1', 'Owns queue health.')).toBe(true);
    expect(listAgentDirectory(db).find((agent) => agent.id === 'a1')).toMatchObject({
      charter: 'Owns queue health.',
      trustLevel: 'VERIFIED',
      capabilities: [{ name: 'code-review', description: 'Reviews code.' }],
    });
    expect(updateAgentCharter(db, 'a1', null)).toBe(true);
    expect(listAgentDirectory(db).find((agent) => agent.id === 'a1')?.charter).toBeNull();
  });
});
