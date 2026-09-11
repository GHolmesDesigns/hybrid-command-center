import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';
import { createDb } from './db.ts';
import { AGENT_PROFILE_CHARTER_MAX } from '../shared/agent-directory.ts';
import { upsertAgentProfile } from './agent-directory.ts';

describe('agent directory charter HTTP boundary', () => {
  it('persists a charter without changing trust or capabilities', async () => {
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
    const app = createApp(db);

    const saved = await request(app)
      .patch('/api/agents/a1/profile')
      .send({ charter: 'Owns queue health.' })
      .expect(200);
    expect(saved.body.agent).toMatchObject({
      id: 'a1',
      charter: 'Owns queue health.',
      trustLevel: 'VERIFIED',
      capabilities: [{ name: 'code-review', description: 'Reviews code.' }],
    });
    expect(
      (await request(app).get('/api/agents/directory').expect(200)).body.agents,
    ).toContainEqual(expect.objectContaining({ id: 'a1', charter: 'Owns queue health.' }));
    expect(
      db.prepare('SELECT trust_level, bio FROM agent_profiles WHERE agent_id=?').get('a1'),
    ).toEqual({ trust_level: 'VERIFIED', bio: 'Reviews changes.' });
    expect(
      db.prepare('SELECT name, description FROM agent_capabilities WHERE agent_id=?').all('a1'),
    ).toEqual([{ name: 'code-review', description: 'Reviews code.' }]);

    await request(app).patch('/api/agents/a1/profile').send({ charter: '' }).expect(200);
    expect(
      (await request(app).get('/api/agents/directory').expect(200)).body.agents,
    ).toContainEqual(expect.objectContaining({ id: 'a1', charter: null }));
  });

  it('refuses an over-limit charter and a missing registration', async () => {
    const db = createDb(':memory:');
    const app = createApp(db);
    const overLimit = await request(app)
      .patch('/api/agents/operator-session-bootstrap/profile')
      .send({ charter: 'x'.repeat(AGENT_PROFILE_CHARTER_MAX + 1) })
      .expect(400);
    expect(overLimit.body.error).toMatch(/4000|characters/i);
    await request(app)
      .patch('/api/agents/missing/profile')
      .send({ charter: 'No such agent.' })
      .expect(404);
  });
});
