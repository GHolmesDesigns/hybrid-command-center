import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addDays, format, subDays } from 'date-fns';
import { createDb, type Db } from './db.ts';
import { createApp } from './app.ts';
import { PROJECT_SUBFOLDERS } from './config.ts';
import { projectScopes } from './drive/browse.ts';
import { MockDriveProvider, mockDriveFile } from './drive/mock-provider.ts';
import { provisionProject, setSetting } from './drive/service.ts';
import { TASK_CHECKLIST_TEMPLATES } from '../shared/types.ts';
import { DEFAULT_BRANDING } from '../shared/branding.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
/** Today's local calendar day, the shape due dates are stored in. */
const today = format(new Date(), 'yyyy-MM-dd');
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

/**
 * A stamp far enough in the past that any write the server makes is unambiguously
 * newer, so activity assertions never hinge on two calls landing in different
 * milliseconds.
 */
const BACKDATED = '2020-01-01T00:00:00.000Z';
/** Pushes a project's edit and activity stamps into the past, together. */
const backdate = (projectId: string, stamp = BACKDATED) =>
  db
    .prepare('UPDATE projects SET updated_at=?, last_activity_at=? WHERE id=?')
    .run(stamp, stamp, projectId);
/** Reads both stamps straight from SQLite, so the API cannot paper over one of them. */
const stampsOf = (projectId: string) =>
  db
    .prepare(
      'SELECT updated_at updatedAt, last_activity_at lastActivityAt FROM projects WHERE id=?',
    )
    .get(projectId) as { updatedAt: string; lastActivityAt: string };
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
    // Images are the one directive that accepts a remote origin, because a Settings-set
    // logo is referenced by address and its host cannot be known when this is written.
    expect(policy).toContain("img-src 'self' data: https:");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('does not expose the E2E cooperative-stop route', async () => {
    const response = await request(createApp(db)).post('/__e2e/stop');
    expect(response.status).toBe(404);
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
  it('normalizes and reuses project categories while supporting CRUD', async () => {
    const app = createApp(db);
    const created = await request(app)
      .post('/api/categories')
      .send({ name: '  Client   Retainer ', color: '#335577' })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Client Retainer', color: '#335577' });

    // A name already in the list picks that category rather than adding a second one.
    const reused = await request(app)
      .post('/api/categories')
      .send({ name: 'client retainer' })
      .expect(200);
    expect(reused.body).toEqual(created.body);
    expect((await request(app).get('/api/categories')).body).toEqual([created.body]);

    const renamed = await request(app)
      .patch(`/api/categories/${created.body.id}`)
      .send({ name: '  Ongoing   Retainer ', color: '' })
      .expect(200);
    expect(renamed.body).toEqual({ id: created.body.id, name: 'Ongoing Retainer' });
    await request(app).post('/api/categories').send({ name: '   ' }).expect(400);
  });

  it('refuses to rename a category onto a name another category already holds', async () => {
    const app = createApp(db);
    const retainer = (await request(app).post('/api/categories').send({ name: 'Retainer' })).body;
    const campaign = (await request(app).post('/api/categories').send({ name: 'Campaign' })).body;

    const refused = await request(app)
      .patch(`/api/categories/${campaign.id}`)
      .send({ name: 'retainer' })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'CATEGORY_NAME_TAKEN' });
    expect((await request(app).get('/api/categories')).body).toEqual([campaign, retainer]);

    // Renaming a category to the spelling it already has is not a clash with itself.
    await request(app)
      .patch(`/api/categories/${campaign.id}`)
      .send({ name: 'campaign' })
      .expect(200);
  });

  it('attaches and detaches project categories and includes them in project reads', async () => {
    const { p } = await setup();
    const app = createApp(db);
    expect((await request(app).get('/api/projects')).body[0].categories).toEqual([]);
    const category = (await request(app).post('/api/categories').send({ name: 'Retainer' })).body;

    const attached = await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: category.id })
      .expect(201);
    expect(attached.body.categories).toEqual([category]);
    expect((await request(app).get('/api/projects')).body[0].categories).toEqual([category]);

    // Attaching the same category twice is not an error and changes nothing.
    const again = await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: category.id })
      .expect(200);
    expect(again.body.categories).toEqual([category]);

    const detached = await request(app)
      .delete(`/api/projects/${p.id}/categories/${category.id}`)
      .expect(200);
    expect(detached.body.categories).toEqual([]);
  });

  it('renames a category once for every project carrying it', async () => {
    const { c } = await setup();
    const app = createApp(db);
    const second = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Brand Refresh' })
    ).body;
    const first = (await request(app).get('/api/projects')).body.find(
      (project: any) => project.id !== second.id,
    );
    const category = (await request(app).post('/api/categories').send({ name: 'Retainer' })).body;
    for (const project of [first, second])
      await request(app)
        .post(`/api/projects/${project.id}/categories`)
        .send({ categoryId: category.id })
        .expect(201);

    await request(app)
      .patch(`/api/categories/${category.id}`)
      .send({ name: 'Ongoing retainer' })
      .expect(200);

    const projects = (await request(app).get('/api/projects')).body;
    expect(projects.map((project: any) => project.categories.map((one: any) => one.name))).toEqual([
      ['Ongoing retainer'],
      ['Ongoing retainer'],
    ]);
  });

  it('requires confirmation before deleting an attached category, and deletes no project', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const category = (await request(app).post('/api/categories').send({ name: 'Campaign' })).body;
    await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: category.id })
      .expect(201);

    const refused = await request(app).delete(`/api/categories/${category.id}`).expect(409);
    expect(refused.body).toMatchObject({ code: 'CATEGORY_IN_USE', attachedProjectCount: 1 });
    expect((await request(app).get('/api/projects')).body[0].categories).toEqual([category]);

    const deleted = await request(app)
      .delete(`/api/categories/${category.id}?confirm=true`)
      .expect(200);
    expect(deleted.body.detachedFromProjects).toBe(1);
    const projects = (await request(app).get('/api/projects')).body;
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ id: p.id, name: p.name, categories: [] });
    expect(db.prepare('SELECT COUNT(*) count FROM project_categories').get()).toEqual({
      count: 0,
    });
  });

  it('deletes a category no project carries without asking, and refuses unknown ids', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const spare = (await request(app).post('/api/categories').send({ name: 'Unused' })).body;

    await request(app).delete(`/api/categories/${spare.id}`).expect(200);
    expect((await request(app).get('/api/categories')).body).toEqual([]);
    await request(app).delete(`/api/categories/${spare.id}`).expect(404);
    await request(app).patch(`/api/categories/${spare.id}`).send({ name: 'Back' }).expect(404);
    await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: crypto.randomUUID() })
      .expect(404);
    await request(app)
      .post(`/api/projects/${crypto.randomUUID()}/categories`)
      .send({ categoryId: spare.id })
      .expect(404);
  });

  it('cascades project category links when a project is deleted, keeping the category', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const category = (await request(app).post('/api/categories').send({ name: 'Retainer' })).body;
    await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: category.id })
      .expect(201);

    await request(app).delete(`/api/projects/${p.id}`).expect(200);
    expect(db.prepare('SELECT COUNT(*) count FROM project_categories').get()).toEqual({
      count: 0,
    });
    expect((await request(app).get('/api/categories')).body).toEqual([category]);
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
  it('counts a task due today in Due today and in Next 7 days', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const post = (title: string, dueDate: string, status?: string) =>
      request(app).post('/api/tasks').send({ projectId: p.id, title, dueDate, status });
    await post('Due today', today);
    await post('Due in three days', format(addDays(new Date(), 3), 'yyyy-MM-dd'));
    await post('Due in eight days', format(addDays(new Date(), 8), 'yyyy-MM-dd'));
    await post('Finished today', today, 'COMPLETE');

    const d = (await request(app).get('/api/dashboard')).body;

    // The window starts today rather than tomorrow, so today's task is in both buckets.
    expect(d.counts.dueToday).toBe(1);
    expect(d.counts.dueNextSevenDays).toBe(2);
    expect(d.dueTodayTasks.map((t: any) => t.title)).toEqual(['Due today']);
    expect(d.upcomingTasks.map((t: any) => t.title)).toEqual(['Due today', 'Due in three days']);
    // Day 8 is outside the window, and finished work is in no bucket at all.
    expect(
      [...d.dueTodayTasks, ...d.upcomingTasks, ...d.overdueTasks].map((t: any) => t.title),
    ).not.toContain('Finished today');
  });
  it('keeps archived work out of every dashboard number while leaving it reachable', async () => {
    const app = createApp(db);
    const live = await setup();
    const archivedProject = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: live.c.id, name: 'Shelved microsite' })
    ).body;
    const archivedClientProject = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: (await createClient('Former Client')).body.id, name: 'Old retainer' })
    ).body;
    const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
    const add = (projectId: string, title: string) =>
      request(app).post('/api/tasks').send({ projectId, title, dueDate: yesterday });
    const liveTask = (await add(live.p.id, 'Live and late')).body;
    const shelved = (await add(archivedProject.id, 'Shelved and late')).body;
    const formerClients = (await add(archivedClientProject.id, 'Former client, late')).body;

    await request(app).post(`/api/projects/${archivedProject.id}/archive`).expect(200);
    await request(app).post(`/api/clients/${archivedClientProject.clientId}/archive`).expect(200);

    const d = (await request(app).get('/api/dashboard')).body;
    expect(d.counts.overdue).toBe(1);
    expect(d.counts.projectsOverdue).toBe(1);
    expect(d.overdueTasks.map((t: any) => t.id)).toEqual([liveTask.id]);

    // Archived only means "not what needs attention now" — both tasks are still there for
    // anyone who follows a link to that project or opens the board.
    const byProject = async (projectId: string) =>
      ((await request(app).get(`/api/tasks?projectId=${projectId}`)).body as any[]).map(
        (t) => t.id,
      );
    expect(await byProject(archivedProject.id)).toEqual([shelved.id]);
    expect(await byProject(archivedClientProject.id)).toEqual([formerClients.id]);
    const board = ((await request(app).get('/api/tasks')).body as any[]).map((t) => t.id);
    expect(board).toContain(shelved.id);
    expect(board).toContain(formerClients.id);
  });
  it('keeps archived-client work reachable but blocks new work until the client is restored', async () => {
    const app = createApp(db);
    const active = await setup();
    const formerClient = (await createClient('Former Client')).body;
    const formerProject = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: formerClient.id, name: 'Legacy Campaign' })
    ).body;
    const formerTask = (
      await request(app)
        .post('/api/tasks')
        .send({ projectId: formerProject.id, title: 'Existing archived work' })
    ).body;
    const activeTask = (
      await request(app).post('/api/tasks').send({ projectId: active.p.id, title: 'Current work' })
    ).body;

    await request(app).post(`/api/clients/${formerClient.id}/archive`).expect(200);
    await request(app)
      .post('/api/tasks')
      .send({ projectId: formerProject.id, title: 'New work must wait' })
      .expect(400, { error: 'Choose an active project.' });
    await request(app)
      .post(`/api/tasks/${activeTask.id}/dependencies`)
      .send({ dependencyId: formerTask.id })
      .expect(400, { error: 'Choose tasks under active clients and projects.' });

    const stillReachable = await request(app).get(`/api/tasks?projectId=${formerProject.id}`);
    expect(stillReachable.body.map((task: any) => task.id)).toEqual([formerTask.id]);

    await request(app).post(`/api/clients/${formerClient.id}/unarchive`).expect(200);
    await request(app)
      .post('/api/tasks')
      .send({ projectId: formerProject.id, title: 'Work resumes' })
      .expect(201);
    await request(app)
      .post(`/api/tasks/${activeTask.id}/dependencies`)
      .send({ dependencyId: formerTask.id })
      .expect(201);
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
    // A payload from before colours existed is a full replacement like any other PUT, so it
    // leaves the default palette behind rather than a half-written one.
    expect(saved.body.branding.background).toBe(DEFAULT_BRANDING.background);
    expect(saved.body.branding.logoUrl).toBe('');
  });

  describe('sidebar colours and logo', () => {
    const branding = (overrides: Record<string, string> = {}) => ({
      mark: 'GH',
      title: 'GHolmes',
      subtitle: 'Studio Desk',
      tagline: 'Local only',
      background: '#2b0f3a',
      foreground: '#ffe9ff',
      accent: '#f0c419',
      logoUrl: 'https://cdn.example.com/logo.svg',
      logoAlt: 'GHolmes Designs',
      ...overrides,
    });
    const put = (body: Record<string, string>) =>
      request(createApp(db)).put('/api/settings/branding').send(body);
    const stored = async () =>
      (await request(createApp(db)).get('/api/settings/branding')).body.branding;

    it('keeps colours and the logo through a restart, normalizing what it stores', async () => {
      const saved = await put(branding({ accent: '#F0C419', foreground: '#FFF' }));
      expect(saved.status).toBe(200);
      // A second app on the same database is what a restart looks like from here.
      expect(await stored()).toMatchObject({
        background: '#2b0f3a',
        foreground: '#ffffff',
        accent: '#f0c419',
        logoUrl: 'https://cdn.example.com/logo.svg',
        logoAlt: 'GHolmes Designs',
      });
    });

    it('refuses colours that cannot be read, naming the field at fault', async () => {
      const failing = await put(branding({ foreground: '#2f1741' }));
      expect(failing.status).toBe(400);
      expect(failing.body.error).toContain('4.5:1');
      // Nothing was written, so the sidebar the user can still see is unchanged.
      expect(await stored()).toMatchObject({ foreground: DEFAULT_BRANDING.foreground });
    });

    it('refuses a colour that is not a hex value', async () => {
      expect((await put(branding({ background: 'black' }))).status).toBe(400);
      expect((await put(branding({ background: '#12345' }))).status).toBe(400);
    });

    it('refuses a logo without alt text, or on a scheme the page cannot load', async () => {
      expect((await put(branding({ logoAlt: '   ' }))).status).toBe(400);
      const insecure = await put(branding({ logoUrl: 'http://cdn.example.com/logo.svg' }));
      expect(insecure.status).toBe(400);
      expect(insecure.body.error).toContain('https://');
    });

    it('drops alt text for a logo that is not set, so nothing describes nothing', async () => {
      const saved = await put(branding({ logoUrl: '', logoAlt: 'Left over' }));
      expect(saved.status).toBe(200);
      expect(saved.body.branding.logoAlt).toBe('');
    });

    it('completes branding stored before colours existed', async () => {
      db.prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)').run(
        'branding',
        JSON.stringify({
          mark: 'V2',
          title: 'Legacy',
          subtitle: 'Older row',
          tagline: 'Still here',
        }),
        BACKDATED,
      );
      expect(await stored()).toEqual({
        mark: 'V2',
        title: 'Legacy',
        subtitle: 'Older row',
        tagline: 'Still here',
        background: DEFAULT_BRANDING.background,
        foreground: DEFAULT_BRANDING.foreground,
        accent: DEFAULT_BRANDING.accent,
        logoUrl: '',
        logoAlt: '',
      });
    });

    it('falls back to the defaults when the stored row is unreadable branding', async () => {
      // Only a hand-edited database reaches this state; the endpoint cannot write it.
      db.prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)').run(
        'branding',
        JSON.stringify({ ...DEFAULT_BRANDING, foreground: '#1a221f' }),
        BACKDATED,
      );
      expect(await stored()).toEqual(DEFAULT_BRANDING);
    });
  });
  it('reports sync blocked when Drive is disconnected', async () => {
    await setup();
    const sync = await request(createApp(db)).post('/api/drive/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.connected).toBe(false);
  });

  describe('project files (read-only Drive browsing)', () => {
    /** A project with a provisioned folder tree, browsed through the mock provider only. */
    const browsable = async () => {
      const drive = new MockDriveProvider();
      const { p } = await setup();
      setSetting(db, 'drive_root_id', 'root');
      await provisionProject(db, p.id, drive);
      const app = createApp(db, { drive: () => drive });
      const scopes = projectScopes(db, p.id);
      return { app, drive, project: p, scopes };
    };

    it('serves one page of a folder and the scopes the project may be browsed at', async () => {
      const { app, drive, project, scopes } = await browsable();
      drive.seed(scopes[0].id, [
        [mockDriveFile('f1', 'Brief.pdf'), mockDriveFile('f2', 'Deck.key')],
        [mockDriveFile('f3', 'Cut.mp4')],
      ]);

      const first = await request(app).get(`/api/projects/${project.id}/files?pageSize=2`);
      expect(first.status).toBe(200);
      expect(first.body.state).toBe('READY');
      expect(first.body.files.map((file: { name: string }) => file.name)).toEqual([
        'Brief.pdf',
        'Deck.key',
      ]);
      expect(first.body.scopes).toHaveLength(1 + PROJECT_SUBFOLDERS.length);
      expect(first.body.nextPageToken).toBeTruthy();

      const second = await request(app).get(
        `/api/projects/${project.id}/files?pageToken=${encodeURIComponent(first.body.nextPageToken)}`,
      );
      expect(second.body.files.map((file: { name: string }) => file.name)).toEqual(['Cut.mp4']);
      expect(second.body.nextPageToken).toBeNull();
    });

    it('never returns a Drive credential or token to the browser', async () => {
      const { app, drive, project, scopes } = await browsable();
      drive.seed(scopes[0].id, [[mockDriveFile('f1', 'Brief.pdf')]]);
      setSetting(db, 'google_tokens', 'encrypted-token-blob');

      const listing = await request(app).get(`/api/projects/${project.id}/files`);
      // Nothing the token table holds may travel, and the body is only ever the documented
      // shape — so a credential cannot ride along on a field nobody looked at.
      expect(JSON.stringify(listing.body)).not.toContain('encrypted-token-blob');
      expect(Object.keys(listing.body).sort()).toEqual([
        'error',
        'files',
        'folder',
        'nextPageToken',
        'projectId',
        'projectName',
        'scopes',
        'state',
      ]);
      expect(Object.keys(listing.body.files[0]).sort()).toEqual([
        'id',
        'mimeType',
        'modifiedAt',
        'name',
        'size',
        'url',
      ]);
    });

    it('refuses a folder outside the project and never asks Drive for it', async () => {
      const { app, drive, project } = await browsable();
      const refused = await request(app).get(
        `/api/projects/${project.id}/files?folderId=someone-elses-folder`,
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/not part of this project/);
      expect(drive.listCalls).toHaveLength(0);
    });

    it('answers 404 for a project that does not exist', async () => {
      const { app } = await browsable();
      const missing = await request(app).get(`/api/projects/${crypto.randomUUID()}/files`);
      expect(missing.status).toBe(404);
    });

    it('reports a disconnected Drive as a state rather than an error', async () => {
      const { p } = await setup();
      const listing = await request(createApp(db)).get(`/api/projects/${p.id}/files`);
      expect(listing.status).toBe(200);
      expect(['NOT_CONFIGURED', 'NOT_CONNECTED']).toContain(listing.body.state);
      expect(listing.body.files).toEqual([]);
    });

    it('exposes no way to change Drive through the files route', async () => {
      const { app, project } = await browsable();
      for (const attempt of [
        request(app).post(`/api/projects/${project.id}/files`).send({ name: 'x' }),
        request(app).patch(`/api/projects/${project.id}/files`).send({ name: 'x' }),
        request(app).delete(`/api/projects/${project.id}/files`),
        request(app).delete(`/api/projects/${project.id}/files/f1`),
      ])
        expect((await attempt).status).toBe(404);
    });
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

  it('does not stamp last_activity_at when tiles are rearranged', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    const second = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Brand System' })
    ).body;
    backdate(p.id);
    backdate(second.id);

    await request(app)
      .post('/api/projects/reorder')
      .send({ orderedIds: [second.id, p.id] })
      .expect(200);

    // Rearranging tiles is neither an edit nor work, so neither stamp may move.
    expect(stampsOf(p.id)).toEqual({ updatedAt: BACKDATED, lastActivityAt: BACKDATED });
    expect(stampsOf(second.id)).toEqual({ updatedAt: BACKDATED, lastActivityAt: BACKDATED });
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

describe('project activity', () => {
  it('gives a new project an activity stamp from the moment it is created', async () => {
    const { p } = await setup();

    expect(p.lastActivityAt).toBe(p.createdAt);
    expect(stampsOf(p.id)).toEqual({ updatedAt: p.updatedAt, lastActivityAt: p.updatedAt });
  });

  it('stamps activity alongside updated_at when the project record itself is edited', async () => {
    const { p } = await setup();
    backdate(p.id);

    await request(createApp(db))
      .patch(`/api/projects/${p.id}`)
      .send({ notes: 'Kickoff moved to Monday' })
      .expect(200);

    const after = stampsOf(p.id);
    expect(after.updatedAt > BACKDATED).toBe(true);
    expect(after.lastActivityAt).toBe(after.updatedAt);
  });

  it('treats categorizing a project as an edit of the project record', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const category = (await request(app).post('/api/categories').send({ name: 'Retainer' })).body;
    backdate(p.id);

    await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: category.id })
      .expect(201);

    // How a project is described is the project record, not work done inside it, so both
    // stamps move exactly as they do for a rename.
    const attached = stampsOf(p.id);
    expect(attached.updatedAt > BACKDATED).toBe(true);
    expect(attached.lastActivityAt).toBe(attached.updatedAt);

    backdate(p.id);
    // Re-attaching what is already there wrote nothing, so it is not an edit either.
    await request(app)
      .post(`/api/projects/${p.id}/categories`)
      .send({ categoryId: category.id })
      .expect(200);
    expect(stampsOf(p.id)).toEqual({ updatedAt: BACKDATED, lastActivityAt: BACKDATED });
    await request(app)
      .delete(`/api/projects/${p.id}/categories/${crypto.randomUUID()}`)
      .expect(200);
    expect(stampsOf(p.id)).toEqual({ updatedAt: BACKDATED, lastActivityAt: BACKDATED });

    await request(app).delete(`/api/projects/${p.id}/categories/${category.id}`).expect(200);
    const detached = stampsOf(p.id);
    expect(detached.updatedAt > BACKDATED).toBe(true);
    expect(detached.lastActivityAt).toBe(detached.updatedAt);
  });

  it('moves the parent project on every child write, without touching updated_at', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const newTask = async (title: string) =>
      (await request(app).post('/api/tasks').send({ projectId: p.id, title }).expect(201)).body;
    const newChecklistItem = async (taskId: string, text: string) =>
      (
        await request(app).post(`/api/tasks/${taskId}/checklist`).send({ text }).expect(201)
      ).body.checklist.find((item: any) => item.text === text).id;

    const task = await newTask('Anchor task');
    const disposable = await newTask('Disposable task');
    const blocker = await newTask('Blocking task');
    const tag = (await request(app).post('/api/tags').send({ name: 'Campaign' })).body;
    const tickable = await newChecklistItem(task.id, 'Tick me');
    const removable = await newChecklistItem(task.id, 'Remove me');

    // Every write a user can make to a project's children, in an order where each is valid.
    const writes: { label: string; write: () => Promise<unknown> }[] = [
      {
        label: 'task create',
        write: () => newTask('Fresh task'),
      },
      {
        label: 'task patch',
        write: () =>
          request(app).patch(`/api/tasks/${task.id}`).send({ title: 'Anchor task v2' }).expect(200),
      },
      {
        label: 'task status change',
        write: () =>
          request(app)
            .post('/api/tasks/reorder')
            .send({ taskId: task.id, status: 'IN_PROGRESS', orderedIds: [task.id] })
            .expect(200),
      },
      {
        label: 'task complete',
        write: () =>
          request(app).patch(`/api/tasks/${task.id}`).send({ status: 'COMPLETE' }).expect(200),
      },
      {
        label: 'checklist create',
        write: () => newChecklistItem(task.id, 'A later step'),
      },
      {
        label: 'checklist tick',
        write: () =>
          request(app).patch(`/api/checklist/${tickable}`).send({ completed: true }).expect(200),
      },
      {
        label: 'checklist delete',
        write: () => request(app).delete(`/api/checklist/${removable}`).expect(200),
      },
      {
        label: 'tag attach',
        write: () =>
          request(app).post(`/api/tasks/${task.id}/tags`).send({ tagId: tag.id }).expect(201),
      },
      {
        label: 'tag detach',
        write: () => request(app).delete(`/api/tasks/${task.id}/tags/${tag.id}`).expect(200),
      },
      {
        label: 'dependency add',
        write: () =>
          request(app)
            .post(`/api/tasks/${task.id}/dependencies`)
            .send({ dependencyId: blocker.id })
            .expect(201),
      },
      {
        label: 'dependency remove',
        write: () =>
          request(app).delete(`/api/tasks/${task.id}/dependencies/${blocker.id}`).expect(200),
      },
      {
        label: 'task delete',
        write: () => request(app).delete(`/api/tasks/${disposable.id}`).expect(200),
      },
    ];

    for (const { label, write } of writes) {
      backdate(p.id);
      await write();
      const after = stampsOf(p.id);
      expect(after.lastActivityAt > BACKDATED, `${label} must move project activity`).toBe(true);
      expect(after.updatedAt, `${label} must leave updated_at alone`).toBe(BACKDATED);
    }
  });

  it('does not count a child write that changed nothing as activity', async () => {
    const { p } = await setup();
    const app = createApp(db);
    const task = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Tagged task' })
    ).body;
    const tag = (await request(app).post('/api/tags').send({ name: 'Campaign' })).body;
    await request(app).post(`/api/tasks/${task.id}/tags`).send({ tagId: tag.id }).expect(201);
    backdate(p.id);

    // A repeat attach, and detaching a tag that is not there, both write nothing.
    await request(app).post(`/api/tasks/${task.id}/tags`).send({ tagId: tag.id }).expect(200);
    await request(app).delete(`/api/tasks/${task.id}/dependencies/${task.id}`).expect(200);

    expect(stampsOf(p.id)).toEqual({ updatedAt: BACKDATED, lastActivityAt: BACKDATED });
  });

  it('counts a task moved between projects as activity in both', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    const destination = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Brand System' })
    ).body;
    const task = (
      await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Moving task' })
    ).body;
    backdate(p.id);
    backdate(destination.id);

    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ projectId: destination.id })
      .expect(200);

    // One project lost the work, the other gained it.
    expect(stampsOf(p.id).lastActivityAt > BACKDATED).toBe(true);
    expect(stampsOf(destination.id).lastActivityAt > BACKDATED).toBe(true);
    expect(stampsOf(p.id).updatedAt).toBe(BACKDATED);
    expect(stampsOf(destination.id).updatedAt).toBe(BACKDATED);
  });

  it('orders Recently updated by activity rather than by the project record edit', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    const edited = (
      await request(app).post('/api/projects').send({ clientId: c.id, name: 'Brand System' })
    ).body;
    const task = (await request(app).post('/api/tasks').send({ projectId: p.id, title: 'Tick me' }))
      .body;
    const item = (
      await request(app).post(`/api/tasks/${task.id}/checklist`).send({ text: 'One step' })
    ).body.checklist[0];
    const recentIds = async () =>
      ((await request(app).get('/api/dashboard')).body.recentProjects as any[]).map((x) => x.id);

    // `edited` was touched later than any work on `p`, so it leads to begin with.
    backdate(p.id);
    backdate(edited.id, '2020-06-01T00:00:00.000Z');
    expect(await recentIds()).toEqual([edited.id, p.id]);

    await request(app).patch(`/api/checklist/${item.id}`).send({ completed: true }).expect(200);

    // Ticking one checklist item is enough to put the project back on top, and it got
    // there on activity alone — `p.updated_at` is still the older of the two.
    expect(await recentIds()).toEqual([p.id, edited.id]);
    expect(stampsOf(p.id).updatedAt < stampsOf(edited.id).updatedAt).toBe(true);
  });

  it('orders Recently updated by recency alone, breaking ties by name', async () => {
    const { c, p } = await setup();
    const app = createApp(db);
    // Status and activity are set straight in SQLite: this test is about the ordering the
    // dashboard applies, not about which endpoint reaches which status.
    const make = async (name: string, status: string, activity: string) => {
      const created = (await request(app).post('/api/projects').send({ clientId: c.id, name }))
        .body;
      db.prepare('UPDATE projects SET status=?, last_activity_at=? WHERE id=?').run(
        status,
        activity,
        created.id,
      );
      return created;
    };
    // The active project is the stalest; two of the others share a timestamp.
    backdate(p.id);
    const held = await make('Zulu Retainer', 'ON_HOLD', '2026-05-02T00:00:00.000Z');
    const planning = await make('Alpha Launch', 'PLANNING', '2026-05-02T00:00:00.000Z');
    const archived = await make('Old Microsite', 'ARCHIVED', '2026-05-03T00:00:00.000Z');

    const recent = (await request(app).get('/api/dashboard')).body.recentProjects as any[];

    expect(recent.map((x) => x.id)).toEqual([archived.id, planning.id, held.id, p.id]);
    // Nothing but the timestamps decided that: the only ACTIVE project came last.
    expect(recent.at(-1).status).toBe('ACTIVE');
  });
});
