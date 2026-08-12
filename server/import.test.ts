import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';
import { createDb, type Db } from './db.ts';
import { commitPlaybook, listReceipts, previewPlaybook, readWorkspace } from './import.ts';
import { buildXlsx } from './domain/workbook-fixture.ts';
import { IMPORT_RECEIPT_LIMIT } from '../shared/playbook.ts';

const SAMPLE = path.join(
  import.meta.dirname,
  '../docs/examples/campaign-playbook-import-format.xlsx',
);

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const CLIENT_HEADER = 'client_key\tname\tcontact_name\temail\tphone\twebsite\tnotes';
const PROJECT_HEADER =
  'project_key\tclient_key\tname\tstatus\tpriority\tstart_date\ttarget_deadline\tdescription\tnotes\tposition';
const TASK_HEADER =
  'task_key\tproject_key\ttitle\ttask_type\tstatus\tpriority\tstart_date\tdue_date\tdescription\tnotes\tposition';

/** The pasted form of a two-task playbook, which every case here varies. */
const playbookText = ({
  client = 'Acme Studio',
  project = 'Spring Campaign',
  tasks = [
    'TSK-1\tPRJ-A\tWeek 1 blog post\tBLOG_POST\tTODO\tHIGH\t\t2026-03-02',
    'TSK-2\tPRJ-A\tWeek 1 social set\t\tBACKLOG\tMEDIUM',
  ],
  checklist = ['TSK-1\t1\tDraft the post\tTRUE', 'TSK-1\t2\tEdit for clarity\tFALSE'],
  dependencies = ['TSK-2\tTSK-1'],
}: {
  client?: string;
  project?: string;
  tasks?: string[];
  checklist?: string[];
  dependencies?: string[];
} = {}) =>
  [
    '[Clients]',
    CLIENT_HEADER,
    `CLI-A\t${client}\tDana Holmes\tdana@example.com\t\thttps://example.com\tRetainer`,
    '[Projects]',
    PROJECT_HEADER,
    `PRJ-A\tCLI-A\t${project}\tACTIVE\tHIGH\t2026-03-01\t2026-04-30\tSix weeks\t\t1`,
    '[Tasks]',
    TASK_HEADER,
    ...tasks,
    '[ChecklistItems]',
    'task_key\titem_order\ttitle\tcompleted',
    ...checklist,
    '[Dependencies]',
    'task_key\tprerequisite_task_key',
    ...dependencies,
  ].join('\n');

const counts = () => ({
  clients: (db.prepare('SELECT COUNT(*) n FROM clients').get() as { n: number }).n,
  projects: (db.prepare('SELECT COUNT(*) n FROM projects').get() as { n: number }).n,
  tasks: (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n,
  checklist: (db.prepare('SELECT COUNT(*) n FROM checklist_items').get() as { n: number }).n,
  dependencies: (db.prepare('SELECT COUNT(*) n FROM task_dependencies').get() as { n: number }).n,
});

describe('campaign playbook import', () => {
  it('previews a pasted playbook without writing anything', async () => {
    const response = await request(createApp(db))
      .post('/api/import/playbook/preview')
      .send({ text: playbookText() });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.creates).toEqual({
      Clients: 1,
      Projects: 1,
      Tasks: 2,
      ChecklistItems: 2,
      Dependencies: 1,
    });
    expect(response.body.duplicateRule.length).toBeGreaterThan(0);
    expect(response.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(counts()).toEqual({
      clients: 0,
      projects: 0,
      tasks: 0,
      checklist: 0,
      dependencies: 0,
    });
    expect(listReceipts(db)).toEqual([]);
  });

  it('commits exactly what the preview promised, in the shape the app stores', async () => {
    const app = createApp(db);
    const preview = (
      await request(app).post('/api/import/playbook/preview').send({ text: playbookText() })
    ).body;
    const response = await request(app)
      .post('/api/import/playbook')
      .send({ text: playbookText(), fingerprint: preview.fingerprint });
    expect(response.status).toBe(201);
    expect(response.body.receipt.outcome).toBe('COMMITTED');
    expect(response.body.receipt.creates).toEqual(preview.creates);
    expect(response.body.receipt.createdCount).toBe(7);
    expect(counts()).toEqual({
      clients: 1,
      projects: 1,
      tasks: 2,
      checklist: 2,
      dependencies: 1,
    });

    const client = db.prepare('SELECT * FROM clients').get() as Record<string, unknown>;
    expect(client).toMatchObject({
      name: 'Acme Studio',
      contact_name: 'Dana Holmes',
      email: 'dana@example.com',
      phone: null,
      website: 'https://example.com',
      status: 'ACTIVE',
      // No Drive call is made and none is queued: a later Settings sync provisions these.
      drive_status: 'DISCONNECTED',
    });
    expect(client.slug).toMatch(/^acme-studio-[0-9a-f]{6}$/);
    const project = db.prepare('SELECT * FROM projects').get() as Record<string, unknown>;
    expect(project).toMatchObject({
      name: 'Spring Campaign',
      status: 'ACTIVE',
      priority: 'HIGH',
      start_date: '2026-03-01',
      target_deadline: '2026-04-30',
      position: 0,
      drive_status: 'DISCONNECTED',
    });
    expect(project.last_activity_at).toBe(project.created_at);
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY title').all() as Record<
      string,
      unknown
    >[];
    expect(tasks.map((task) => [task.title, task.status, task.task_type, task.due_date])).toEqual([
      ['Week 1 blog post', 'TODO', 'BLOG_POST', '2026-03-02'],
      ['Week 1 social set', 'BACKLOG', null, null],
    ]);
    // The workbook authored this task's checklist, so the BLOG_POST template does not seed a
    // second one on top of it.
    const authored = db
      .prepare(
        'SELECT text, completed, position FROM checklist_items WHERE task_id=? ORDER BY position',
      )
      .all(String(tasks[0].id)) as { text: string; completed: number; position: number }[];
    expect(authored).toEqual([
      { text: 'Draft the post', completed: 1, position: 0 },
      { text: 'Edit for clarity', completed: 0, position: 1 },
    ]);
    expect(db.prepare('SELECT * FROM drive_steps').all()).toEqual([]);
  });

  it('seeds a task type template only for a task the workbook left without a checklist', () => {
    commitPlaybook(db, {
      text: playbookText({
        tasks: ['TSK-1\tPRJ-A\tWeek 1 video\tVIDEO\tTODO\tHIGH'],
        checklist: [],
        dependencies: [],
      }),
    });
    const items = db.prepare('SELECT text FROM checklist_items ORDER BY position').all() as {
      text: string;
    }[];
    expect(items.map((item) => item.text)).toEqual([
      'Draft the script',
      'Build the storyboard',
      'Create InstaDoodle illustrations',
      'Animate the segment',
      'Verify publish links',
    ]);
  });

  it('stamps a COMPLETE task as completed at the moment it was confirmed', () => {
    commitPlaybook(db, {
      text: playbookText({
        tasks: ['TSK-1\tPRJ-A\tAlready done\t\tCOMPLETE\tHIGH'],
        checklist: [],
        dependencies: [],
      }),
    });
    const task = db.prepare('SELECT status, completed_at FROM tasks').get() as {
      status: string;
      completed_at: string | null;
    };
    expect(task.status).toBe('COMPLETE');
    expect(task.completed_at).toBeTruthy();
  });

  it('imports the committed sample workbook from an uploaded file', async () => {
    const response = await request(createApp(db))
      .post('/api/import/playbook')
      .send({
        filename: 'campaign-playbook-import-format.xlsx',
        contentBase64: fs.readFileSync(SAMPLE).toString('base64'),
      });
    expect(response.status).toBe(201);
    expect(response.body.receipt).toMatchObject({
      outcome: 'COMMITTED',
      inputKind: 'xlsx',
      filename: 'campaign-playbook-import-format.xlsx',
      createdCount: 2 + 2 + 64 + 151 + 25,
    });
    expect(counts()).toEqual({
      clients: 2,
      projects: 2,
      tasks: 64,
      checklist: 151,
      dependencies: 25,
    });
  });

  describe('a malformed playbook', () => {
    it('is refused with per-row reasons and writes nothing', async () => {
      const app = createApp(db);
      const text = playbookText({
        tasks: ['TSK-1\tPRJ-MISSING\tOrphan\t\tnope\tHIGH\t\t2026-02-30'],
        checklist: [],
        dependencies: [],
      });
      const preview = (await request(app).post('/api/import/playbook/preview').send({ text })).body;
      expect(preview.ok).toBe(false);
      expect(preview.failures.Tasks).toBe(1);
      expect(preview.issues.map((issue: { message: string }) => issue.message)).toEqual(
        expect.arrayContaining([
          'status: expected one of BACKLOG, TODO, IN_PROGRESS, REVIEW, COMPLETE.',
          'due_date: that is not a real calendar date.',
        ]),
      );

      const response = await request(app).post('/api/import/playbook').send({ text });
      expect(response.status).toBe(409);
      expect(response.body.receipt.outcome).toBe('REJECTED');
      expect(response.body.receipt.failedCount).toBe(1);
      expect(response.body.receipt.issues.length).toBeGreaterThan(0);
      expect(counts()).toEqual({
        clients: 0,
        projects: 0,
        tasks: 0,
        checklist: 0,
        dependencies: 0,
      });
      // The refusal is still recorded, which is what makes a rejected import diagnosable.
      expect(listReceipts(db).map((receipt) => receipt.outcome)).toEqual(['REJECTED']);
    });

    it('answers 400 for a file that is not a workbook at all', async () => {
      const response = await request(createApp(db))
        .post('/api/import/playbook/preview')
        .send({ contentBase64: Buffer.from('client_key,name\nCLI-A,Acme').toString('base64') });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not an .xlsx workbook/);
    });

    it('accepts a workbook larger than the general 1 MB body limit', async () => {
      // Not a workbook, so the answer is a 400 about the file — the point is that it is not a
      // 413 about the body. The general parser and the import parser have different limits, and
      // which one applies depends on the order they are registered in.
      const response = await request(createApp(db))
        .post('/api/import/playbook/preview')
        .send({ contentBase64: 'A'.repeat(2_000_000) });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not an .xlsx workbook/);
    });

    it('answers 400 when neither a file nor text is provided, or both are', async () => {
      const app = createApp(db);
      expect((await request(app).post('/api/import/playbook/preview').send({})).status).toBe(400);
      expect(
        (
          await request(app)
            .post('/api/import/playbook/preview')
            .send({ text: playbookText(), contentBase64: 'AAAA' })
        ).status,
      ).toBe(400);
    });

    it('refuses to commit a playbook that changed since it was previewed', async () => {
      const app = createApp(db);
      const preview = (
        await request(app).post('/api/import/playbook/preview').send({ text: playbookText() })
      ).body;
      const response = await request(app)
        .post('/api/import/playbook')
        .send({
          text: playbookText({ client: 'A Different Studio' }),
          fingerprint: preview.fingerprint,
        });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/changed since it was previewed/);
      expect(counts().clients).toBe(0);
    });
  });

  describe('importing the same playbook twice', () => {
    it('creates nothing the second time and says why for every row', () => {
      commitPlaybook(db, { text: playbookText() });
      const first = counts();
      const { receipt, preview } = commitPlaybook(db, { text: playbookText() });
      expect(receipt.outcome).toBe('COMMITTED');
      expect(receipt.createdCount).toBe(0);
      expect(receipt.skippedCount).toBe(7);
      expect(counts()).toEqual(first);
      expect(preview.skipped.map((skip) => [skip.sheet, skip.reason])).toEqual([
        ['Clients', 'A client with this name already exists; the import will use it.'],
        ['Projects', 'This client already has a project with this name.'],
        ['Tasks', 'This project already has a task with this title and due date.'],
        ['Tasks', 'This project already has a task with this title and due date.'],
        ['ChecklistItems', 'Its task already exists, so its checklist is left as it is.'],
        ['ChecklistItems', 'Its task already exists, so its checklist is left as it is.'],
        ['Dependencies', 'Both tasks already have this dependency.'],
      ]);
    });

    it('adds only the rows a second, extended playbook actually introduces', () => {
      commitPlaybook(db, { text: playbookText() });
      const { receipt } = commitPlaybook(db, {
        text: playbookText({
          tasks: [
            'TSK-1\tPRJ-A\tWeek 1 blog post\tBLOG_POST\tTODO\tHIGH\t\t2026-03-02',
            'TSK-2\tPRJ-A\tWeek 1 social set\t\tBACKLOG\tMEDIUM',
            'TSK-3\tPRJ-A\tWeek 2 blog post\tBLOG_POST\tTODO\tHIGH\t\t2026-03-09',
          ],
        }),
      });
      expect(receipt.creates).toEqual({
        Clients: 0,
        Projects: 0,
        Tasks: 1,
        ChecklistItems: 0,
        Dependencies: 0,
      });
      expect(counts().tasks).toBe(3);
      // The new task lands under the client and project the first import created.
      expect(db.prepare('SELECT COUNT(*) n FROM projects').get()).toEqual({ n: 1 });
    });

    it('matches an archived client rather than creating a live twin of it', () => {
      commitPlaybook(db, { text: playbookText() });
      db.prepare("UPDATE clients SET status='ARCHIVED'").run();
      db.prepare("UPDATE projects SET status='ARCHIVED'").run();
      const { receipt } = commitPlaybook(db, { text: playbookText() });
      expect(receipt.createdCount).toBe(0);
      expect(counts().clients).toBe(1);
      expect((db.prepare('SELECT status FROM clients').get() as { status: string }).status).toBe(
        'ARCHIVED',
      );
    });
  });

  it('moves the activity of a project it adds work to, and leaves its edit stamp alone', async () => {
    const app = createApp(db);
    const client = (await request(app).post('/api/clients').send({ name: 'Acme Studio' })).body;
    const project = (
      await request(app)
        .post('/api/projects')
        .send({ clientId: client.id, name: 'Spring Campaign' })
    ).body;
    const backdated = '2020-01-01T00:00:00.000Z';
    db.prepare('UPDATE projects SET updated_at=?, last_activity_at=? WHERE id=?').run(
      backdated,
      backdated,
      project.id,
    );

    const { receipt } = commitPlaybook(db, { text: playbookText() });
    expect(receipt.creates.Projects).toBe(0);
    expect(receipt.creates.Tasks).toBe(2);
    const stamps = db
      .prepare(
        'SELECT updated_at updatedAt, last_activity_at lastActivityAt FROM projects WHERE id=?',
      )
      .get(project.id) as { updatedAt: string; lastActivityAt: string };
    expect(stamps.updatedAt).toBe(backdated);
    expect(stamps.lastActivityAt > backdated).toBe(true);
  });

  it('leaves the database exactly as it was when a write fails part way through', () => {
    // A trigger is the only honest way to fail mid-import: it aborts a real statement after
    // earlier ones in the same transaction have already succeeded.
    db.exec(`CREATE TRIGGER refuse_second_task BEFORE INSERT ON tasks
             WHEN (SELECT COUNT(*) FROM tasks) >= 1
             BEGIN SELECT RAISE(ABORT, 'disk is on fire'); END`);
    expect(() => commitPlaybook(db, { text: playbookText() })).toThrow(/disk is on fire/);
    expect(counts()).toEqual({
      clients: 0,
      projects: 0,
      tasks: 0,
      checklist: 0,
      dependencies: 0,
    });
    const [receipt] = listReceipts(db);
    expect(receipt).toMatchObject({ outcome: 'FAILED', createdCount: 0 });
    expect(receipt.error).toMatch(/disk is on fire/);
  });

  describe('receipts', () => {
    it('are retrievable after the modal that made them is long gone', async () => {
      const app = createApp(db);
      const commit = await request(app)
        .post('/api/import/playbook')
        .send({ text: playbookText(), filename: 'spring.xlsx' });
      const id = commit.body.receipt.id;

      const list = await request(app).get('/api/import/receipts');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0]).toMatchObject({
        id,
        source: 'campaign-playbook',
        inputKind: 'text',
        filename: 'spring.xlsx',
        outcome: 'COMMITTED',
        createdCount: 7,
      });

      const one = await request(app).get(`/api/import/receipts/${id}`);
      expect(one.status).toBe(200);
      expect(one.body.created).toHaveLength(7);
      expect(one.body.created[0]).toMatchObject({ sheet: 'Clients', label: 'Acme Studio' });
      expect((await request(app).get('/api/import/receipts/not-a-receipt')).status).toBe(404);
    });

    it('keep the newest and prune the rest, so the table cannot grow without a bound', () => {
      for (let index = 0; index < IMPORT_RECEIPT_LIMIT + 3; index++)
        commitPlaybook(db, {
          text: playbookText({ client: `Studio ${index}`, project: `Campaign ${index}` }),
        });
      const receipts = listReceipts(db, 200);
      expect(receipts).toHaveLength(IMPORT_RECEIPT_LIMIT);
      expect(receipts[0].createdCount).toBe(7);
    });
  });

  it('reads the workspace the duplicate rule compares against, archived rows included', async () => {
    const app = createApp(db);
    const client = (await request(app).post('/api/clients').send({ name: 'Acme Studio' })).body;
    await request(app).post('/api/projects').send({ clientId: client.id, name: 'Spring Campaign' });
    await request(app).post('/api/clients/' + client.id + '/archive');
    const workspace = readWorkspace(db);
    expect(workspace.clients).toEqual([{ id: client.id, name: 'Acme Studio' }]);
    expect(workspace.projects[0]).toMatchObject({ clientId: client.id, name: 'Spring Campaign' });
    expect(workspace.projectPosition).toBe(0);
  });

  it('previews against the workspace as it stands, not as it was', () => {
    const before = previewPlaybook(db, { text: playbookText() });
    expect(before.creates.Clients).toBe(1);
    commitPlaybook(db, { text: playbookText() });
    const after = previewPlaybook(db, { text: playbookText() });
    expect(after.creates.Clients).toBe(0);
    expect(after.skips.Clients).toBe(1);
    expect(after.ok).toBe(true);
  });

  it('refuses a workbook whose tabs are not the format, without touching the database', async () => {
    const response = await request(createApp(db))
      .post('/api/import/playbook')
      .send({ contentBase64: buildXlsx({ Campaigns: [['name'], ['Spring']] }).toString('base64') });
    expect(response.status).toBe(409);
    expect(response.body.preview.issues[0].message).toMatch(/not part of the format/);
    expect(counts().clients).toBe(0);
  });
});
