import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from './db.ts';
import { createApp } from './app.ts';
import {
  discardOperatorTimer,
  getOperatorTimer,
  OperatorTimerConflict,
  pauseOperatorTimer,
  resumeOperatorTimer,
  startOperatorTimer,
  stopOperatorTimer,
} from './operator-timer.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

async function setup() {
  const app = createApp(db);
  const client = await request(app).post('/api/clients').send({ name: 'Timer owner' }).expect(201);
  const project = await request(app)
    .post('/api/projects')
    .send({ clientId: client.body.id, name: 'Timer project' })
    .expect(201);
  const categories = await request(app)
    .get(`/api/projects/${project.body.id}/time/categories`)
    .expect(200);
  const task = await request(app)
    .post('/api/tasks')
    .send({ projectId: project.body.id, title: 'Timer task' })
    .expect(201);
  return { app, project: project.body, category: categories.body[0], task: task.body };
}

describe('persistent operator timer', () => {
  it('banks pause time, resumes against server time, and saves one linked entry for stop retries', async () => {
    const { project, category, task } = await setup();
    const started = startOperatorTimer(db, {
      projectId: project.id,
      categoryId: category.id,
      taskId: task.id,
      revision: 0,
    });
    expect(started).toMatchObject({
      state: 'RUNNING',
      projectId: project.id,
      categoryId: category.id,
      taskId: task.id,
      revision: 1,
    });
    db.prepare('UPDATE operator_time_timer SET running_since=? WHERE operator_id=?').run(
      new Date(Date.now() - 4_000).toISOString(),
      'operator',
    );

    const paused = pauseOperatorTimer(db, 1);
    expect(paused.state).toBe('PAUSED');
    expect(paused.accumulatedSeconds).toBeGreaterThanOrEqual(3);
    expect(paused.runningSince).toBeUndefined();
    expect(() => resumeOperatorTimer(db, 1)).toThrow(OperatorTimerConflict);

    const resumed = resumeOperatorTimer(db, paused.revision);
    db.prepare('UPDATE operator_time_timer SET running_since=? WHERE operator_id=?').run(
      new Date(Date.now() - 3_000).toISOString(),
      'operator',
    );
    const saved = stopOperatorTimer(db, resumed.timerId!, resumed.revision);
    const retry = stopOperatorTimer(db, resumed.timerId!, 0);
    expect(retry).toEqual(saved);
    expect(saved).toMatchObject({
      projectId: project.id,
      categoryId: category.id,
      taskId: task.id,
    });
    expect(saved.durationSeconds).toBeGreaterThanOrEqual(paused.accumulatedSeconds + 2);
    expect(
      db.prepare('SELECT COUNT(*) count FROM time_entries WHERE project_id=?').get(project.id),
    ).toEqual({ count: 1 });
    expect(getOperatorTimer(db)).toMatchObject({ state: 'READY', revision: 4 });
  });

  it('rejects a concurrent second start and discards without saving', async () => {
    const { project, category } = await setup();
    const started = startOperatorTimer(db, {
      projectId: project.id,
      categoryId: category.id,
      revision: 0,
    });
    expect(() =>
      startOperatorTimer(db, { projectId: project.id, categoryId: category.id, revision: 0 }),
    ).toThrow(OperatorTimerConflict);
    const discarded = discardOperatorTimer(db, started.timerId!, started.revision);
    expect(discarded).toMatchObject({ state: 'READY', revision: 2 });
    expect(db.prepare('SELECT COUNT(*) count FROM time_entries').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM operator_time_timer_stops').get()).toEqual({
      count: 0,
    });
  });

  it('validates project selections and leaves a zero-second stop unchanged', async () => {
    const { project, category } = await setup();
    expect(() =>
      startOperatorTimer(db, {
        projectId: project.id,
        categoryId: '00000000-0000-4000-8000-000000000099',
        revision: 0,
      }),
    ).toThrow(/active category/);
    expect(() =>
      startOperatorTimer(db, {
        projectId: project.id,
        categoryId: category.id,
        taskId: '00000000-0000-4000-8000-000000000099',
        revision: 0,
      }),
    ).toThrow(/task that belongs/);
    const started = startOperatorTimer(db, {
      projectId: project.id,
      categoryId: category.id,
      revision: 0,
    });
    expect(() => stopOperatorTimer(db, started.timerId!, started.revision)).toThrow(
      /at least one second/,
    );
    expect(getOperatorTimer(db)).toMatchObject({
      state: 'RUNNING',
      timerId: started.timerId,
      revision: 1,
    });
    expect(db.prepare('SELECT COUNT(*) count FROM time_entries').get()).toEqual({ count: 0 });
  });

  it('keeps the timer and TASK countdown separate across API reloads and project time reads', async () => {
    const { app, project, category, task } = await setup();
    const initial = await request(app).get('/api/operator-timer').expect(200);
    const started = await request(app)
      .post('/api/operator-timer/start')
      .send({
        projectId: project.id,
        categoryId: category.id,
        taskId: task.id,
        revision: initial.body.revision,
      })
      .expect(201);
    const refreshed = await request(app).get('/api/operator-timer').expect(200);
    expect(refreshed.body).toMatchObject({
      state: 'RUNNING',
      timerId: started.body.timerId,
      taskId: task.id,
    });
    db.prepare('UPDATE operator_time_timer SET running_since=? WHERE operator_id=?').run(
      new Date(Date.now() - 2_000).toISOString(),
      'operator',
    );
    const saved = await request(app)
      .post('/api/operator-timer/stop')
      .send({ timerId: started.body.timerId, revision: started.body.revision })
      .expect(200);
    const entries = await request(app).get(`/api/projects/${project.id}/time/entries`).expect(200);
    expect(entries.body).toHaveLength(1);
    expect(entries.body[0]).toMatchObject({
      id: saved.body.id,
      taskId: task.id,
      durationSeconds: saved.body.durationSeconds,
    });
    await request(app)
      .get('/api/operator-timer')
      .expect(200)
      .expect(({ body }) => expect(body.state).toBe('READY'));
    await request(app)
      .post('/api/operator-timer/stop')
      .send({ timerId: started.body.timerId, revision: started.body.revision })
      .expect(200)
      .expect(({ body }) => expect(body.id).toBe(saved.body.id));
  });
});
