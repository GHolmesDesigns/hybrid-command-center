import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export type Db = DatabaseSync;

const schema = `
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
  notes TEXT, drive_folder_id TEXT, drive_folder_url TEXT, drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED',
  drive_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_open ON tasks(due_date) WHERE status <> 'COMPLETE';
CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id, position);
CREATE INDEX IF NOT EXISTS idx_dependencies_task ON task_dependencies(task_id);
`;

export function createDb(filename = config.databasePath): Db {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(schema);
  db.exec('PRAGMA optimize');
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
