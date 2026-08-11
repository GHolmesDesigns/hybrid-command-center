import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export type Db = DatabaseSync;

/**
 * Tables and columns as a fresh install gets them. Also the definition an
 * existing database is reconciled against — see `applyAdditiveMigrations`.
 */
const tableSchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, contact_name TEXT, email TEXT,
  phone TEXT, website TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', drive_folder_id TEXT,
  drive_folder_url TEXT, drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', drive_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', start_date TEXT, target_deadline TEXT, priority TEXT NOT NULL DEFAULT 'MEDIUM',
  notes TEXT, position INTEGER NOT NULL DEFAULT 0, drive_folder_id TEXT, drive_folder_url TEXT,
  drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', drive_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'BACKLOG', priority TEXT NOT NULL DEFAULT 'MEDIUM', due_date TEXT, start_date TEXT,
  notes TEXT, position INTEGER NOT NULL DEFAULT 0, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, dependency_id), CHECK(task_id <> dependency_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS drive_steps (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, step_key TEXT NOT NULL, folder_id TEXT NOT NULL,
  folder_url TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity_type, entity_id, step_key)
);
`;

/**
 * Indexes, applied after the additive migration so that an index over a
 * newly added column is created against a table that already has it.
 */
const indexSchema = `
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_open ON tasks(due_date) WHERE status <> 'COMPLETE';
CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id, position);
CREATE INDEX IF NOT EXISTS idx_dependencies_task ON task_dependencies(task_id);
`;

const schema = `${tableSchema}${indexSchema}`;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKey {
  table: string;
  to: string | null;
  on_delete: string;
  on_update: string;
}

/** PRAGMA statements take no bound parameters, so identifiers are quoted instead. */
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const rows = <T>(db: Db, sql: string) => db.prepare(sql).all() as unknown as T[];

const tableNames = (db: Db) =>
  rows<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((row) => row.name);

const tableInfo = (db: Db, table: string) =>
  rows<ColumnInfo>(db, `PRAGMA table_info(${quote(table)})`);

const foreignKeys = (db: Db, table: string) =>
  new Map(
    rows<ForeignKey & { from: string }>(db, `PRAGMA foreign_key_list(${quote(table)})`).map(
      (key) => [key.from, key],
    ),
  );

/** Columns carrying a UNIQUE constraint, which `ALTER TABLE` cannot reproduce. */
const uniqueColumns = (db: Db, table: string) => {
  const names = new Set<string>();
  for (const index of rows<{ name: string; origin: string }>(
    db,
    `PRAGMA index_list(${quote(table)})`,
  )) {
    if (index.origin !== 'u') continue;
    for (const column of rows<{ name: string | null }>(
      db,
      `PRAGMA index_info(${quote(index.name)})`,
    )) {
      if (column.name) names.add(column.name);
    }
  }
  return names;
};

/**
 * Rebuilds the `ADD COLUMN` clause for a column the reference schema declares
 * and the live database lacks. Throws rather than emit a statement SQLite would
 * reject, or one that would quietly drop a constraint the schema declares.
 */
function addColumnClause(
  table: string,
  column: ColumnInfo,
  foreignKey: ForeignKey | undefined,
  unique: boolean,
): string {
  const where = `${table}.${column.name}`;
  if (column.pk) {
    throw new Error(`Cannot add ${where}: SQLite cannot add a primary key to an existing table.`);
  }
  if (unique) {
    throw new Error(`Cannot add ${where}: SQLite cannot add a UNIQUE column to an existing table.`);
  }
  if (column.notnull && column.dflt_value === null) {
    throw new Error(
      `Cannot add ${where}: SQLite cannot add a NOT NULL column without a default. ` +
        'Give it a default or make it nullable.',
    );
  }
  if (foreignKey && column.dflt_value !== null) {
    throw new Error(
      `Cannot add ${where}: a column referencing ${foreignKey.table} must default to NULL ` +
        'while PRAGMA foreign_keys is ON.',
    );
  }

  let clause = `${quote(column.name)} ${column.type}`;
  if (column.notnull) clause += ' NOT NULL';
  if (column.dflt_value !== null) clause += ` DEFAULT ${column.dflt_value}`;
  if (foreignKey) {
    clause += ` REFERENCES ${quote(foreignKey.table)}`;
    if (foreignKey.to) clause += `(${quote(foreignKey.to)})`;
    if (foreignKey.on_delete !== 'NO ACTION') clause += ` ON DELETE ${foreignKey.on_delete}`;
    if (foreignKey.on_update !== 'NO ACTION') clause += ` ON UPDATE ${foreignKey.on_update}`;
  }
  return clause;
}

/**
 * Brings an existing database up to the current schema by adding the columns it
 * is missing, and returns the statements it ran.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists,
 * so a column added to `tableSchema` would never reach a database created
 * before it: the code would expect a column the file does not have and every
 * query touching it would fail. This closes that gap by comparing the live
 * database against a throwaway reference database built from the schema, so a
 * new column needs no second declaration to be migrated.
 *
 * Additive only, by design — new tables (handled by `CREATE TABLE IF NOT
 * EXISTS`) and new columns. Dropping, renaming, retyping, or re-constraining a
 * column needs a full table rebuild in SQLite and is deliberately out of scope,
 * as are CHECK constraints, which `PRAGMA table_info` does not report.
 *
 * Safe to run on every boot: with nothing to add it inspects and returns empty.
 */
export function applyAdditiveMigrations(db: Db, referenceSchema = schema): string[] {
  const reference = new DatabaseSync(':memory:');
  const statements: string[] = [];
  try {
    reference.exec(referenceSchema);
    for (const table of tableNames(reference)) {
      const present = new Set(tableInfo(db, table).map((column) => column.name));
      if (present.size === 0) {
        throw new Error(`Cannot migrate ${table}: the table is missing from the database.`);
      }
      const missing = tableInfo(reference, table).filter((column) => !present.has(column.name));
      if (missing.length === 0) continue;
      const keys = foreignKeys(reference, table);
      const unique = uniqueColumns(reference, table);
      for (const column of missing) {
        const clause = addColumnClause(
          table,
          column,
          keys.get(column.name),
          unique.has(column.name),
        );
        statements.push(`ALTER TABLE ${quote(table)} ADD COLUMN ${clause}`);
      }
    }
  } finally {
    reference.close();
  }

  if (statements.length === 0) return statements;
  transaction(db, () => {
    for (const statement of statements) db.exec(statement);
  });
  return statements;
}

export function createDb(
  filename = config.databasePath,
  onMigration?: (statements: readonly string[]) => void,
): Db {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(tableSchema);
  const applied = applyAdditiveMigrations(db);
  db.exec(indexSchema);
  db.exec('PRAGMA optimize');
  onMigration?.(applied);
  return db;
}

let singleton: Db | undefined;
export function getDb() {
  return (singleton ??= createDb());
}

export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
