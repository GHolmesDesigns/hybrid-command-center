import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyAdditiveMigrations, createDb, type Db } from './db.ts';

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
  while (open.length) open.pop()?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('additive schema migration', () => {
  it('adds the missing columns to a database holding real records', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);

    const applied: string[] = [];
    const db = track(createDb(file, (statements) => applied.push(...statements)));

    expect(applied.length).toBeGreaterThan(0);
    expect(applied.every((statement) => statement.startsWith('ALTER TABLE '))).toBe(true);
    expect(columnsOf(db, 'projects')).toEqual(
      expect.arrayContaining([
        'start_date',
        'target_deadline',
        'notes',
        'drive_folder_id',
        'drive_folder_url',
        'drive_status',
        'drive_error',
      ]),
    );
    expect(columnsOf(db, 'tasks')).toEqual(
      expect.arrayContaining(['due_date', 'start_date', 'notes', 'position', 'completed_at']),
    );
  });

  it('preserves existing rows and fills new columns from their defaults', () => {
    const file = scratch('legacy.db');
    seedLegacyDatabase(file);
    const db = track(createDb(file));

    expect(rows(db, 'SELECT id, title, status, priority FROM tasks')).toEqual([
      { id: 't1', title: 'Build concepts', status: 'TODO', priority: 'HIGH' },
    ]);
    expect(rows(db, 'SELECT position, due_date, notes, completed_at FROM tasks')).toEqual([
      { position: 0, due_date: null, notes: null, completed_at: null },
    ]);
    expect(rows(db, 'SELECT drive_status, drive_error FROM projects')).toEqual([
      { drive_status: 'DISCONNECTED', drive_error: null },
    ]);
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
      expect.arrayContaining(['checklist_items', 'task_dependencies', 'settings', 'drive_steps']),
    );
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
