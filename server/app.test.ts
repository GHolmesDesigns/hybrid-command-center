import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addDays, format, subDays } from 'date-fns';
import { createDb, type Db } from './db.ts';
import { SERVER_ERROR_MESSAGE, createApp, type AppOptions } from './app.ts';
import { PROJECT_SUBFOLDERS, config } from './config.ts';
import { projectScopes } from './drive/browse.ts';
import { MockDriveProvider, MockOAuthClient, mockDriveFile } from './drive/mock-provider.ts';
import { OAUTH_STATE_TTL_MS, purgeExpiredAuthorizations } from './drive/oauth.ts';
import { DRIVE_OAUTH_SCOPE } from '../shared/drive-oauth.ts';
import { getSetting, provisionProject, setSetting } from './drive/service.ts';
import type { DriveWriteProvider } from './drive/write.ts';
import { requestDriveWrite } from './drive/agent-write.ts';
import {
  DRIVE_BUDGET,
  DRIVE_OAUTH_BUDGET,
  DRIVE_SYNC_BUDGET,
  IMPORT_BUDGET,
  IMPORT_BUSY_MESSAGE,
  SAMPLE_PLAYBOOK_BUDGET,
  SAMPLE_SIGNAL_BUDGET,
} from './budgets.ts';
import { IMPORT_BODY_LIMIT_BYTES } from './import.ts';
import { findSheet, readXlsxWorkbook } from './domain/workbook.ts';
import { PLAYBOOK_SHEETS } from '../shared/playbook.ts';
import { SIGNAL_IMPORT_SHEETS } from '../shared/signal-import.ts';
import { TASK_CHECKLIST_TEMPLATES } from '../shared/types.ts';
import { APP_VERSION, DEFAULT_BRANDING } from '../shared/branding.ts';
import { manualUrlForVersion } from '../shared/manual.ts';
import { CANONICAL_VIEW_DEFAULTS, type ViewDefaults } from '../shared/view-defaults.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});
const revisionOf = (table: 'clients' | 'projects' | 'tasks', entityId: string) =>
  (db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(entityId) as { revision: number })
    .revision;
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
/** Collects what the request logger writes, which is the only way to assert what it did not. */
const captureLogs = () => {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write(line: string) {
        lines.push(line);
      },
    },
  };
};
/** Reads both stamps straight from SQLite, so the API cannot paper over one of them. */
const stampsOf = (projectId: string) =>
  db
    .prepare(
      'SELECT updated_at updatedAt, last_activity_at lastActivityAt FROM projects WHERE id=?',
    )
    .get(projectId) as { updatedAt: string; lastActivityAt: string };
describe('command center API', () => {
  it('lists and decides agent Drive requests through the operator boundary', async () => {
    const { p } = await setup();
    db.prepare('UPDATE projects SET drive_folder_id=?, drive_folder_url=? WHERE id=?').run(
      'project-folder',
      'https://drive.test/project',
      p.id,
    );
    const pending = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId: p.id,
      parentId: 'project-folder',
      name: 'Approved folder',
      clientRequestId: 'http-approve',
    });
    const denied = requestDriveWrite(db, 'planner', {
      kind: 'create-folder',
      projectId: p.id,
      parentId: 'project-folder',
      name: 'Denied folder',
      clientRequestId: 'http-deny',
    });
    let writes = 0;
    const provider: DriveWriteProvider = {
      connected: true,
      async createFolder(input) {
        writes++;
        return { id: 'created-folder', name: input.name, url: 'https://drive.test/created' };
      },
      async uploadFile(input) {
        writes++;
        return {
          id: 'uploaded-file',
          name: input.name,
          mimeType: input.mimeType,
          url: 'https://drive.test/uploaded',
          modifiedAt: null,
          size: input.bytes.length,
        };
      },
    };
    const app = createApp(db, { driveWrite: () => provider });

    await request(app)
      .get('/api/drive-write-requests?status=PENDING')
      .expect(200)
      .expect(({ body }) =>
        expect(body.requests.map((item: { id: string }) => item.id)).toEqual([
          denied.id,
          pending.id,
        ]),
      );
    await request(app).post(`/api/drive-write-requests/${pending.id}/approve`).expect(200);
    await request(app).post(`/api/drive-write-requests/${denied.id}/deny`).expect(200);
    expect(writes).toBe(1);
    expect(
      db.prepare('SELECT status FROM drive_write_requests WHERE id=?').get(pending.id),
    ).toEqual({
      status: 'APPROVED',
    });
    expect(db.prepare('SELECT status FROM drive_write_requests WHERE id=?').get(denied.id)).toEqual(
      {
        status: 'DENIED',
      },
    );
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM integration_events WHERE operation='drive.agent-write-request'",
        )
        .get(),
    ).toEqual({ count: 4 });
  });

  it('returns boundary errors for invalid status and stale operator decisions', async () => {
    const app = createApp(db);
    await request(app).get('/api/drive-write-requests?status=NOPE').expect(400);
    await request(app).post('/api/drive-write-requests/missing/approve').expect(500);
    await request(app).post('/api/drive-write-requests/missing/deny').expect(500);
  });

  it('enables the documented CSP only for production responses', async () => {
    const development = await request(createApp(db, { production: false })).get('/api/health');
    expect(development.headers['content-security-policy']).toBeUndefined();

    const production = await request(createApp(db, { production: true })).get('/api/health');
    const policy = production.headers['content-security-policy'];
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain(
      "script-src 'self' https://apis.google.com https://accounts.google.com",
    );
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self' https://fonts.googleapis.com");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
    // Images and media are the two directives that accept a remote origin, because both are
    // referenced by address: a Settings-set logo, and the media a Signal post already carries,
    // which the publishing preview renders. Neither host can be known when this is written.
    expect(policy).toContain("img-src 'self' data: https:");
    expect(policy).toContain("media-src 'self' https:");
    expect(policy).toContain(
      "connect-src 'self' https://accounts.google.com https://www.googleapis.com",
    );
    expect(policy).toContain(
      'frame-src https://docs.google.com https://drive.google.com https://accounts.google.com',
    );
    expect(policy).not.toContain('upgrade-insecure-requests');
    // What keeps a media host from learning which page asked for it. `referrerpolicy` is an
    // attribute HTML defines for images and links and not for a `<video>`, so the preview's video
    // element relies on this header rather than on an attribute it cannot carry.
    expect(production.headers['referrer-policy']).toBe('no-referrer');
    expect(development.headers['referrer-policy']).toBe('no-referrer');
  });

  it('does not expose the E2E cooperative-stop route', async () => {
    const response = await request(createApp(db)).post('/__e2e/stop');
    expect(response.status).toBe(404);
  });

  it('reports whether SQLite can answer a health read', async () => {
    const healthy = await request(createApp(db)).get('/api/health');
    expect(healthy.status).toBe(200);
    expect(healthy.body).toEqual({ ok: true });

    const unreadable = createDb(':memory:');
    const app = createApp(unreadable);
    unreadable.close();
    const unhealthy = await request(app).get('/api/health');
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.body).toEqual({ ok: false });
  });

  it('creates clients and projects without pretending disconnected Drive is ready', async () => {
    const { c, p } = await setup();
    expect(c.slug).toBe(`acme-studio-${c.id.slice(0, 6)}`);
    expect(c.driveStatus).toBe('DISCONNECTED');
    expect(p.clientId).toBe(c.id);
    expect(p.driveStatus).toBe('DISCONNECTED');
  });
  it('persists readable client branding, preserves omitted fields, and clears to fallback', async () => {
    const app = createApp(db);
    const created = (
      await request(app).post('/api/clients').send({
        name: 'Branded Client',
        brandingLogoUrl: 'https://cdn.example/logo.svg',
        brandingColorOne: '#18201d',
        brandingColorTwo: '#ffffff',
      })
    ).body;
    expect(created.branding).toEqual({
      logoUrl: 'https://cdn.example/logo.svg',
      colorOne: '#18201d',
      colorTwo: '#ffffff',
    });

    const preserved = (
      await request(app)
        .patch(`/api/clients/${created.id}`)
        .send({ notes: 'Kept', revision: created.revision })
    ).body;
    expect(preserved.branding).toEqual(created.branding);

    const invalidLogo = await request(app).post('/api/clients').send({
      name: 'Invalid Logo Client',
      brandingLogoUrl: 'http://cdn.example/logo.svg',
      brandingColorOne: '#18201d',
      brandingColorTwo: '#ffffff',
    });
    expect(invalidLogo.status).toBe(400);
    expect(invalidLogo.body.error).toContain('https://');

    const invalid = await request(app).patch(`/api/clients/${created.id}`).send({
      brandingColorOne: '#ffffff',
      brandingColorTwo: '#eeeeee',
      revision: preserved.revision,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain('WCAG AA');

    const cleared = (
      await request(app).patch(`/api/clients/${created.id}`).send({
        brandingLogoUrl: '',
        brandingColorOne: '',
        brandingColorTwo: '',
        revision: preserved.revision,
      })
    ).body;
    expect(cleared.branding).toBeUndefined();
  });
  it('regenerates a client slug only when a PATCH includes the name', async () => {
    const app = createApp(db);
    const client = (await createClient('Original Name')).body;
    const originalSlug = client.slug;

    const detailsOnly = (
      await request(app)
        .patch(`/api/clients/${client.id}`)
        .send({ notes: 'Updated details', revision: revisionOf('clients', client.id) })
    ).body;
    expect(detailsOnly.slug).toBe(originalSlug);

    const renamed = (
      await request(app)
        .patch(`/api/clients/${client.id}`)
        .send({ name: 'G.Holmes Designs', revision: revisionOf('clients', client.id) })
    ).body;
    expect(renamed.slug).toBe(`g-holmes-designs-${client.id.slice(0, 6)}`);
  });
  it('refuses missing and stale revisions with structured conflict evidence', async () => {
    const app = createApp(db);
    const client = (await createClient('Concurrent Client')).body;

    await request(app)
      .patch(`/api/clients/${client.id}`)
      .send({ notes: 'No precondition' })
      .expect(400);

    const first = await request(app)
      .patch(`/api/clients/${client.id}`)
      .send({ notes: 'Writer one', revision: client.revision })
      .expect(200);
    expect(first.body.revision).toBe(client.revision + 1);

    const stale = await request(app)
      .patch(`/api/clients/${client.id}`)
      .send({ name: 'Writer two', revision: client.revision })
      .expect(409);
    expect(stale.body).toMatchObject({
      code: 'conflict',
      currentRevision: client.revision + 1,
      changedFields: ['notes'],
    });
    expect((await request(app).get('/api/clients')).body[0]).toMatchObject({
      name: 'Concurrent Client',
      revision: client.revision + 1,
    });
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
    await request(app)
      .patch(`/api/tasks/${b.id}`)
      .send({ status: 'COMPLETE', revision: revisionOf('tasks', b.id) })
      .expect(409);
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
  it('reports and serves only the manual matching the running version', async () => {
    const app = createApp(db);
    const settings = await request(app).get('/api/settings/manual').expect(200);

    expect(settings.body).toEqual({
      version: APP_VERSION,
      available: true,
      url: manualUrlForVersion(APP_VERSION),
    });
    await request(app)
      .get(manualUrlForVersion(APP_VERSION))
      .expect('Content-Type', /html/)
      .expect(200);
    await request(app).get(manualUrlForVersion('0.0.0')).expect(404);
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

  describe('default views and sorts', () => {
    const configured: ViewDefaults = {
      clients: { visibility: 'archived' },
      projects: { visibility: 'all', sort: 'name-ascending', presentation: 'list' },
      calendar: { view: 'week' },
      signal: { view: 'today' },
    };
    const put = (body: object) =>
      request(createApp(db)).put('/api/settings/view-defaults').send(body);
    const stored = async () =>
      (await request(createApp(db)).get('/api/settings/view-defaults')).body.viewDefaults;

    it('answers with the canonical defaults when nothing is stored', async () => {
      expect(await stored()).toEqual(CANONICAL_VIEW_DEFAULTS);
    });

    it('stores a complete allowed object and returns it after a restart', async () => {
      const saved = await put(configured);
      expect(saved.status).toBe(200);
      expect(saved.body.viewDefaults).toEqual(configured);
      expect(await stored()).toEqual(configured);
    });

    it('rejects an unknown page or an invalid sort without writing', async () => {
      expect((await put({ ...configured, status: { view: 'board' } })).status).toBe(400);
      expect(
        (
          await put({
            ...configured,
            projects: { visibility: 'all', sort: 'popularity', presentation: 'list' },
          })
        ).status,
      ).toBe(400);
      expect(await stored()).toEqual(CANONICAL_VIEW_DEFAULTS);
    });

    it('falls back to the canonical defaults when the stored row is unreadable', async () => {
      db.prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)').run(
        'view_defaults',
        JSON.stringify({ clients: { visibility: 'active' } }),
        BACKDATED,
      );
      expect(await stored()).toEqual(CANONICAL_VIEW_DEFAULTS);
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

    it('keeps confirmed folder and upload writes on their separate route', async () => {
      const drive = new MockDriveProvider();
      const { p } = await setup();
      setSetting(db, 'drive_root_id', 'root');
      await provisionProject(db, p.id, drive);
      const writes: string[] = [];
      const write: DriveWriteProvider = {
        connected: true,
        async createFolder(input) {
          writes.push(`folder:${input.parentId}:${input.name}`);
          return {
            id: 'created-folder',
            name: input.name,
            url: 'https://drive.test/created-folder',
          };
        },
        async uploadFile(input) {
          writes.push(`upload:${input.parentId}:${input.name}:${input.bytes.length}`);
          return mockDriveFile('created-file', input.name, {
            mimeType: input.mimeType,
            size: input.bytes.length,
          });
        },
      };
      const app = createApp(db, { drive: () => drive, driveWrite: () => write });
      const scope = projectScopes(db, p.id)[0];
      const folderPreview = await request(app)
        .post(`/api/projects/${p.id}/drive-write/folder/preview`)
        .send({ parentId: scope.id, name: 'Assets' });
      expect(folderPreview.status).toBe(200);
      const folder = await request(app)
        .post(`/api/projects/${p.id}/drive-write/folder`)
        .send(folderPreview.body);
      expect(folder.status).toBe(201);

      const uploadPreview = await request(app)
        .post(`/api/projects/${p.id}/drive-write/upload/preview`)
        .send({
          folderId: scope.id,
          name: 'brief.txt',
          mimeType: 'text/plain',
          contentBase64: Buffer.from('hello').toString('base64'),
        });
      const upload = await request(app)
        .post(`/api/projects/${p.id}/drive-write/upload`)
        .send(uploadPreview.body);
      expect(upload.status).toBe(201);
      expect(writes).toEqual([`folder:${scope.id}:Assets`, `upload:${scope.id}:brief.txt:5`]);
      expect(
        db.prepare('SELECT operation,outcome FROM integration_events ORDER BY created_at').all(),
      ).toEqual([
        { operation: 'drive.create-folder', outcome: 'SUCCESS' },
        { operation: 'drive.upload-file', outcome: 'SUCCESS' },
      ]);
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
      await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ title: 'Renamed task', revision: revisionOf('tasks', task.id) })
    ).body;
    expect(renamed.dueDate).toBe('2026-08-20');
    expect(renamed.notes).toBe('Keep me');
    // Sending an empty string must clear it.
    const cleared = (
      await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ dueDate: '', notes: '', revision: revisionOf('tasks', task.id) })
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
        .send({ contactName: '', phone: '', notes: '', revision: revisionOf('clients', client.id) })
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
      await request(app)
        .patch(`/api/projects/${project.id}`)
        .send({ targetDeadline: '', revision: revisionOf('projects', project.id) })
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
      await request(app)
        .patch(`/api/projects/${project.id}`)
        .send({ name: 'Held Project v2', revision: revisionOf('projects', project.id) })
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
      await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ title: 'In flight v2', revision: revisionOf('tasks', task.id) })
    ).body;
    expect(renamedTask.status).toBe('IN_PROGRESS');
    expect(renamedTask.priority).toBe('HIGH');
    expect(renamedTask.taskType).toBe('BLOG_POST');
    // Completing from the modal sends only { status }.
    const completed = (
      await request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({ status: 'COMPLETE', revision: revisionOf('tasks', task.id) })
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
      await request(app)
        .patch(`/api/tasks/${untyped.id}`)
        .send({ title: 'Legacy task v2', revision: revisionOf('tasks', untyped.id) })
    ).body;
    expect(renamed.taskType).toBeUndefined();
    expect(renamed.title).toBe('Legacy task v2');
    // A type set later sticks, and the empty string the form posts for "No type" clears it.
    const typed = (
      await request(app)
        .patch(`/api/tasks/${untyped.id}`)
        .send({ taskType: 'QA_BRAND_PASS', revision: revisionOf('tasks', untyped.id) })
    ).body;
    expect(typed.taskType).toBe('QA_BRAND_PASS');
    const cleared = (
      await request(app)
        .patch(`/api/tasks/${untyped.id}`)
        .send({ taskType: '', revision: revisionOf('tasks', untyped.id) })
    ).body;
    expect(cleared.taskType).toBeUndefined();
    // The type survives a round trip through the list endpoint.
    await request(app)
      .patch(`/api/tasks/${untyped.id}`)
      .send({ taskType: 'VIDEO', revision: revisionOf('tasks', untyped.id) });
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
      .send({ notes: 'Kickoff moved to Monday', revision: revisionOf('projects', p.id) })
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
          request(app)
            .patch(`/api/tasks/${task.id}`)
            .send({ title: 'Anchor task v2', revision: revisionOf('tasks', task.id) })
            .expect(200),
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
          request(app)
            .patch(`/api/tasks/${task.id}`)
            .send({ status: 'COMPLETE', revision: revisionOf('tasks', task.id) })
            .expect(200),
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
      .send({ projectId: destination.id, revision: revisionOf('tasks', task.id) })
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

/**
 * The Drive connect, end to end against a mock authorization server. Real Google is never
 * contacted from a test (`AGENTS.md`), and the two defects this block exists for — a state
 * that could be replayed, and an authorization code written to the request log — are both
 * only observable from outside the route, so both are asserted from here.
 */
describe('Drive OAuth connect', () => {
  const CREDENTIALS = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:8787/api/drive/oauth/callback',
    encryptionKey: 'test-encryption-key',
  };
  const original = { google: { ...config.google }, logLevel: config.logLevel };
  beforeEach(() => {
    // `config` is read once at import, so the routes are given credentials here rather than
    // through the environment — and a developer's own LOG_LEVEL must not decide what is logged.
    Object.assign(config.google, CREDENTIALS);
    config.logLevel = 'info';
  });
  afterEach(() => {
    Object.assign(config.google, original.google);
    config.logLevel = original.logLevel;
  });

  /** A fixed clock, so the state window is exercised by arithmetic rather than by waiting. */
  const MINTED_AT = new Date('2026-05-01T12:00:00.000Z');
  /** A code shaped like Google's, so a leak of it into a log is recognizable in the assertion. */
  const CODE = '4/0AeanS0b-authorization-code';

  const connect = (overrides: AppOptions = {}) => {
    const oauth = new MockOAuthClient();
    const app = createApp(db, { oauth: () => oauth, now: () => MINTED_AT, ...overrides });
    return { oauth, app };
  };

  /** Runs `/start` and returns the `state` it put on the authorization URL. */
  const start = async (app: ReturnType<typeof createApp>) => {
    const { url } = (await request(app).get('/api/drive/oauth/start').expect(200)).body;
    return String(new URL(url).searchParams.get('state'));
  };

  it('carries a PKCE challenge on the authorization URL and the verifier on the exchange', async () => {
    const { oauth, app } = connect();

    const state = await start(app);
    await request(app).get('/api/drive/oauth/callback').query({ state, code: CODE }).expect(302);

    expect(oauth.exchanges).toEqual([{ code: CODE, verifier: expect.any(String) }]);
    // The exchange is bound to the request that started it: the verifier hashes to the
    // challenge that went out, so an intercepted code on its own could not be redeemed.
    expect(
      crypto.createHash('sha256').update(oauth.exchanges[0].verifier).digest('base64url'),
    ).toBe(oauth.authorizations[0].challenge);
    expect(oauth.authorizations[0].state).toBe(state);
  });

  it('stores the tokens encrypted and never returns them to the browser', async () => {
    const { app } = connect();
    const state = await start(app);

    const response = await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state, code: CODE })
      .expect(302);

    const stored = getSetting(db, 'google_tokens');
    expect(stored).toBeDefined();
    expect(stored).not.toContain('mock-access-token');
    expect(JSON.stringify(response.headers) + response.text).not.toContain('mock-access-token');
  });

  it('rejects a replay of a callback that already succeeded, and exchanges nothing twice', async () => {
    const { oauth, app } = connect();
    const state = await start(app);
    await request(app).get('/api/drive/oauth/callback').query({ state, code: CODE }).expect(302);

    await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state, code: 'attacker-code' })
      .expect(400);

    // One exchange, from the first callback. The replay never reached the provider.
    expect(oauth.exchanges).toHaveLength(1);
    expect(oauth.exchanges[0].code).toBe(CODE);
  });

  /**
   * The defect in the shape it shipped as. The old callback overwrote the stored state with
   * `used` on success, so this request connected the app to whatever account the code came
   * from — invisibly, because Settings shows a connection either way.
   */
  it.each(['used', 'undefined', 'null', 'anything-at-all'])(
    'rejects the invented state %j after a successful connect',
    async (invented) => {
      const { oauth, app } = connect();
      const state = await start(app);
      await request(app).get('/api/drive/oauth/callback').query({ state, code: CODE }).expect(302);
      const connected = getSetting(db, 'google_tokens');

      await request(app)
        .get('/api/drive/oauth/callback')
        .query({ state: invented, code: 'attacker-code' })
        .expect(400);

      expect(oauth.exchanges).toHaveLength(1);
      // The tokens on record are still the ones the user's own connect wrote.
      expect(getSetting(db, 'google_tokens')).toBe(connected);
    },
  );

  it('rejects a callback carrying no state at all', async () => {
    const { oauth, app } = connect();
    await start(app);

    await request(app).get('/api/drive/oauth/callback').query({ code: CODE }).expect(400);

    expect(oauth.exchanges).toEqual([]);
  });

  it('rejects a state older than the window, on a fixed clock', async () => {
    const oauth = new MockOAuthClient();
    let clock = MINTED_AT;
    const app = createApp(db, { oauth: () => oauth, now: () => clock });
    const state = await start(app);

    clock = new Date(MINTED_AT.getTime() + OAUTH_STATE_TTL_MS + 1);
    await request(app).get('/api/drive/oauth/callback').query({ state, code: CODE }).expect(400);

    expect(oauth.exchanges).toEqual([]);
    expect(getSetting(db, 'google_tokens')).toBeUndefined();
  });

  it('names nothing about why a callback was refused', async () => {
    const { app } = connect();
    await start(app);

    const response = await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state: 'used', code: CODE })
      .expect(400);

    expect(response.text).toBe('Invalid OAuth state.');
  });

  /**
   * Asserted against the captured stream rather than by reading the logger's configuration:
   * the defect was that a live code reached stdout, so the test has to look at what was
   * actually written.
   */
  it('logs no authorization code, Authorization header, or Cookie header during a connect', async () => {
    const logs = captureLogs();
    const { app } = connect({ logStream: logs.stream });
    const state = await start(app);

    await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state, code: CODE })
      .set('Authorization', 'Bearer ya29.a-live-access-token')
      .set('Cookie', 'session=a-live-session')
      .expect(302);

    const written = logs.lines.join('');
    expect(written).not.toBe('');
    expect(written).not.toContain(CODE);
    expect(written).not.toContain('4/0A');
    expect(written).not.toContain('ya29.');
    expect(written).not.toContain('a-live-session');
    expect(written).not.toContain(state);
    // The request is still logged — the path survives, and only the query is dropped.
    expect(written).toContain('/api/drive/oauth/callback');

    const requests = logs.lines
      .map((line) => JSON.parse(line) as { req?: Record<string, unknown> })
      .flatMap((entry) => (entry.req ? [entry.req] : []));
    expect(requests).not.toHaveLength(0);
    for (const logged of requests) {
      // The serializer keeps named fields, so the parsed query pino-http offers is not one
      // of them — the code cannot come back through a field nobody looked at.
      expect(logged).not.toHaveProperty('query');
      const headers = (logged.headers ?? {}) as Record<string, string>;
      if ('authorization' in headers) expect(headers.authorization).toBe('[redacted]');
      if ('cookie' in headers) expect(headers.cookie).toBe('[redacted]');
    }
  });

  it('writes nothing when LOG_LEVEL silences the logger', async () => {
    config.logLevel = 'silent';
    const logs = captureLogs();
    const { app } = connect({ logStream: logs.stream });
    const state = await start(app);
    await request(app).get('/api/drive/oauth/callback').query({ state, code: CODE }).expect(302);

    expect(logs.lines).toEqual([]);
  });

  it('rate-limits Drive OAuth start under the oauth budget', async () => {
    const { app } = connect();
    for (let i = 0; i < DRIVE_OAUTH_BUDGET.limit; i += 1) {
      await request(app).get('/api/drive/oauth/start').expect(200);
    }
    const refused = await request(app).get('/api/drive/oauth/start').expect(429);
    expect(refused.body).toEqual({ error: DRIVE_OAUTH_BUDGET.message });
  });

  it('requests drive.file on the authorization URL', async () => {
    const { app } = connect();
    const { url } = (await request(app).get('/api/drive/oauth/start').expect(200)).body as {
      url: string;
    };
    const scopes = new URL(url).searchParams.getAll('scope').flatMap((s) => s.split(/\s+/));
    expect(scopes).toEqual([DRIVE_OAUTH_SCOPE]);
  });

  it('keeps concurrent pending states and binds each callback to its session', async () => {
    const SECRET = 'test-session-secret-at-least-32-chars!!';
    const { createSession } = await import('./auth/sessions.ts');
    const { SESSION_COOKIE_NAME } = await import('../shared/auth.ts');

    const sessionA = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: 'a',
      now: MINTED_AT.getTime(),
    });
    const sessionB = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: 'b',
      now: MINTED_AT.getTime(),
    });

    const oauth = new MockOAuthClient();
    const app = createApp(db, {
      oauth: () => oauth,
      now: () => MINTED_AT,
      enforceAuth: true,
      auth: { sessionSecret: SECRET, operatorPasswordHash: 'unused', trustedProxyHops: 0 },
    });

    const startA = await request(app)
      .get('/api/drive/oauth/start')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionA.rawToken}`)
      .expect(200);
    const startB = await request(app)
      .get('/api/drive/oauth/start')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionB.rawToken}`)
      .expect(200);
    const stateA = String(new URL(startA.body.url).searchParams.get('state'));
    const stateB = String(new URL(startB.body.url).searchParams.get('state'));
    expect(stateA).not.toBe(stateB);

    await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state: stateA, code: CODE })
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionB.rawToken}`)
      .expect(400);

    await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state: stateA, code: CODE })
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionA.rawToken}`)
      .expect(302);

    await request(app)
      .get('/api/drive/oauth/callback')
      .query({ state: stateB, code: 'second-code' })
      .set('Cookie', `${SESSION_COOKIE_NAME}=${sessionB.rawToken}`)
      .expect(302);

    expect(oauth.exchanges).toHaveLength(2);
  });

  it('refuses to start a connect before credentials are configured', async () => {
    Object.assign(config.google, { clientId: '', clientSecret: '', encryptionKey: '' });
    const { app } = connect();

    await request(app).get('/api/drive/oauth/start').expect(500);

    // Nothing pending, so a callback invented against it has nothing to match either.
    purgeExpiredAuthorizations(db, MINTED_AT);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM oauth_pending_states').get() as { n: number },
    ).toEqual({ n: 0 });
  });
});

describe('HTTP boundary', () => {
  const originalLogLevel = config.logLevel;
  beforeEach(() => {
    // A developer's own LOG_LEVEL must not decide whether the error line is written.
    config.logLevel = 'info';
  });
  afterEach(() => {
    config.logLevel = originalLogLevel;
  });

  /**
   * A failure the app cannot anticipate, from the layer whose messages are the reason a 500
   * stopped repeating them: SQLite names the table it could not find.
   */
  const breakTheDatabase = () => db.prepare('DROP TABLE clients').run();

  it('answers a server error with a fixed message and a correlation ID, and logs the detail against it', async () => {
    const logs = captureLogs();
    const app = createApp(db, { logStream: logs.stream });
    breakTheDatabase();

    const response = await request(app).get('/api/clients').expect(500);

    expect(response.body.error).toBe(SERVER_ERROR_MESSAGE);
    expect(response.body.errorId).toEqual(expect.any(String));
    // Whatever SQLite said is not in the response — table names, paths, and provider detail
    // have no reader in the browser who benefits from them.
    expect(JSON.stringify(response.body)).not.toContain('no such table');

    // ...but it is in the log, beside the ID the caller was handed, so the two can be joined.
    const against = logs.lines.filter((line) => line.includes(response.body.errorId));
    expect(against).not.toHaveLength(0);
    expect(against.join('')).toContain('no such table');
  });

  it('gives each server error its own ID, so two reports are two errors', async () => {
    const app = createApp(db, { logStream: captureLogs().stream });
    breakTheDatabase();

    const first = await request(app).get('/api/clients').expect(500);
    const second = await request(app).get('/api/clients').expect(500);

    expect(first.body.errorId).not.toBe(second.body.errorId);
  });

  it('still answers rejected input with the message the form shows, and no ID', async () => {
    const response = await request(createApp(db)).post('/api/clients').send({ name: '' });

    expect(response.status).toBe(400);
    expect(response.body.error).not.toBe(SERVER_ERROR_MESSAGE);
    expect(response.body.error).toEqual(expect.any(String));
    expect(response.body.errorId).toBeUndefined();
  });

  /**
   * `server/index.ts` mounts the built client *after* `createApp`, so this mirrors that order:
   * the point of the assertion is that `/api/nope` is answered before the SPA fallback can
   * hand it `index.html` with a 200, which is how a client-side typo used to surface as a
   * JSON parse error.
   */
  const withStaticClient = () => {
    const app = createApp(db, { production: true });
    app.get('/{*splat}', (_req, res) => res.type('html').send('<!doctype html><div id="root">'));
    return app;
  };

  it('answers an unmatched /api path with a JSON 404 rather than the client shell', async () => {
    const response = await request(withStaticClient()).get('/api/nope').expect(404);

    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'Not found.' });
  });

  it('answers an unmatched /api path the same way for any method', async () => {
    const response = await request(withStaticClient()).post('/api/nope').send({}).expect(404);

    expect(response.body).toEqual({ error: 'Not found.' });
  });

  it('still serves the client shell for a client-side route', async () => {
    await request(withStaticClient())
      .get('/projects/whatever')
      .expect(200)
      .expect(/<div id="root">/);
  });
});

/**
 * C37 (#139). `docs/examples/` holds the workbook a first-time importer starts from, and until
 * this route it was reachable only by opening the repository. The file is served from `docs/`
 * rather than copied into `client/public/`, because `AGENTS.md` requires the format document to
 * change in the same branch as the importer and a duplicate binary would not be in that branch.
 */
describe('the sample playbook download', () => {
  /**
   * The committed workbook, addressed the way the rest of the suite addresses it — by its path
   * under `docs/examples/`, not by the constant the route reads. That is the point of the case:
   * moving or renaming the file fails the build here rather than the user's download.
   */
  const SAMPLE = path.join(
    import.meta.dirname,
    '../docs/examples/campaign-playbook-import-format.xlsx',
  );
  const download = (app: ReturnType<typeof createApp>) =>
    request(app).get('/api/import/playbook/sample').responseType('blob');
  const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

  it('serves the workbook committed under docs/examples, byte for byte', async () => {
    const response = await download(createApp(db));
    const expected = readFileSync(SAMPLE);

    expect(response.status).toBe(200);
    // Digest and length rather than a buffer comparison, so a failure reads as two hex strings
    // instead of 86 KB of binary diff.
    expect({ bytes: response.body.length, sha256: digest(response.body) }).toEqual({
      bytes: expected.length,
      sha256: digest(expected),
    });
  });

  it('serves bytes that open as a workbook, with every tab the importer reads', async () => {
    const response = await download(createApp(db));
    // The acceptance criterion is that the download opens, not that it arrived: the same reader
    // the importer uses is what decides that here.
    const workbook = readXlsxWorkbook(response.body);

    expect(PLAYBOOK_SHEETS.every((sheet) => findSheet(workbook, sheet))).toBe(true);
  });

  it('tells the browser the type and the filename to save it as', async () => {
    const response = await download(createApp(db));

    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="campaign-playbook-import-format.xlsx"',
    );
  });

  it('serves it from the production build, where the client is served too', async () => {
    // `index.ts` mounts `dist/client` and its SPA fallback *after* this app, so the API route
    // still matches first. What is asserted here is the half `createApp` owns: the download is
    // not something the relaxed development policy was carrying.
    const response = await download(createApp(db, { production: true }));

    expect(response.status).toBe(200);
    expect(response.body.length).toBe(readFileSync(SAMPLE).length);
  });

  it('stays available after the import budget is spent', async () => {
    const app = createApp(db);
    const playbook = { text: '[Clients]\nclient_key\tname\nCLI-1\tAcme Studio' };
    for (let i = 0; i < IMPORT_BUDGET.limit + 1; i += 1)
      await request(app).post('/api/import/playbook/preview').send(playbook);

    // The sample is what fixes the workbook that spent the window. Sharing `IMPORT_BUDGET` would
    // withhold it at exactly the moment it is wanted, which is why it has its own.
    expect((await download(app)).status).toBe(200);
  });

  it('refuses a caller past its own window, and names the budget it hit', async () => {
    const app = createApp(db);
    for (let i = 0; i < SAMPLE_PLAYBOOK_BUDGET.limit; i += 1)
      expect((await download(app)).status).toBe(200);

    const refused = await request(app).get('/api/import/playbook/sample');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: SAMPLE_PLAYBOOK_BUDGET.message });
    expect(refused.headers['retry-after']).toBeTruthy();
  });
});

describe('the sample Signal download', () => {
  const SAMPLE = path.join(import.meta.dirname, '../docs/examples/signal-import-format.xlsx');
  const download = (app: ReturnType<typeof createApp>) =>
    request(app).get('/api/import/signal/sample').responseType('blob');
  const digest = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

  it('serves the canonical Signal workbook byte for byte', async () => {
    const response = await download(createApp(db));
    const expected = readFileSync(SAMPLE);

    expect(response.status).toBe(200);
    expect({ bytes: response.body.length, sha256: digest(response.body) }).toEqual({
      bytes: expected.length,
      sha256: digest(expected),
    });
  });

  it('serves a workbook with every tab Signal import reads', async () => {
    const response = await download(createApp(db));
    const workbook = readXlsxWorkbook(response.body);

    expect(SIGNAL_IMPORT_SHEETS.every((sheet) => findSheet(workbook, sheet))).toBe(true);
  });

  it('tells the browser the Signal workbook type and filename', async () => {
    const response = await download(createApp(db));

    expect(response.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="signal-import-format.xlsx"',
    );
  });

  it('has its own download budget', async () => {
    const app = createApp(db);
    for (let i = 0; i < SAMPLE_SIGNAL_BUDGET.limit; i += 1)
      expect((await download(app)).status).toBe(200);

    const refused = await download(app);
    expect(refused.status).toBe(429);
    expect(JSON.parse(refused.body.toString())).toEqual({ error: SAMPLE_SIGNAL_BUDGET.message });
  });
});

/**
 * C28 (#109). The API has no authentication, so what stops a loop against the routes that cost
 * real memory, CPU, or Google's quota is a per-route budget. These cases are the wiring — which
 * routes are metered, which deliberately are not, and what a refused caller is told. `budgets.ts`
 * and its tests own the counting rules.
 */
describe('request budgets', () => {
  /** One import body, small enough that a case can send a dozen without minding the bytes. */
  const playbook = { text: '[Clients]\nclient_key\tname\nCLI-1\tAcme Studio' };
  const PREVIEW = '/api/import/playbook/preview';
  const spend = async (app: ReturnType<typeof createApp>, count: number, path: string) => {
    const statuses: number[] = [];
    for (let i = 0; i < count; i += 1)
      statuses.push((await request(app).post(path).send(playbook)).status);
    return statuses;
  };

  it('refuses an import once its window is spent, and names the budget it hit', async () => {
    const app = createApp(db);
    const spent = await spend(app, IMPORT_BUDGET.limit, '/api/import/playbook/preview');
    expect(spent.some((status) => status === 429)).toBe(false);

    const refused = await request(app).post('/api/import/playbook/preview').send(playbook);
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: IMPORT_BUDGET.message });
    expect(refused.headers['retry-after']).toBeTruthy();
  });

  it('counts a preview and a commit against the same import window', async () => {
    const app = createApp(db);
    await spend(app, IMPORT_BUDGET.limit, '/api/import/playbook/preview');

    // The commit is the expensive half; spending the window on previews still closes it.
    const commit = await request(app).post('/api/import/playbook').send(playbook);
    expect(commit.status).toBe(429);
  });

  it('leaves the receipts an import page reads unmetered beside the imports it budgets', async () => {
    const app = createApp(db);
    await spend(app, IMPORT_BUDGET.limit + 1, '/api/import/playbook/preview');

    // Opening /import lists receipts. It is a cheap read of local rows and shares no window
    // with the previews above, so a spent import budget must not black out the page.
    for (let i = 0; i < IMPORT_BUDGET.limit + 5; i += 1)
      expect((await request(app).get('/api/import/receipts')).status).toBe(200);
  });

  it('leaves the interactive board unmetered, however much of it is used', async () => {
    const app = createApp(db);
    const { p } = await setup();
    // Well past the tightest budget in the app: a global limiter would have refused these, which
    // is the reason there is no global limiter. Reads and writes both.
    for (let i = 0; i < IMPORT_BUDGET.limit * 3; i += 1) {
      expect((await request(app).get('/api/tasks')).status).toBe(200);
      const created = await request(app)
        .post('/api/tasks')
        .send({ projectId: p.id, title: `Task ${i}`, status: 'TODO', priority: 'MEDIUM' });
      expect(created.status).toBe(201);
    }
  });

  it('budgets the Drive routes together, whatever their prefix', async () => {
    const app = createApp(db);
    const { c, p } = await setup();
    for (let i = 0; i < DRIVE_BUDGET.limit; i += 1)
      expect((await request(app).get('/api/settings/drive')).status).not.toBe(429);

    // Different Drive routes, the same window: the quota these protect is one account's, and
    // three of them are addressed under `/api/projects` and `/api/clients` rather than a Drive
    // prefix. Each is mounted separately, so each is asked here — an unmatched mount would meter
    // nothing and pass silently.
    const files = await request(app).get(`/api/projects/${p.id}/files`);
    expect(files.status).toBe(429);
    expect(files.body).toEqual({ error: DRIVE_BUDGET.message });
    expect((await request(app).post(`/api/projects/${p.id}/retry-drive`)).status).toBe(429);
    expect((await request(app).post(`/api/clients/${c.id}/retry-drive`)).status).toBe(429);
  });

  it('budgets a full sync far more tightly than the rest of Drive', async () => {
    const app = createApp(db);
    for (let i = 0; i < DRIVE_SYNC_BUDGET.limit; i += 1)
      expect((await request(app).post('/api/drive/sync')).status).toBe(200);

    const refused = await request(app).post('/api/drive/sync');
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: DRIVE_SYNC_BUDGET.message });
    // Only the sync window is spent; the rest of Drive is still readable.
    expect((await request(app).get('/api/settings/drive')).status).toBe(200);
  });

  it('runs one import at a time, counting from before the body is read', async () => {
    const app = createApp(db);
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify(playbook);
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    const openImport = () =>
      http.request({ port, host: '127.0.0.1', method: 'POST', path: PREVIEW, headers });

    /**
     * Supertest cannot express this case: two ordinary requests to a route this fast never
     * overlap, and a cap that only shows up under real contention is a cap nobody has tested.
     * So the first caller announces a body and then sends ten bytes of it — a slow client, or a
     * deliberate one holding a connection open, which is the case the cap exists for.
     *
     * `server.once('request')` is the sync point. Express's own listener was attached first and
     * runs first, and every middleware ahead of the gate hands off synchronously, so the slot is
     * taken by the time this resolves.
     */
    const slow = openImport();
    // This request is destroyed on purpose below, and an unhandled `ECONNRESET` on a socket the
    // test dropped itself would fail the run for the one thing it is trying to demonstrate.
    slow.on('error', () => {});
    const arrived = new Promise<void>((resolve) => server.once('request', () => resolve()));
    slow.write(body.slice(0, 10));
    await arrived;

    const second = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = openImport();
      req.on('response', (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.end(body);
    });

    expect(second.status).toBe(503);
    expect(JSON.parse(second.body)).toEqual({ error: IMPORT_BUSY_MESSAGE });
    expect(second.status).not.toBe(429);

    // Dropping the held connection frees the slot, so the gate does not wedge the route.
    slow.destroy();
    await new Promise((resolve) => server.close(resolve));
    // The same app, so this asks the gate that just refused a request whether its slot came back.
    expect((await request(app).post(PREVIEW).send(playbook)).status).toBe(200);
  });

  it('answers a body over the import limit with 413 rather than a server error', async () => {
    const app = createApp(db);
    // A single field longer than the whole body limit, so the parser refuses it before the
    // schema — whose own cap on this field the limit is derived from — ever sees it.
    const oversized = 'A'.repeat(IMPORT_BODY_LIMIT_BYTES);
    const response = await request(app)
      .post('/api/import/playbook/preview')
      .send({ contentBase64: oversized });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'That request body is too large.' });
    // A 500 would have carried an error ID and told the user nothing they could act on.
    expect(response.body.errorId).toBeUndefined();
  });

  it('keeps the 1 MB limit on everything that is not an import', async () => {
    const response = await request(createApp(db))
      .post('/api/clients')
      .send({ name: 'A'.repeat(1_100_000) });

    expect(response.status).toBe(413);
  });
});
