import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addDays, format, subDays } from 'date-fns';
import { createDb, type Db } from './db.ts';
import { createApp } from './app.ts';
import { TASK_CHECKLIST_TEMPLATES } from '../shared/types.ts';

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
    expect(c.slug).toBe(`acme-studio-${c.id.slice(0, 6)}`);
    expect(c.driveStatus).toBe('DISCONNECTED');
    expect(p.clientId).toBe(c.id);
    expect(p.driveStatus).toBe('DISCONNECTED');
  });
  it('regenerates a client slug only when a PATCH includes the name', async () => {
    const app = createApp(db);
    const client = (await createClient('Original Name')).body;
    const originalSlug = client.slug;

    const detailsOnly = (
      await request(app).patch(`/api/clients/${client.id}`).send({ notes: 'Updated details' })
    ).body;
    expect(detailsOnly.slug).toBe(originalSlug);

    const renamed = (
      await request(app).patch(`/api/clients/${client.id}`).send({ name: 'G.Holmes Designs' })
    ).body;
    expect(renamed.slug).toBe(`g-holmes-designs-${client.id.slice(0, 6)}`);
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
  it('normalizes and reuses global tags while supporting CRUD', async () => {
    const app = createApp(db);
    const created = await request(app)
      .post('/api/tags')
      .send({ name: '  Client   Review ', color: '#335577' })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Client Review', color: '#335577' });

    const reused = await request(app)
      .post('/api/tags')
      .send({ name: 'client review', color: '#ffffff' })
      .expect(200);
    expect(reused.body).toEqual(created.body);
    expect((await request(app).get('/api/tags')).body).toEqual([created.body]);

    const updated = await request(app)
      .patch(`/api/tags/${created.body.id}`)
      .send({ name: '  Ready   to Publish ', color: '' })
      .expect(200);
    expect(updated.body).toEqual({ id: created.body.id, name: 'Ready to Publish' });
    await request(app).post('/api/tags').send({ name: '   ' }).expect(400);
  });

  it('attaches and detaches tags and includes them in task reads', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Tagged task' })
    ).body;
    expect(task.tags).toEqual([]);
    const tag = (await request(app).post('/api/tags').send({ name: 'Priority client' })).body;

    const attached = await request(app)
      .post(`/api/tasks/${task.id}/tags`)
      .send({ tagId: tag.id })
      .expect(201);
    expect(attached.body.tags).toEqual([tag]);
    expect((await request(app).get('/api/tasks')).body[0].tags).toEqual([tag]);

    const detached = await request(app).delete(`/api/tasks/${task.id}/tags/${tag.id}`).expect(200);
    expect(detached.body.tags).toEqual([]);
  });

  it('requires confirmation before deleting an attached tag and cascades tag joins', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Keep this task' })
    ).body;
    const tag = (await request(app).post('/api/tags').send({ name: 'Campaign' })).body;
    await request(app).post(`/api/tasks/${task.id}/tags`).send({ tagId: tag.id }).expect(201);

    const refused = await request(app).delete(`/api/tags/${tag.id}`).expect(409);
    expect(refused.body).toMatchObject({ code: 'TAG_IN_USE', attachedTaskCount: 1 });
    expect((await request(app).get('/api/tasks')).body[0].tags).toEqual([tag]);

    const deleted = await request(app).delete(`/api/tags/${tag.id}?confirm=true`).expect(200);
    expect(deleted.body.detachedFromTasks).toBe(1);
    expect((await request(app).get('/api/tasks')).body[0]).toMatchObject({ id: task.id, tags: [] });
    expect(db.prepare('SELECT COUNT(*) count FROM task_tags').get()).toEqual({ count: 0 });
  });

  it('cascades task tag joins when a task is deleted without deleting the tag', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Temporary task' })
    ).body;
    const tag = (await request(app).post('/api/tags').send({ name: 'Reusable tag' })).body;
    await request(app).post(`/api/tasks/${task.id}/tags`).send({ tagId: tag.id }).expect(201);

    await request(app).delete(`/api/tasks/${task.id}`).expect(200);
    expect(db.prepare('SELECT COUNT(*) count FROM task_tags').get()).toEqual({ count: 0 });
    expect((await request(app).get('/api/tags')).body).toEqual([tag]);
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
  it('appends new projects to the manual order and persists a reorder', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    const second = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Brand System' })
    ).body;
    const third = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Site Refresh' })
    ).body;
    expect([p.position, second.position, third.position]).toEqual([0, 1, 2]);
    expect((await request(app).get('/api/projects')).body.map((x: any) => x.name)).toEqual([
      'Identity System',
      'Brand System',
      'Site Refresh',
    ]);

    const reordered = await request(app)
      .post('/api/projects/reorder')
      .send({ orderedIds: [third.id, p.id, second.id] });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((x: any) => x.name)).toEqual([
      'Site Refresh',
      'Identity System',
      'Brand System',
    ]);
    const reloaded = (await request(app).get('/api/projects')).body;
    expect(reloaded.map((x: any) => x.name)).toEqual([
      'Site Refresh',
      'Identity System',
      'Brand System',
    ]);
    expect(reloaded.map((x: any) => x.position)).toEqual([0, 1, 2]);
  });
  it('rejects a reorder naming a project that does not exist', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const missing = await request(app)
      .post('/api/projects/reorder')
      .send({ orderedIds: [p.id, crypto.randomUUID()] });
    expect(missing.status).toBe(404);
    expect((await request(app).get('/api/projects')).body[0].position).toBe(0);

    const malformed = await request(app)
      .post('/api/projects/reorder')
      .send({ orderedIds: ['not-a-uuid'] });
    expect(malformed.status).toBe(400);
  });
  it('does not restamp updated_at when tiles are rearranged', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    const second = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Brand System' })
    ).body;

    await request(app)
      .post('/api/projects/reorder')
      .send({ orderedIds: [second.id, p.id] })
      .expect(200);

    const reloaded = (await request(app).get('/api/projects')).body;
    expect(reloaded.find((x: any) => x.id === p.id).updatedAt).toBe(p.updatedAt);
    expect(reloaded.find((x: any) => x.id === second.id).updatedAt).toBe(second.updatedAt);
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

  it('does not reset status, priority, or task type on a PATCH that omits them', async () => {
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
      await request(app).post('/api/tasks').send({
        projectId: p.id,
        title: 'In flight',
        status: 'IN_PROGRESS',
        priority: 'HIGH',
        taskType: 'BLOG_POST',
      })
    ).body;
    const renamedTask = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ title: 'In flight v2' })
    ).body;
    expect(renamedTask.status).toBe('IN_PROGRESS');
    expect(renamedTask.priority).toBe('HIGH');
    expect(renamedTask.taskType).toBe('BLOG_POST');
    // Completing from the modal sends only { status }.
    const completed = (
      await request(app).patch(`/api/tasks/${task.id}`).send({ status: 'COMPLETE' })
    ).body;
    expect(completed.priority).toBe('HIGH');
    expect(completed.taskType).toBe('BLOG_POST');
    expect(completed.title).toBe('In flight v2');
  });

  it('stores an optional task type and leaves untyped tasks editable', async () => {
    const { p } = await setup();
    const app = createApp(db);
    // A task created without a type is valid, reads back as undefined, and still edits.
    const untyped = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Legacy task' })
    ).body;
    expect(untyped.taskType).toBeUndefined();
    const renamed = (
      await request(app).patch(`/api/tasks/${untyped.id}`).send({ title: 'Legacy task v2' })
    ).body;
    expect(renamed.taskType).toBeUndefined();
    expect(renamed.title).toBe('Legacy task v2');
    // A type set later sticks, and the empty string the form posts for "No type" clears it.
    const typed = (
      await request(app).patch(`/api/tasks/${untyped.id}`).send({ taskType: 'QA_BRAND_PASS' })
    ).body;
    expect(typed.taskType).toBe('QA_BRAND_PASS');
    const cleared = (await request(app).patch(`/api/tasks/${untyped.id}`).send({ taskType: '' }))
      .body;
    expect(cleared.taskType).toBeUndefined();
    // The type survives a round trip through the list endpoint.
    await request(app).patch(`/api/tasks/${untyped.id}`).send({ taskType: 'VIDEO' });
    const listed = (await request(app).get('/api/tasks')).body.find(
      (t: any) => t.id === untyped.id,
    );
    expect(listed.taskType).toBe('VIDEO');
  });

  it('seeds the exact ordered checklist template when a typed task is created', async () => {
    const { p } = await setup();
    const app = createApp(db);

    for (const [taskType, titles] of Object.entries(TASK_CHECKLIST_TEMPLATES)) {
      const task = (
        await request(app)
          .post('/api/tasks')
          .send({ projectId: p.id, title: `${taskType} task`, taskType })
          .expect(201)
      ).body;
      expect(task.checklist.map((item: any) => item.text)).toEqual(titles);
      expect(task.checklist.map((item: any) => item.position)).toEqual(
        titles.map((_, position) => position),
      );
      expect(task.checklistTotal).toBe(titles.length);
      expect(task.checklistCompleted).toBe(0);
    }
  });

  it('creates an empty checklist when the task type has no template', async () => {
    const { p } = await setup();
    const app = createApp(db);

    for (const input of [{ title: 'Other task', taskType: 'OTHER' }, { title: 'Untyped task' }]) {
      const task = (
        await request(app)
          .post('/api/tasks')
          .send({ projectId: p.id, ...input })
          .expect(201)
      ).body;
      expect(task.checklist).toEqual([]);
      expect(task.checklistTotal).toBe(0);
    }
  });

  it('rejects a task type outside the vocabulary', async () => {
    const { p } = await setup();
    const app = createApp(db);
    await request(app)
      .post('/api/tasks')
      .send({ projectId: p.id, title: 'Bad type task', taskType: 'PODCAST' })
      .expect(400);
    const task = (
      await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: 'Good type task', taskType: 'GRAPHICS' })
    ).body;
    await request(app).patch(`/api/tasks/${task.id}`).send({ taskType: 'blog_post' }).expect(400);
    // The rejected PATCH must not have disturbed the stored value.
    const stored = (await request(app).get('/api/tasks')).body.find((t: any) => t.id === task.id);
    expect(stored.taskType).toBe('GRAPHICS');
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
