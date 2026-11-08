import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from './db.ts';
import { createApp } from './app.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

async function setup() {
  const app = createApp(db);
  const client = await request(app).post('/api/clients').send({ name: 'Time Test' }).expect(201);
  const project = await request(app)
    .post('/api/projects')
    .send({
      clientId: client.body.id,
      name: 'Project',
      priority: 'MEDIUM',
    })
    .expect(201);
  return { app, project: project.body };
}

describe('project time HTTP routes', () => {
  it('saves a manual entry and budget, reports exact totals, and blocks project deletion unchanged', async () => {
    const { app, project } = await setup();
    const categories = await request(app)
      .get(`/api/projects/${project.id}/time/categories`)
      .expect(200);
    const created = await request(app)
      .post(`/api/projects/${project.id}/time/entries`)
      .send({
        categoryId: categories.body[0].id,
        startDate: '2026-01-02',
        startTime: '09:00',
        endTime: '21:42',
        timeZone: 'UTC',
        notes: 'Long session',
      })
      .expect(201);
    expect(created.body.durationSeconds).toBe(762 * 60);

    await request(app)
      .patch(`/api/projects/${project.id}/time-budget`)
      .send({ minutes: 762, revision: project.revision })
      .expect(200);
    const summary = await request(app).get(`/api/projects/${project.id}/time/summary`).expect(200);
    expect(summary.body).toMatchObject({
      totalSeconds: 762 * 60,
      budgetMinutes: 762,
      budgetStatus: 'WARNING',
    });

    const refused = await request(app).delete(`/api/projects/${project.id}`).expect(409);
    expect(refused.body).toMatchObject({ code: 'PROJECT_HAS_TIME_ENTRIES' });
    expect(db.prepare('SELECT id FROM projects WHERE id=?').get(project.id)).toBeTruthy();
    expect(db.prepare('SELECT id FROM time_entries WHERE id=?').get(created.body.id)).toBeTruthy();
  });

  it('stores and validates the configured operator time zone', async () => {
    const { app } = await setup();
    await request(app)
      .put('/api/settings/time-zone')
      .send({ timeZone: 'America/New_York' })
      .expect(200);
    await request(app)
      .get('/api/settings/time-zone')
      .expect(200)
      .expect(({ body }) => {
        expect(body.timeZone).toBe('America/New_York');
      });
    await request(app).put('/api/settings/time-zone').send({ timeZone: 'Not/A_Zone' }).expect(400);
  });
});
