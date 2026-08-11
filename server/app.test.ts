import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addDays, format, subDays } from 'date-fns';
import { createDb, type Db } from './db.ts';
import { createApp } from './app.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
const createClient = (name = 'Acme Studio') =>
  request(createApp(db)).post('/api/clients').send({ name });
async function setup() {
  const c = (await createClient()).body;
  const p = (
    await request(createApp(db))
      .post('/api/projects')
      .send({ clientId: c.id, name: 'Identity System', priority: 'HIGH' })
  ).body;
  return { c, p };
}
describe('command center API', () => {
  it('enables the documented CSP only for production responses', async () => {
    const development = await request(createApp(db, { production: false })).get('/api/health');
    expect(development.headers['content-security-policy']).toBeUndefined();

    const production = await request(createApp(db, { production: true })).get('/api/health');
    const policy = production.headers['content-security-policy'];
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self' https://fonts.googleapis.com");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('creates clients and projects without pretending disconnected Drive is ready', async () => {
    const { c, p } = await setup();
    expect(c.driveStatus).toBe('DISCONNECTED');
    expect(p.clientId).toBe(c.id);
    expect(p.driveStatus).toBe('DISCONNECTED');
  });
  it('creates tasks, reorders columns, and calculates checklist progress', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: 'Build concepts', status: 'TODO', priority: 'HIGH' })
    ).body;
    await request(app)
      .post(`/api/tasks/${task.id}/checklist`)
      .send({ text: 'Sketch three routes' })
      .expect(201);
    const list = await request(app).get('/api/tasks');
    expect(list.body[0].checklistTotal).toBe(1);
    await request(app)
      .post('/api/tasks/reorder')
      .send({ taskId: task.id, status: 'IN_PROGRESS', orderedIds: [task.id] })
      .expect(200);
    expect((await request(app).get('/api/tasks')).body[0].status).toBe('IN_PROGRESS');
  });
  it('blocks incomplete dependencies and prevents circular relationships', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const a = (await request(app).post('/api/tasks').send({ projectId: p.id, title: 'First task' }))
      .body;
    const b = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Second task' })
    ).body;
    await request(app)
      .post(`/api/tasks/${b.id}/dependencies`)
      .send({ dependencyId: a.id })
      .expect(201);
    await request(app).patch(`/api/tasks/${b.id}`).send({ status: 'COMPLETE' }).expect(409);
    await request(app)
      .post(`/api/tasks/${a.id}/dependencies`)
      .send({ dependencyId: b.id })
      .expect(409);
  });
  it('reports overdue and upcoming dashboard counts', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd'),
      tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
    await request(app)
      .post('/api/tasks')
      .send({ projectId: p.id, title: 'Late task', dueDate: yesterday });
    await request(app)
      .post('/api/tasks')
      .send({ projectId: p.id, title: 'Next task', dueDate: tomorrow });
    const d = (await request(app).get('/api/dashboard')).body;
    expect(d.counts.overdue).toBe(1);
    expect(d.counts.dueNextSevenDays).toBe(1);
    expect(d.counts.projectsOverdue).toBe(1);
  });
  it('rejects malformed relationships', async () => {
    const response = await request(createApp(db))
      .post('/api/projects')
      .send({ clientId: crypto.randomUUID(), name: 'Ghost project' });
    expect(response.status).toBe(400);
  });
  it('deletes projects and tasks locally without claiming Drive was touched', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Disposable task' })
    ).body;
    const deletedTask = await request(app).delete(`/api/tasks/${task.id}`);
    expect(deletedTask.status).toBe(200);
    expect(deletedTask.body.driveTouched).toBe(false);
    expect((await request(app).get('/api/tasks')).body).toHaveLength(0);
    const deletedProject = await request(app).delete(`/api/projects/${p.id}`);
    expect(deletedProject.status).toBe(200);
    expect(deletedProject.body.driveTouched).toBe(false);
    expect(
      (await request(app).get('/api/projects')).body.find((x: any) => x.id === p.id),
    ).toBeUndefined();
  });
  it('stores sidebar branding overrides', async () => {
    const app = createApp(db);
    const saved = await request(app)
      .put('/api/settings/branding')
      .send({ mark: 'GH', title: 'GHolmes', subtitle: 'Studio Desk', tagline: 'Local only' });
    expect(saved.status).toBe(200);
    expect(saved.body.branding.mark).toBe('GH');
    expect((await request(app).get('/api/settings/branding')).body.branding.title).toBe('GHolmes');
  });
  it('reports sync blocked when Drive is disconnected', async () => {
    await setup();
    const sync = await request(createApp(db)).post('/api/drive/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.connected).toBe(false);
  });

  it('clears optional task fields when they are sent empty, and keeps them when omitted', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: 'Dated task', dueDate: '2026-08-20', notes: 'Keep me' })
    ).body;
    expect(task.dueDate).toBe('2026-08-20');
    // Omitting a key must preserve the stored value.
    const renamed = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ title: 'Renamed task' })
    ).body;
    expect(renamed.dueDate).toBe('2026-08-20');
    expect(renamed.notes).toBe('Keep me');
    // Sending an empty string must clear it.
    const cleared = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ dueDate: '', notes: '' })
    ).body;
    expect(cleared.dueDate).toBeUndefined();
    expect(cleared.notes).toBeUndefined();
    expect(cleared.title).toBe('Renamed task');
    expect(cleared.overdue).toBe(false);
  });

  it('clears optional client and project fields on request', async () => {
    const app = createApp(db);
    const client = (
      await request(app)
        .post('/api/clients')
        .send({ name: 'Clearable Co', contactName: 'Dana', phone: '555-0100', notes: 'Initial' })
    ).body;
    expect(client.contactName).toBe('Dana');
    const wiped = (
      await request(app)
        .patch(`/api/clients/${client.id}`)
        .send({ contactName: '', phone: '', notes: '' })
    ).body;
    expect(wiped.contactName).toBeUndefined();
    expect(wiped.phone).toBeUndefined();
    expect(wiped.notes).toBeUndefined();
    expect(wiped.name).toBe('Clearable Co');
    const project = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: client.id, name: 'Dated Project', targetDeadline: '2026-09-01' })
    ).body;
    const noDeadline = (
      await request(app).patch(`/api/projects/${project.id}`).send({ targetDeadline: '' })
    ).body;
    expect(noDeadline.targetDeadline).toBeUndefined();
    expect(noDeadline.name).toBe('Dated Project');
  });

  it('does not reset status or priority on a PATCH that omits them', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    // A project created ON_HOLD/URGENT must survive a name-only edit.
    const project = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: c.id, name: 'Held Project', status: 'ON_HOLD', priority: 'URGENT' })
    ).body;
    const renamedProject = (
      await request(app).patch(`/api/projects/${project.id}`).send({ name: 'Held Project v2' })
    ).body;
    expect(renamedProject.status).toBe('ON_HOLD');
    expect(renamedProject.priority).toBe('URGENT');
    // Renaming a task from the detail modal sends only { title }.
    const task = (
      await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: 'In flight', status: 'IN_PROGRESS', priority: 'HIGH' })
    ).body;
    const renamedTask = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ title: 'In flight v2' })
    ).body;
    expect(renamedTask.status).toBe('IN_PROGRESS');
    expect(renamedTask.priority).toBe('HIGH');
    // Completing from the modal sends only { status }.
    const completed = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: 'COMPLETE' })
    ).body;
    expect(completed.priority).toBe('HIGH');
    expect(completed.title).toBe('In flight v2');
  });

  it('rejects task dates that are not real YYYY-MM-DD calendar dates', async () => {
    const { p } = await setup();
    const app = createApp(db);
    for (const dueDate of ['banana', '2026-02-30', '08/20/2026', '2026-8-20', '2026-13-01']) {
      const response = await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: 'Bad date task', dueDate });
      expect(response.status, `POST dueDate=${dueDate}`).toBe(400);
    }
    // A real date is accepted, and a later PATCH is validated the same way.
    const task = (
      await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: 'Good date task', dueDate: '2026-08-10' })
    ).body;
    expect(task.dueDate).toBe('2026-08-10');
    await request(app).patch(`/api/tasks/${task.id}`).send({ dueDate: 'banana' }).expect(400);
    await request(app).patch(`/api/tasks/${task.id}`).send({ startDate: '2026-02-30' }).expect(400);
    // The rejected PATCHes must not have disturbed the stored value.
    const stored = (await request(app).get('/api/tasks')).body.find((t: any) => t.id === task.id);
    expect(stored.dueDate).toBe('2026-08-10');
  });

  it('rejects project dates that are not real YYYY-MM-DD calendar dates', async () => {
    const { c } = await setup();
    const app = createApp(db);
    await request(app)
      .post('/api/projects')
      .send({ clientId: c.id, name: 'Bad date project', targetDeadline: 'next friday' })
      .expect(400);
    const project = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: c.id, name: 'Good date project', startDate: '2026-08-10' })
    ).body;
    expect(project.startDate).toBe('2026-08-10');
    await request(app)
      .patch(`/api/projects/${project.id}`)
      .send({ targetDeadline: '2026-02-30' })
      .expect(400);
  });
});
