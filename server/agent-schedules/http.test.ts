import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';
import { createDb } from '../db';

describe('scheduled agent run HTTP routes', () => {
  it('lists, pauses, runs due schedules, and exposes the last outcome', async () => {
    const db = createDb(':memory:');
    const app = createApp(db, { now: () => new Date('2026-09-11T12:05:42.000Z') });
    const created = await request(app)
      .post('/api/agent-schedules')
      .send({
        ownerAgentLabel: 'cursor',
        subjectType: 'freeform',
        nextRunAt: '2026-09-11T12:05:00.000Z',
        messageTemplate: 'Review the latest draft.',
        dedupeKey: 'http-test',
      })
      .expect(201);
    expect(created.body).toMatchObject({ ownerAgentLabel: 'cursor', lastRunStatus: null });

    await request(app)
      .post('/api/agent-schedules/run-due')
      .expect(200)
      .expect(({ body }) => expect(body.runs[0]).toMatchObject({ status: 'SUCCEEDED' }));
    await request(app)
      .post('/api/agent-schedules/run-due')
      .expect(200)
      .expect(({ body }) => expect(body.runs).toHaveLength(0));

    const id = created.body.id as string;
    await request(app).patch(`/api/agent-schedules/${id}`).send({ paused: true }).expect(200);
    await request(app)
      .get(`/api/agent-schedules/${id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.schedule).toMatchObject({ paused: true, lastRunStatus: 'SUCCEEDED' });
        expect(body.runs[0]).toMatchObject({ status: 'SUCCEEDED', handoffId: expect.any(String) });
      });
    db.close();
  });

  it('refuses malformed schedule input before writing a row', async () => {
    const db = createDb(':memory:');
    const app = createApp(db);
    await request(app)
      .post('/api/agent-schedules')
      .send({
        ownerAgentLabel: 'cursor',
        subjectType: 'freeform',
        nextRunAt: 'tomorrow',
        messageTemplate: 'Review the latest draft.',
        dedupeKey: 'bad-input',
      })
      .expect(400);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM agent_schedules').get() as { count: number })
        .count,
    ).toBe(0);
    db.close();
  });
});
