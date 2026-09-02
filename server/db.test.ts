import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyAdditiveMigrations,
  backfillProjectActivity,
  createDb,
  getStoreId,
  type Db,
} from './db.ts';

/**
 * A database shaped like an earlier release: `projects` and `tasks` are missing
 * columns the current schema declares, and the tables added later are absent
 * altogether. `tasks.due_date` is missing on purpose — `idx_tasks_due_open`
 * indexes it, so a fresh boot has to add the column before creating the index.
 */
const legacySchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, contact_name TEXT, email TEXT,
  phone TEXT, website TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', drive_folder_id TEXT,
  drive_folder_url TEXT, drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', drive_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', priority TEXT NOT NULL DEFAULT 'MEDIUM',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'BACKLOG', priority TEXT NOT NULL DEFAULT 'MEDIUM',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const NOW = '2026-08-11T12:00:00.000Z';

let directory: string;
const open: Db[] = [];

const track = (db: Db) => {
  open.push(db);
  return db;
};

const scratch = (name: string) => path.join(directory, name);

const rows = <T>(db: Db, sql: string) => db.prepare(sql).all() as unknown as T[];

const children: ChildProcess[] = [];

const columnsOf = (db: Db, table: string) =>
  rows<{ name: string }>(db, `PRAGMA table_info(${table})`).map((column) => column.name);

/** Builds a file-backed database holding real records in the older shape. */
function seedLegacyDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec(legacySchema);
  db.prepare(
    `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
     VALUES ('c1', 'Acme Studio', 'acme-studio', 'ACTIVE', 'DISCONNECTED', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO projects (id, client_id, name, status, priority, created_at, updated_at)
     VALUES ('p1', 'c1', 'Identity System', 'ACTIVE', 'HIGH', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at)
     VALUES ('t1', 'p1', 'Build concepts', 'TODO', 'HIGH', ?, ?)`,
  ).run(NOW, NOW);
  db.close();
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-db-'));
});

afterEach(() => {
  while (children.length) children.pop()?.kill();
  while (open.length) open.pop()?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('database connection durability', () => {
  it('uses WAL for fresh and existing file-backed databases', () => {
    const file = scratch('durable.db');
    const fresh = track(createDb(file));
    expect(rows<{ journal_mode: string }>(fresh, 'PRAGMA journal_mode')).toEqual([
      { journal_mode: 'wal' },
    ]);
    fresh.close();
    open.pop();

    const existing = new DatabaseSync(file);
    existing.exec('PRAGMA journal_mode = DELETE');
    existing.close();
    const reopened = track(createDb(file));
    expect(rows<{ journal_mode: string }>(reopened, 'PRAGMA journal_mode')).toEqual([
      { journal_mode: 'wal' },
    ]);
  });

  it('waits for a concurrent writer instead of failing immediately', async () => {
    const file = scratch('contended.db');
    const writer = track(createDb(file));
    writer.exec('CREATE TABLE contention (id INTEGER PRIMARY KEY)');

    const lockHolder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { DatabaseSync } from 'node:sqlite';
         const db = new DatabaseSync(process.argv[1]);
         db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
         process.stdout.write('locked\\n');
         setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(lockHolder);
    await once(lockHolder.stdout!, 'data');

    const started = Date.now();
    writer.prepare('INSERT INTO contention DEFAULT VALUES').run();
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(rows<{ total: number }>(writer, 'SELECT COUNT(*) AS total FROM contention')).toEqual([
      { total: 1 },
    ]);
    await once(lockHolder, 'exit');
    children.pop();
  });

  it('keeps one store_id across a restart on the same file (#410)', () => {
    const file = scratch('durable.db');
    const first = track(createDb(file));
    const mintedId = getStoreId(first);
    expect(mintedId.length).toBeGreaterThan(0);
    first.close();
    open.pop();

    const reopened = track(createDb(file));
    expect(getStoreId(reopened)).toBe(mintedId);
  });

  it('mints independent store_ids for independent files (#410)', () => {
    const a = track(createDb(scratch('store-a.db')));
    const b = track(createDb(scratch('store-b.db')));
    expect(getStoreId(a)).not.toBe(getStoreId(b));
  });
});

describe('additive schema migration', () => {
  it('adds the missing columns to a database holding real records', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);

    const applied: string[] = [];
    const db = track(createDb(file, (statements) => applied.push(...statements)));

    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((statement) => statement.startsWith('ALTER TABLE '))).toBe(true);
    expect(columnsOf(db, 'clients')).toEqual(
      expect.arrayContaining(['branding_logo_url', 'branding_color_one', 'branding_color_two']),
    );
    expect(columnsOf(db, 'projects')).toEqual(
      expect.arrayContaining([
        'start_date',
        'target_deadline',
        'notes',
        'position',
        'drive_folder_id',
        'drive_folder_url',
        'drive_status',
        'drive_error',
        'last_activity_at',
      ]),
    );
    expect(columnsOf(db, 'tasks')).toEqual(
      expect.arrayContaining([
        'task_type',
        'due_date',
        'start_date',
        'notes',
        'position',
        'completed_at',
      ]),
    );
  });

  it('preserves existing rows and fills new columns from their defaults', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    expect(rows(db, 'SELECT id, title, status, priority FROM tasks')).toEqual([
      { id: 't1', title: 'Build concepts', status: 'TODO', priority: 'HIGH' },
    ]);
    expect(
      rows(db, 'SELECT position, task_type, due_date, notes, completed_at FROM tasks'),
    ).toEqual([{ position: 0, task_type: null, due_date: null, notes: null, completed_at: null }]);
    expect(rows(db, 'SELECT position, drive_status, drive_error FROM projects')).toEqual([
      { position: 0, drive_status: 'DISCONNECTED', drive_error: null },
    ]);
    expect(
      rows(db, 'SELECT branding_logo_url, branding_color_one, branding_color_two FROM clients'),
    ).toEqual([{ branding_logo_url: null, branding_color_one: null, branding_color_two: null }]);
  });

  it('creates the tables an older database never had', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    const tables = rows<{ name: string }>(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    ).map((table) => table.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'checklist_items',
        'task_dependencies',
        'tags',
        'task_tags',
        'categories',
        'project_categories',
        'settings',
        'operator_sessions',
        'agent_registrations',
        'agent_credentials',
        'drive_steps',
        'import_receipts',
        'integration_events',
        'signal_publications',
        'signal_publication_targets',
        'signal_alert_acks',
        'signal_post_metrics',
        'signal_post_metric_days',
        'signal_campaigns',
        'signal_post_campaigns',
        'client_merges',
        'client_import_aliases',
        'signal_post_import_aliases',
        'agent_handoffs',
        'agent_handoff_notes',
        'agent_handoff_mutations',
        'mcp_agent_events',
        'mcp_change_feed',
      ]),
    );
    // The integration activity log arrives empty: a migration invents no history.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM integration_events')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_publications')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_publication_targets')).toEqual([
      { total: 0 },
    ]);
    // Merge aliases arrive empty too: an upgrade never claims a client was merged.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM client_merges')).toEqual([{ total: 0 }]);
    // And no client arrives with an import identity: which client a source calls what is something
    // only a playbook carrying that pair can say, so a migration has nothing to fill this from.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM client_import_aliases')).toEqual([{ total: 0 }]);
    // A migration cannot infer a stable outside identity from copy or schedule, so post aliases
    // also arrive empty rather than claiming a weak fallback as permanent identity.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_post_import_aliases')).toEqual([
      { total: 0 },
    ]);
    // And no alert is acknowledged on arrival: the summary is derived, so an upgrade cannot know
    // which of the lines it is about to show have already been seen.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_alert_acks')).toEqual([{ total: 0 }]);
    // Agent handoffs arrive empty: a migration invents no coordination history.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM agent_handoffs')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM agent_handoff_notes')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM agent_handoff_mutations')).toEqual([
      { total: 0 },
    ]);
    // MCP audit arrives empty: a migration invents no agent tool history.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM mcp_agent_events')).toEqual([{ total: 0 }]);
    // Change feeds arrive empty: a migration invents no missed-work history.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM mcp_change_feed')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT id FROM agent_registrations')).toEqual([
      { id: 'operator-session-bootstrap' },
    ]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM agent_credentials')).toEqual([{ total: 0 }]);
    // Figures arrive empty as well, and the delivery rows gain the provider result identity as a
    // nullable column: a migration cannot know what the provider called a delivery it never asked
    // about, and inventing an id would be inventing something to ask analytics for.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_post_metrics')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_post_metric_days')).toEqual([
      { total: 0 },
    ]);
    expect(columnsOf(db, 'signal_publication_targets')).toContain('post_result_id');
    // The campaign vocabulary arrives empty on a database that had no Signal posts to convert, and
    // the frozen free-text column is still on the table: it is kept rather than dropped, so what a
    // post used to say stays readable beside what it now belongs to.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_campaigns')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_post_campaigns')).toEqual([{ total: 0 }]);
    expect(columnsOf(db, 'signal_posts')).toContain('campaign');
  });

  it('adds the media join to a populated Signal database without changing existing posts', () => {
    const file = scratch('signal-before-media.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE signal_posts (
        id TEXT PRIMARY KEY, text TEXT NOT NULL, date TEXT, time TEXT NOT NULL DEFAULT '09:00',
        format TEXT NOT NULL DEFAULT 'TEXT', status TEXT NOT NULL DEFAULT 'DRAFT', campaign TEXT,
        cta TEXT NOT NULL DEFAULT 'NONE', position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE signal_post_channels (
        post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, PRIMARY KEY(post_id, channel)
      );
      INSERT INTO signal_posts
        (id, text, date, time, format, status, campaign, cta, position, created_at, updated_at)
      VALUES
        ('s1', 'Existing campaign post', '2026-09-14', '09:00', 'IMAGE', 'SCHEDULED',
         'Week 1', 'SOFT', 0, '${NOW}', '${NOW}');
      INSERT INTO signal_post_channels(post_id, channel) VALUES('s1', 'ig');
    `);
    legacy.close();

    const db = track(createDb(file));
    expect(rows(db, 'SELECT id, text, date FROM signal_posts')).toEqual([
      { id: 's1', text: 'Existing campaign post', date: '2026-09-14' },
    ]);
    expect(rows(db, 'SELECT post_id, channel FROM signal_post_channels')).toEqual([
      { post_id: 's1', channel: 'ig' },
    ]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM signal_post_media')).toEqual([{ total: 0 }]);
    // The post's free-text campaign arrives as a campaign row and a join, on boot, without the
    // column being touched: opening the file is the whole of the migration.
    expect(rows(db, 'SELECT name FROM signal_campaigns')).toEqual([{ name: 'Week 1' }]);
    expect(
      rows(
        db,
        `SELECT p.post_id, c.name FROM signal_post_campaigns p
           JOIN signal_campaigns c ON c.id = p.campaign_id`,
      ),
    ).toEqual([{ post_id: 's1', name: 'Week 1' }]);
    expect(rows(db, 'SELECT campaign FROM signal_posts')).toEqual([{ campaign: 'Week 1' }]);
    expect(rows(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('opens an existing database with every project intact and uncategorized', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    // The categories tables arrive empty: nothing invents a category for existing work,
    // and no project row is rewritten to make room for one.
    expect(rows(db, 'SELECT id, name FROM projects')).toEqual([
      { id: 'p1', name: 'Identity System' },
    ]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM categories')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM project_categories')).toEqual([{ total: 0 }]);
  });

  it('drops a project’s category links when the project is deleted, keeping the categories', () => {
    const db = track(createDb(scratch('cascade.db')));
    db.exec(`
      INSERT INTO clients (id, name, slug, created_at, updated_at)
        VALUES ('c1', 'Acme', 'acme', '${NOW}', '${NOW}');
      INSERT INTO projects (id, client_id, name, created_at, updated_at)
        VALUES ('p1', 'c1', 'Identity System', '${NOW}', '${NOW}');
      INSERT INTO categories (id, name) VALUES ('k1', 'Retainer');
      INSERT INTO project_categories (project_id, category_id) VALUES ('p1', 'k1');
    `);

    db.prepare('DELETE FROM projects WHERE id=?').run('p1');

    // The join cascades on its own, so no endpoint has to remember to clear it.
    expect(rows(db, 'SELECT COUNT(*) AS total FROM project_categories')).toEqual([{ total: 0 }]);
    expect(rows(db, 'SELECT name FROM categories')).toEqual([{ name: 'Retainer' }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('keeps category names unique regardless of capitalisation', () => {
    const db = track(createDb(scratch('unique.db')));
    db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('k1', 'Retainer');

    expect(() =>
      db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run('k2', 'retainer'),
    ).toThrow(/UNIQUE/i);
  });

  /**
   * C70. The uniqueness is on the source and the external id alone, which is what makes "an import
   * never silently retargets an established identity" a property of the schema rather than a rule
   * the importer has to remember: there is no second row for one identity to be moved into.
   */
  it('lets one client hold several import identities and one identity only one client', () => {
    const db = track(createDb(scratch('identities.db')));
    const client = (id: string, name: string) =>
      db
        .prepare(
          `INSERT INTO clients (id, name, slug, created_at, updated_at)
           VALUES (?, ?, ?, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z')`,
        )
        .run(id, name, name.toLowerCase());
    const identity = (namespace: string, externalId: string, clientId: string) =>
      db
        .prepare(
          `INSERT INTO client_import_aliases (source_namespace, external_id, client_id, created_at)
           VALUES (?, ?, ?, '2026-08-19T00:00:00.000Z')`,
        )
        .run(namespace, externalId, clientId);
    client('c1', 'Kept');
    client('c2', 'Other');

    // Two sources, and two ids within one source: both are the same client arriving twice.
    identity('campaign-playbook:s1', 'a', 'c1');
    identity('campaign-playbook:s2', 'a', 'c1');
    identity('campaign-playbook:s1', 'b', 'c1');

    expect(rows(db, 'SELECT COUNT(*) AS total FROM client_import_aliases')).toEqual([{ total: 3 }]);
    // The same pair against a second client is refused by the table itself.
    expect(() => identity('campaign-playbook:s1', 'a', 'c2')).toThrow(/UNIQUE/i);
    // And it names a real client.
    expect(() => identity('campaign-playbook:s1', 'c', 'nobody')).toThrow(/FOREIGN KEY/i);
  });

  it('leaves the database consistent after migrating', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    expect(rows(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('does no work on a second boot against the same file', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    track(createDb(file)).close();
    open.pop();

    const applied: string[] = [];
    const db = track(createDb(file, (statements) => applied.push(...statements)));

    expect(applied).toEqual([]);
    expect(rows(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(rows(db, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(rows(db, 'SELECT COUNT(*) AS total FROM tasks')).toEqual([{ total: 1 }]);
  });

  it('initialises a brand-new database with nothing to migrate', () => {
    const applied: string[] = [];
    const db = track(createDb(scratch('nested/fresh.db'), (s) => applied.push(...s)));

    expect(applied).toEqual([]);
    expect(columnsOf(db, 'tasks')).toContain('position');
    expect(rows(db, 'PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  });

  it('backfills project activity from the updated_at an older row already carried', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    // Every project keeps the place in Recently updated it had before the migration.
    expect(rows(db, 'SELECT id, last_activity_at FROM projects')).toEqual([
      { id: 'p1', last_activity_at: NOW },
    ]);
    expect(
      rows(
        db,
        `SELECT COUNT(*) AS unfilled FROM projects
         WHERE last_activity_at IS NULL OR last_activity_at = ''`,
      ),
    ).toEqual([{ unfilled: 0 }]);
  });

  it('never overwrites an activity stamp that is already there', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const migrated = track(createDb(file));
    const later = '2026-08-12T09:30:00.000Z';
    migrated.prepare('UPDATE projects SET last_activity_at=? WHERE id=?').run(later, 'p1');

    // Idempotent: a boot with nothing left to fill writes nothing and leaves activity alone.
    expect(backfillProjectActivity(migrated)).toBe(0);
    expect(rows(migrated, 'SELECT last_activity_at FROM projects')).toEqual([
      { last_activity_at: later },
    ]);

    migrated.close();
    open.pop();
    const reopened = track(createDb(file));
    expect(rows(reopened, 'SELECT last_activity_at FROM projects')).toEqual([
      { last_activity_at: later },
    ]);
  });

  it('keeps foreign key enforcement on through the migration', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    expect(rows(db, 'PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);
    expect(() =>
      db.exec(
        `INSERT INTO tasks (id, project_id, title, created_at, updated_at)
         VALUES ('t2', 'missing', 'Orphan', '${NOW}', '${NOW}')`,
      ),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('additive schema migration guards', () => {
  const base = `CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL)`;

  const withColumn = (definition: string) =>
    `CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL, ${definition})`;

  const target = () => {
    const db = track(new DatabaseSync(':memory:'));
    db.exec(`PRAGMA foreign_keys = ON; ${base}`);
    return db;
  };

  it('adds a nullable column and a column with a default', () => {
    const db = target();
    expect(
      applyAdditiveMigrations(db, withColumn(`kind TEXT, size INTEGER NOT NULL DEFAULT 3`)),
    ).toEqual([
      'ALTER TABLE "widgets" ADD COLUMN "kind" TEXT',
      'ALTER TABLE "widgets" ADD COLUMN "size" INTEGER NOT NULL DEFAULT 3',
    ]);
    expect(columnsOf(db, 'widgets')).toEqual(['id', 'name', 'kind', 'size']);
  });

  it('carries a foreign key through to the added column', () => {
    const db = target();
    db.exec(`CREATE TABLE owners (id TEXT PRIMARY KEY)`);
    const reference = `CREATE TABLE owners (id TEXT PRIMARY KEY); ${withColumn(
      `owner_id TEXT REFERENCES owners(id) ON DELETE CASCADE`,
    )}`;

    expect(applyAdditiveMigrations(db, reference)).toEqual([
      'ALTER TABLE "widgets" ADD COLUMN "owner_id" TEXT REFERENCES "owners"("id") ON DELETE CASCADE',
    ]);
    expect(
      rows(db, `PRAGMA foreign_key_list(widgets)`).map((key) => (key as { table: string }).table),
    ).toEqual(['owners']);
  });

  it('refuses a NOT NULL column with no default', () => {
    expect(() => applyAdditiveMigrations(target(), withColumn(`kind TEXT NOT NULL`))).toThrow(
      /widgets\.kind: SQLite cannot add a NOT NULL column without a default/,
    );
  });

  it('refuses a UNIQUE column', () => {
    expect(() => applyAdditiveMigrations(target(), withColumn(`code TEXT UNIQUE`))).toThrow(
      /widgets\.code: SQLite cannot add a UNIQUE column/,
    );
  });

  it('refuses a foreign key column with a non-NULL default', () => {
    const db = target();
    db.exec(`CREATE TABLE owners (id TEXT PRIMARY KEY)`);
    const reference = `CREATE TABLE owners (id TEXT PRIMARY KEY); ${withColumn(
      `owner_id TEXT NOT NULL DEFAULT 'x' REFERENCES owners(id)`,
    )}`;
    expect(() => applyAdditiveMigrations(db, reference)).toThrow(
      /widgets\.owner_id: a column referencing owners must default to NULL/,
    );
  });

  it('refuses to migrate a table that is not there', () => {
    const db = track(new DatabaseSync(':memory:'));
    expect(() => applyAdditiveMigrations(db, base)).toThrow(
      'Cannot migrate widgets: the table is missing from the database.',
    );
  });

  it('leaves the database untouched when a column cannot be added', () => {
    const db = target();
    expect(() =>
      applyAdditiveMigrations(db, withColumn(`kind TEXT, code TEXT NOT NULL`)),
    ).toThrow();
    expect(columnsOf(db, 'widgets')).toEqual(['id', 'name']);
  });
});
