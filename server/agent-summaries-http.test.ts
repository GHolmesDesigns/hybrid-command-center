import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';
import { createDb } from './db.ts';

describe('agent summaries, presence, and notification routes', () => {
  it('sets and reads presence for an agent over HTTP', async () => {
    const app = createApp(createDb(':memory:'));
    const put = await request(app)
      .put('/api/agents/reviewer/presence')
      .send({ state: 'AVAILABLE' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ agentLabel: 'reviewer', state: 'AVAILABLE' });

    const get = await request(app).get('/api/agents/reviewer/presence');
    expect(get.status).toBe(200);
    expect(get.body).toMatchObject({ agentLabel: 'reviewer', state: 'AVAILABLE' });

    const list = await request(app).get('/api/agents/presence');
    expect(list.status).toBe(200);
    expect(list.body.presence).toHaveLength(1);
  });

  it('reports a validation error when presence is malformed', async () => {
    const app = createApp(createDb(':memory:'));
    const res = await request(app)
      .put('/api/agents/reviewer/presence')
      .send({ state: 'NOT_A_STATE' });
    expect(res.status).toBe(400);
  });

  it('lists agent summaries over HTTP', async () => {
    const app = createApp(createDb(':memory:'));
    const res = await request(app).get('/api/agent-summaries').query({ agentLabel: 'reviewer' });
    expect(res.status).toBe(200);
    expect(res.body.summaries).toEqual([expect.objectContaining({ agentLabel: 'reviewer' })]);
  });

  it('creates, lists, and reads a notification over HTTP', async () => {
    const app = createApp(createDb(':memory:'));
    const create = await request(app).post('/api/agent-notifications').send({
      incidentKey: 'agent-offline:reviewer',
      kind: 'presence',
      agentLabel: 'reviewer',
      title: 'Agent went offline',
      body: 'reviewer has not checked in.',
    });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    const list = await request(app).get('/api/agent-notifications');
    expect(list.status).toBe(200);
    expect(list.body.notifications).toHaveLength(1);

    const read = await request(app).post(`/api/agent-notifications/${id}/read`);
    expect(read.status).toBe(200);
    expect(read.body.readAt).not.toBeNull();

    const unread = await request(app).get('/api/agent-notifications').query({ unreadOnly: 'true' });
    expect(unread.body.notifications).toHaveLength(0);
  });

  it('reports 404 marking an unknown notification read', async () => {
    const app = createApp(createDb(':memory:'));
    const res = await request(app).post('/api/agent-notifications/missing/read');
    expect(res.status).toBe(404);
  });
});
