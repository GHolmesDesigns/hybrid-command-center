/**
 * Merging one client into another (C49).
 *
 * The properties this suite is here to hold: the preview writes nothing, the commit is atomic,
 * the work arrives intact, the aliases follow the latest survivor, no Drive method is called,
 * and the routes that could quietly undo a merge — unarchive and a project PATCH — refuse to.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDb, type Db } from './db.ts';
import { createApp } from './app.ts';
import { commitClientMerge, previewClientMerge, readMergeWorkspace } from './client-merge.ts';
import { ClientMergeError, buildClientMergePlan } from './domain/client-merge.ts';
import { listClients } from './repositories.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const app = () => createApp(db);
const createClient = async (name: string) =>
  (await request(app()).post('/api/clients').send({ name })).body;
const createProject = async (clientId: string, name: string, status = 'ACTIVE') =>
  (await request(app()).post('/api/projects').send({ clientId, name, status })).body;
const archiveClient = (id: string) => request(app()).post(`/api/clients/${id}/archive`).send();
const preview = (sourceId: string, destinationId: string) =>
  request(app()).post(`/api/clients/${sourceId}/merge/preview`).send({ destinationId });
const merge = (sourceId: string, destinationId: string, planHash: string) =>
  request(app()).post(`/api/clients/${sourceId}/merge`).send({ destinationId, planHash });

/** A merge through the API, previewed then confirmed, which is the only way the UI does it. */
async function mergeClients(sourceId: string, destinationId: string) {
  const planned = await preview(sourceId, destinationId);
  expect(planned.status).toBe(200);
  const done = await merge(sourceId, destinationId, planned.body.planHash);
  expect(done.status).toBe(200);
  return done.body;
}

const aliases = () =>
  db
    .prepare(
      'SELECT source_client_id source, surviving_client_id surviving FROM client_merges ORDER BY source',
    )
    .all() as { source: string; surviving: string }[];

/** The import identities on the table, so a merge can be asked what it did with them. */
const importIdentities = () =>
  db
    .prepare(
      `SELECT source_namespace ns, external_id ext, client_id id FROM client_import_aliases
       ORDER BY source_namespace, external_id`,
    )
    .all() as { ns: string; ext: string; id: string }[];

/** Records one against a client, the way a playbook import does. */
const recordIdentity = (clientId: string, ext: string, source = 'source-a') =>
  db
    .prepare(
      `INSERT INTO client_import_aliases(source_namespace,external_id,client_id,created_at)
       VALUES(?,?,?,'2026-08-19T00:00:00.000Z')`,
    )
    .run(`campaign-playbook:${source}`, ext, clientId);

describe('the client merge planner', () => {
  it('previews the whole portfolio, whatever each project’s status, and writes nothing', async () => {
    const source = await createClient('Duplicate Studio');
    const destination = await createClient('Studio');
    await createProject(source.id, 'Live campaign', 'ACTIVE');
    await createProject(source.id, 'Finished campaign', 'COMPLETE');
    await createProject(destination.id, 'Existing work');
    const before = db.prepare('SELECT * FROM projects ORDER BY id').all();

    const response = await preview(source.id, destination.id);

    expect(response.status).toBe(200);
    expect(response.body.source).toMatchObject({ id: source.id, name: 'Duplicate Studio' });
    expect(response.body.destination).toMatchObject({ id: destination.id, name: 'Studio' });
    expect(response.body.projects.map((p: { name: string }) => p.name).sort()).toEqual([
      'Finished campaign',
      'Live campaign',
    ]);
    expect(response.body.planHash).toHaveLength(64);
    // Nothing moved, nothing was stamped, and no alias was recorded by a dry run.
    expect(db.prepare('SELECT * FROM projects ORDER BY id').all()).toEqual(before);
    expect(aliases()).toEqual([]);
  });

  it('accepts an archived source and refuses every pair a merge cannot describe', async () => {
    const source = await createClient('Archived Duplicate');
    const destination = await createClient('Surviving Studio');
    await archiveClient(source.id);

    expect((await preview(source.id, destination.id)).status).toBe(200);
    expect((await preview(source.id, source.id)).status).toBe(400);
    expect((await preview(source.id, crypto.randomUUID())).status).toBe(404);
    expect((await preview(crypto.randomUUID(), destination.id)).status).toBe(404);
    // An archived destination would bury the work that was just consolidated.
    await archiveClient(destination.id);
    const refused = await preview(source.id, destination.id);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('Choose an active destination client.');
  });

  it('refuses a source or a destination that has already been merged away', async () => {
    const first = await createClient('First Duplicate');
    const survivor = await createClient('Survivor');
    const other = await createClient('Somewhere Else');
    await mergeClients(first.id, survivor.id);

    const asSource = await preview(first.id, other.id);
    expect(asSource.status).toBe(409);
    expect(asSource.body.error).toContain('already been merged');
    const asDestination = await preview(other.id, first.id);
    expect(asDestination.status).toBe(409);
    expect(asDestination.body.error).toContain('cannot receive one');
  });

  it('hashes the plan over both clients and every source project', async () => {
    const source = await createClient('Hashed Source');
    const destination = await createClient('Hashed Destination');
    await createProject(source.id, 'One');
    const first = (await preview(source.id, destination.id)).body.planHash;

    expect((await preview(source.id, destination.id)).body.planHash).toBe(first);
    await createProject(source.id, 'Two');
    expect((await preview(source.id, destination.id)).body.planHash).not.toBe(first);
  });

  it('plans against the workspace it is given rather than against a database', () => {
    const workspace = {
      clients: [
        { id: 'a', name: 'A', status: 'ARCHIVED' },
        { id: 'b', name: 'B', status: 'ACTIVE' },
      ],
      projects: [
        { id: 'p2', clientId: 'a', name: 'Second', status: 'ACTIVE' },
        { id: 'p1', clientId: 'a', name: 'First', status: 'ARCHIVED' },
        { id: 'p3', clientId: 'b', name: 'Theirs', status: 'ACTIVE' },
      ],
      clientAliases: [
        { namespace: 'campaign-playbook:s2', externalId: 'ext-2', clientId: 'a' },
        { namespace: 'campaign-playbook:s1', externalId: 'ext-1', clientId: 'a' },
        { namespace: 'campaign-playbook:s1', externalId: 'theirs', clientId: 'b' },
      ],
    };

    const plan = buildClientMergePlan(workspace, 'a', 'b');

    // Sorted by id, so the hash does not depend on the order SQLite returned the rows in.
    expect(plan.projects.map((project) => project.id)).toEqual(['p1', 'p2']);
    // The source's identities, sorted the same way, and never the destination's own.
    expect(plan.aliases).toEqual([
      { namespace: 'campaign-playbook:s1', externalId: 'ext-1' },
      { namespace: 'campaign-playbook:s2', externalId: 'ext-2' },
    ]);
    expect(plan.source.status).toBe('ARCHIVED');
    expect(() => buildClientMergePlan(workspace, 'a', 'a')).toThrow(ClientMergeError);
  });
});

describe('committing a client merge', () => {
  it('moves every project and archives the source, preserving the work underneath it', async () => {
    const source = await createClient('Old Acme');
    const destination = await createClient('Acme');
    const moving = await createProject(source.id, 'Rebrand');
    const archivedProject = await createProject(source.id, 'Retired', 'COMPLETE');
    const task = (
      await request(app())
        .post('/api/tasks')
        .send({ projectId: moving.id, title: 'Write the brief', dueDate: '2026-09-01' })
    ).body;
    await request(app()).post(`/api/tasks/${task.id}/checklist`).send({ text: 'Draft it' });
    const category = (await request(app()).post('/api/categories').send({ name: 'Retainer' })).body;
    await request(app())
      .post(`/api/projects/${moving.id}/categories`)
      .send({ categoryId: category.id });
    const beforeStamps = db
      .prepare('SELECT id, position, updated_at, last_activity_at FROM projects ORDER BY id')
      .all();

    const result = await mergeClients(source.id, destination.id);

    expect(result.movedProjectCount).toBe(2);
    expect(
      db
        .prepare('SELECT client_id FROM projects WHERE id IN (?,?)')
        .all(moving.id, archivedProject.id),
    ).toEqual([{ client_id: destination.id }, { client_id: destination.id }]);
    // Ordering and both timestamps are untouched: the work did not change, its owner did.
    expect(
      db
        .prepare('SELECT id, position, updated_at, last_activity_at FROM projects ORDER BY id')
        .all(),
    ).toEqual(beforeStamps);
    const carried = (await request(app()).get(`/api/tasks?projectId=${moving.id}`)).body;
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ id: task.id, title: 'Write the brief' });
    expect(carried[0].checklist).toHaveLength(1);
    expect(
      (await request(app()).get('/api/projects')).body.find(
        (project: { id: string }) => project.id === moving.id,
      ).categories,
    ).toEqual([expect.objectContaining({ name: 'Retainer' })]);
    expect(db.prepare('SELECT status FROM clients WHERE id=?').get(source.id)).toEqual({
      status: 'ARCHIVED',
    });
    expect(aliases()).toEqual([{ source: source.id, surviving: destination.id }]);
  });

  it('keeps the source’s own details readable and lets the destination’s metadata win', async () => {
    const source = (
      await request(app())
        .post('/api/clients')
        .send({ name: 'Duplicate Co', contactName: 'Old Contact', notes: 'Historic notes' })
    ).body;
    const destination = (
      await request(app())
        .post('/api/clients')
        .send({ name: 'Real Co', contactName: 'Current Contact' })
    ).body;

    await mergeClients(source.id, destination.id);

    const clients = listClients(db) as { id: string; contactName?: string; notes?: string }[];
    expect(clients.find((c) => c.id === source.id)).toMatchObject({
      contactName: 'Old Contact',
      notes: 'Historic notes',
    });
    // Nothing was copied across; the destination reads exactly as it did.
    expect(clients.find((c) => c.id === destination.id)).toMatchObject({
      contactName: 'Current Contact',
    });
    expect(clients.find((c) => c.id === destination.id)?.notes).toBeUndefined();
  });

  it('merges a source with no projects, recording the alias all the same', async () => {
    const source = await createClient('Empty Duplicate');
    const destination = await createClient('The Real One');

    const result = await mergeClients(source.id, destination.id);

    expect(result.movedProjectCount).toBe(0);
    expect(aliases()).toEqual([{ source: source.id, surviving: destination.id }]);
  });

  it('refuses a stale confirmation with a 409 and requires another preview', async () => {
    const source = await createClient('Moving Target');
    const destination = await createClient('Steady');
    const project = await createProject(source.id, 'Original name');
    const stale = (await preview(source.id, destination.id)).body.planHash;
    await request(app()).patch(`/api/projects/${project.id}`).send({ name: 'Renamed since' });

    const refused = await merge(source.id, destination.id, stale);

    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('changed since this merge was previewed');
    // Nothing was written by the refusal: the project still belongs to the source.
    expect(db.prepare('SELECT client_id FROM projects WHERE id=?').get(project.id)).toEqual({
      client_id: source.id,
    });
    expect(aliases()).toEqual([]);
    await mergeClients(source.id, destination.id);
    expect(aliases()).toEqual([{ source: source.id, surviving: destination.id }]);
  });

  it('rolls the whole merge back when a write inside it fails', async () => {
    const source = await createClient('Rollback Source');
    const destination = await createClient('Rollback Destination');
    const project = await createProject(source.id, 'Should not move');
    const planHash = previewClientMerge(db, source.id, destination.id).planHash;
    // A second alias row for the same source is exactly what the primary key refuses, so the
    // insert at the end of the merge throws after the projects have already been reassigned.
    db.prepare(
      'INSERT INTO client_merges(source_client_id,surviving_client_id,merged_at) VALUES(?,?,?)',
    ).run(source.id, destination.id, '2026-01-01T00:00:00.000Z');

    expect(() => commitClientMerge(db, source.id, destination.id, planHash)).toThrow();

    expect(db.prepare('SELECT client_id FROM projects WHERE id=?').get(project.id)).toEqual({
      client_id: source.id,
    });
    expect(db.prepare('SELECT status FROM clients WHERE id=?').get(source.id)).toEqual({
      status: 'ACTIVE',
    });
    expect(aliases()).toEqual([{ source: source.id, surviving: destination.id }]);
    expect(
      db.prepare('SELECT merged_at FROM client_merges WHERE source_client_id=?').get(source.id),
    ).toEqual({ merged_at: '2026-01-01T00:00:00.000Z' });
  });

  it('retargets earlier aliases so A→B then B→C leaves A pointing at C', async () => {
    const a = await createClient('Client A');
    const b = await createClient('Client B');
    const c = await createClient('Client C');
    await createProject(a.id, 'A work');

    await mergeClients(a.id, b.id);
    await mergeClients(b.id, c.id);

    expect(aliases().sort((x, y) => x.source.localeCompare(y.source))).toEqual(
      [
        { source: a.id, surviving: c.id },
        { source: b.id, surviving: c.id },
      ].sort((x, y) => x.source.localeCompare(y.source)),
    );
    expect(db.prepare('SELECT client_id FROM projects').all()).toEqual([{ client_id: c.id }]);
  });

  /**
   * C70. An import identity is the other thing that points at a client, and it has to follow the
   * work for the same reason the name alias does: a playbook naming the source by the id it has at
   * its own source must resolve to the client that now holds its projects.
   */
  it('moves every import identity the source carried to the destination, one hop', async () => {
    const source = await createClient('Duplicate Studio');
    const destination = await createClient('Studio');
    const third = await createClient('Studio Group');
    recordIdentity(source.id, 'dupe-1');
    recordIdentity(source.id, 'dupe-2', 'source-b');
    recordIdentity(destination.id, 'kept-1');

    const result = await mergeClients(source.id, destination.id);

    expect(result.aliases).toEqual([
      { namespace: 'campaign-playbook:source-a', externalId: 'dupe-1' },
      { namespace: 'campaign-playbook:source-b', externalId: 'dupe-2' },
    ]);
    expect(importIdentities()).toEqual([
      { ns: 'campaign-playbook:source-a', ext: 'dupe-1', id: destination.id },
      { ns: 'campaign-playbook:source-a', ext: 'kept-1', id: destination.id },
      { ns: 'campaign-playbook:source-b', ext: 'dupe-2', id: destination.id },
    ]);

    // Merging the destination on leaves all three one hop from the client that holds the work.
    await mergeClients(destination.id, third.id);
    expect(importIdentities().map((identity) => identity.id)).toEqual([
      third.id,
      third.id,
      third.id,
    ]);
  });

  it('hashes the identities too, so one attached since the preview refuses the merge', async () => {
    const source = await createClient('Identified Source');
    const destination = await createClient('Identified Destination');
    const stale = (await preview(source.id, destination.id)).body.planHash;

    // A playbook import lands between the preview and the confirmation.
    recordIdentity(source.id, 'arrived-late');

    const refused = await merge(source.id, destination.id, stale);
    expect(refused.status).toBe(409);
    expect(importIdentities()).toEqual([
      { ns: 'campaign-playbook:source-a', ext: 'arrived-late', id: source.id },
    ]);
    // The fresh preview names it, and confirming that one moves it.
    const planned = await preview(source.id, destination.id);
    expect(planned.body.aliases).toEqual([
      { namespace: 'campaign-playbook:source-a', externalId: 'arrived-late' },
    ]);
    expect((await merge(source.id, destination.id, planned.body.planHash)).status).toBe(200);
    expect(importIdentities()[0]!.id).toBe(destination.id);
  });

  it('leaves the identities where they were when the merge rolls back', async () => {
    const source = await createClient('Rollback Identified');
    const destination = await createClient('Rollback Keeper');
    recordIdentity(source.id, 'stays-put');
    const planHash = previewClientMerge(db, source.id, destination.id).planHash;
    // The same trick as the rollback case above: the alias insert at the end cannot succeed.
    db.prepare(
      'INSERT INTO client_merges(source_client_id,surviving_client_id,merged_at) VALUES(?,?,?)',
    ).run(source.id, destination.id, '2026-01-01T00:00:00.000Z');

    expect(() => commitClientMerge(db, source.id, destination.id, planHash)).toThrow();

    expect(importIdentities()).toEqual([
      { ns: 'campaign-playbook:source-a', ext: 'stays-put', id: source.id },
    ]);
  });

  /**
   * The strongest available statement of "no Drive method is called": the merge modules cannot
   * reach one. `driveProvider` is resolved from stored credentials rather than injected, so a
   * mock cannot be put in the merge's path to be observed staying idle — but a module that
   * imports nothing under `server/drive/` has no method to call in the first place, and this
   * fails the moment someone adds the import.
   */
  it('cannot reach Drive at all: neither merge module imports the provider', () => {
    for (const module of ['client-merge.ts', 'domain/client-merge.ts']) {
      const source = readFileSync(new URL(module, import.meta.url), 'utf8');
      expect(source).not.toMatch(/^import[^;]*from '[^']*drive\/[^']*';$/m);
      expect(source).not.toMatch(/driveProvider\s*\(/);
    }
  });

  it('leaves every Drive reference on the projects that carry it', async () => {
    const source = await createClient('Drive Source');
    const destination = await createClient('Drive Destination');
    const project = await createProject(source.id, 'Has a folder');
    db.prepare(
      'UPDATE projects SET drive_folder_id=?, drive_folder_url=?, drive_status=? WHERE id=?',
    ).run('folder-1', 'https://drive.test/folder-1', 'CONNECTED', project.id);
    db.prepare('UPDATE clients SET drive_folder_id=?, drive_status=? WHERE id=?').run(
      'client-folder-1',
      'CONNECTED',
      source.id,
    );
    db.prepare(
      `INSERT INTO drive_steps(entity_type,entity_id,step_key,folder_id,folder_url,created_at)
       VALUES('project',?,'01_Admin','step-1','https://drive.test/step-1',?)`,
    ).run(project.id, '2026-01-01T00:00:00.000Z');

    await mergeClients(source.id, destination.id);

    // Files still opens the same folders, and the source client's own folder stays where it is.
    expect(
      db
        .prepare(
          'SELECT drive_folder_id id, drive_folder_url url, drive_status status FROM projects WHERE id=?',
        )
        .get(project.id),
    ).toEqual({
      id: 'folder-1',
      url: 'https://drive.test/folder-1',
      status: 'CONNECTED',
    });
    expect(
      db
        .prepare("SELECT step_key FROM drive_steps WHERE entity_type='project' AND entity_id=?")
        .all(project.id),
    ).toEqual([{ step_key: '01_Admin' }]);
    expect(
      db
        .prepare('SELECT drive_folder_id id, drive_status status FROM clients WHERE id=?')
        .get(source.id),
    ).toEqual({ id: 'client-folder-1', status: 'CONNECTED' });
    // A merge is local workspace surgery, not an integration, so it writes no activity row.
    expect(db.prepare('SELECT COUNT(*) total FROM integration_events').get()).toEqual({ total: 0 });
  });

  it('reports the merge on the source client through the API', async () => {
    const source = await createClient('Reported Source');
    const destination = await createClient('Reported Survivor');
    await mergeClients(source.id, destination.id);

    const listed = (await request(app()).get('/api/clients')).body as {
      id: string;
      mergedInto?: { id: string; name: string; mergedAt: string };
    }[];

    expect(listed.find((client) => client.id === source.id)?.mergedInto).toMatchObject({
      id: destination.id,
      name: 'Reported Survivor',
    });
    expect(listed.find((client) => client.id === destination.id)?.mergedInto).toBeUndefined();
    // The survivor's live name, not a snapshot of it.
    await request(app()).patch(`/api/clients/${destination.id}`).send({ name: 'Renamed Survivor' });
    const relisted = (await request(app()).get('/api/clients')).body as {
      id: string;
      mergedInto?: { name: string };
    }[];
    expect(relisted.find((client) => client.id === source.id)?.mergedInto?.name).toBe(
      'Renamed Survivor',
    );
  });

  it('reads the merge workspace with archived records and aliases included', async () => {
    const source = await createClient('Workspace Source');
    const destination = await createClient('Workspace Destination');
    await archiveClient(source.id);
    await createProject(destination.id, 'Theirs');
    await mergeClients(source.id, destination.id);

    const workspace = readMergeWorkspace(db);

    expect(workspace.clients.find((client) => client.id === source.id)).toEqual({
      id: source.id,
      name: 'Workspace Source',
      status: 'ARCHIVED',
      mergedIntoId: destination.id,
    });
    expect(workspace.clients.find((client) => client.id === destination.id)).toEqual({
      id: destination.id,
      name: 'Workspace Destination',
      status: 'ACTIVE',
    });
  });
});

describe('the guards a merge puts on other routes', () => {
  it('refuses to unarchive a merged client and still unarchives an ordinary one', async () => {
    const merged = await createClient('Merged Away');
    const survivor = await createClient('Survivor');
    const ordinary = await createClient('Just Archived');
    await archiveClient(ordinary.id);
    await mergeClients(merged.id, survivor.id);

    const refused = await request(app()).post(`/api/clients/${merged.id}/unarchive`).send();

    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CLIENT_MERGED');
    expect(db.prepare('SELECT status FROM clients WHERE id=?').get(merged.id)).toEqual({
      status: 'ARCHIVED',
    });
    expect((await request(app()).post(`/api/clients/${ordinary.id}/unarchive`).send()).status).toBe(
      200,
    );
  });

  it('refuses a project PATCH that would hand work back to a merged or inactive client', async () => {
    const merged = await createClient('Emptied Client');
    const survivor = await createClient('Owning Client');
    const archived = await createClient('Archived Client');
    const project = await createProject(merged.id, 'Moved by the merge');
    await archiveClient(archived.id);
    await mergeClients(merged.id, survivor.id);

    const toMerged = await request(app())
      .patch(`/api/projects/${project.id}`)
      .send({ clientId: merged.id });
    expect(toMerged.status).toBe(409);
    expect(toMerged.body.code).toBe('CLIENT_MERGED');
    const toArchived = await request(app())
      .patch(`/api/projects/${project.id}`)
      .send({ clientId: archived.id });
    expect(toArchived.status).toBe(400);
    expect(toArchived.body.error).toBe('Choose an active client.');
    // The merge stands, and an edit that names no client is unaffected.
    expect(db.prepare('SELECT client_id FROM projects WHERE id=?').get(project.id)).toEqual({
      client_id: survivor.id,
    });
    expect(
      (await request(app()).patch(`/api/projects/${project.id}`).send({ name: 'Renamed' })).status,
    ).toBe(200);
  });

  it('validates the merge request body itself', async () => {
    const source = await createClient('Validated Source');
    const destination = await createClient('Validated Destination');

    expect(
      (await request(app()).post(`/api/clients/${source.id}/merge/preview`).send({})).status,
    ).toBe(400);
    expect((await merge(source.id, destination.id, 'too-short')).status).toBe(400);
  });
});
