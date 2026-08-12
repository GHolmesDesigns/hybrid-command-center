import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createDb, type Db } from './db.ts';

export const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

export function parseBackupCli(argv: string[]) {
  const flags = new Set<string>();
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      options[name] = next;
      i += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, options, positionals };
}

export type DriveReferenceKind = 'client' | 'project' | 'drive_step' | 'drive_root';

export interface DriveReference {
  kind: DriveReferenceKind;
  id: string;
  folderId: string;
  folderUrl: string | null;
}

export interface DatabaseSnapshot {
  path: string;
  integrityOk: boolean;
  foreignKeysOk: boolean;
  clients: number;
  projects: number;
  tasks: number;
  hasEncryptedDriveTokens: boolean;
  driveReferences: DriveReference[];
}

export interface BackupResult {
  sourcePath: string;
  backupPath: string;
  pages: number;
  createdAt: string;
}

export interface RestoreResult {
  backupPath: string;
  destinationPath: string;
  safetyBackupPath: string | null;
  removedSidecars: string[];
}

export interface RehearsalResult {
  source: DatabaseSnapshot;
  backupPath: string;
  rehearsalPath: string;
  migrated: DatabaseSnapshot;
  appliedMigrations: string[];
  countsMatch: boolean;
  driveReferencesPreserved: boolean;
  encryptedTokensPreserved: boolean;
}

const rows = <T>(db: Db, sql: string, ...params: (string | number | null)[]) =>
  (params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all()) as unknown as T[];

const scalar = <T>(db: Db, sql: string) => (db.prepare(sql).get() as T | undefined) ?? null;

const tableExists = (db: Db, name: string) =>
  rows<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    name,
  ).length > 0;

const countTable = (db: Db, name: string) => {
  if (!tableExists(db, name)) return 0;
  return Number(
    scalar<{ total: number }>(db, `SELECT COUNT(*) AS total FROM ${quote(name)}`)?.total ?? 0,
  );
};

/** Identifiers only — never user data. */
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export function sidecarPaths(databasePath: string): string[] {
  return SQLITE_SIDECARS.map((suffix) => `${databasePath}${suffix}`);
}

export function removeSqliteSidecars(databasePath: string): string[] {
  const removed: string[] = [];
  for (const sidecar of sidecarPaths(databasePath)) {
    if (!fs.existsSync(sidecar)) continue;
    fs.rmSync(sidecar, { force: true });
    removed.push(sidecar);
  }
  return removed;
}

/** Windows-safe UTC stamp: `20260812T021530123Z`. */
export function backupTimestamp(date = new Date()): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}T${iso.slice(11, 19).replaceAll(':', '')}${iso.slice(20, 23)}Z`;
}

export function backupFileName(date = new Date()): string {
  return `command-center-${backupTimestamp(date)}.db`;
}

export function defaultBackupDir(databasePath: string): string {
  return path.join(path.dirname(path.resolve(databasePath)), 'backups');
}

function assertFile(filePath: string, label: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is not a file: ${filePath}`);
  }
}

function openDatabase(filePath: string, readOnly = false): Db {
  return new DatabaseSync(filePath, { readOnly });
}

/**
 * Consistent snapshot via SQLite's online backup API. This copies committed
 * WAL/journal pages into a single self-contained file — a naked copy of an
 * open `.db` is not sufficient.
 */
export async function backupDatabase(options: {
  sourcePath: string;
  backupDir?: string;
  now?: Date;
}): Promise<BackupResult> {
  const sourcePath = path.resolve(options.sourcePath);
  assertFile(sourcePath, 'Database');

  const createdAt = (options.now ?? new Date()).toISOString();
  const backupDir = path.resolve(options.backupDir ?? defaultBackupDir(sourcePath));
  fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = path.join(backupDir, backupFileName(options.now ?? new Date()));
  if (fs.existsSync(backupPath)) {
    throw new Error(`Backup already exists: ${backupPath}`);
  }

  const source = openDatabase(sourcePath);
  let pages: number;
  try {
    pages = await backup(source, backupPath);
  } finally {
    source.close();
  }

  return { sourcePath, backupPath, pages, createdAt };
}

const hasColumn = (db: Db, table: string, column: string) =>
  tableExists(db, table) &&
  rows<{ name: string }>(db, `PRAGMA table_info(${quote(table)})`).some(
    (entry) => entry.name === column,
  );

function driveReferencesFrom(db: Db): DriveReference[] {
  const references: DriveReference[] = [];
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';

  if (hasColumn(db, 'clients', 'drive_folder_id')) {
    for (const row of rows<{
      id: string;
      drive_folder_id: string | null;
      drive_folder_url: string | null;
    }>(db, `SELECT id, drive_folder_id, drive_folder_url FROM clients`)) {
      if (!filled(row.drive_folder_id)) continue;
      references.push({
        kind: 'client',
        id: row.id,
        folderId: row.drive_folder_id as string,
        folderUrl: filled(row.drive_folder_url) ? row.drive_folder_url : null,
      });
    }
  }

  if (hasColumn(db, 'projects', 'drive_folder_id')) {
    for (const row of rows<{
      id: string;
      drive_folder_id: string | null;
      drive_folder_url: string | null;
    }>(db, `SELECT id, drive_folder_id, drive_folder_url FROM projects`)) {
      if (!filled(row.drive_folder_id)) continue;
      references.push({
        kind: 'project',
        id: row.id,
        folderId: row.drive_folder_id as string,
        folderUrl: filled(row.drive_folder_url) ? row.drive_folder_url : null,
      });
    }
  }

  if (tableExists(db, 'drive_steps')) {
    for (const row of rows<{
      entity_type: string;
      entity_id: string;
      step_key: string;
      folder_id: string;
      folder_url: string | null;
    }>(
      db,
      `SELECT entity_type, entity_id, step_key, folder_id, folder_url FROM drive_steps ORDER BY entity_type, entity_id, step_key`,
    )) {
      if (!filled(row.folder_id)) continue;
      references.push({
        kind: 'drive_step',
        id: `${row.entity_type}:${row.entity_id}:${row.step_key}`,
        folderId: row.folder_id,
        folderUrl: filled(row.folder_url) ? row.folder_url : null,
      });
    }
  }

  if (tableExists(db, 'settings')) {
    const root = scalar<{ value: string }>(
      db,
      `SELECT value FROM settings WHERE key = 'drive_root_id'`,
    );
    const rootUrl = scalar<{ value: string }>(
      db,
      `SELECT value FROM settings WHERE key = 'drive_root_url'`,
    );
    if (filled(root?.value)) {
      references.push({
        kind: 'drive_root',
        id: 'drive_root',
        folderId: root!.value,
        folderUrl: filled(rootUrl?.value) ? rootUrl!.value : null,
      });
    }
  }

  return references;
}

export function inspectDatabase(databasePath: string): DatabaseSnapshot {
  const resolved = path.resolve(databasePath);
  assertFile(resolved, 'Database');
  const db = openDatabase(resolved, true);
  try {
    const integrity = scalar<{ integrity_check: string }>(db, 'PRAGMA integrity_check');
    const foreignKeys = rows<Record<string, unknown>>(db, 'PRAGMA foreign_key_check');
    const tokens = tableExists(db, 'settings')
      ? scalar<{ value: string }>(db, `SELECT value FROM settings WHERE key = 'google_tokens'`)
      : null;
    return {
      path: resolved,
      integrityOk: integrity?.integrity_check === 'ok',
      foreignKeysOk: foreignKeys.length === 0,
      clients: countTable(db, 'clients'),
      projects: countTable(db, 'projects'),
      tasks: countTable(db, 'tasks'),
      hasEncryptedDriveTokens: Boolean(tokens?.value),
      driveReferences: driveReferencesFrom(db),
    };
  } finally {
    db.close();
  }
}

function serializeDriveReferences(references: DriveReference[]) {
  return [...references]
    .map(
      (reference) =>
        `${reference.kind}\t${reference.id}\t${reference.folderId}\t${reference.folderUrl ?? ''}`,
    )
    .sort();
}

export function driveReferencesMatch(left: DriveReference[], right: DriveReference[]) {
  const a = serializeDriveReferences(left);
  const b = serializeDriveReferences(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

async function writeSnapshotFile(sourceBackup: string, destinationPath: string) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const tempPath = `${destinationPath}.restore-tmp`;
  fs.rmSync(tempPath, { force: true });
  const source = openDatabase(sourceBackup, true);
  try {
    await backup(source, tempPath);
  } finally {
    source.close();
  }
  try {
    if (fs.existsSync(destinationPath)) fs.rmSync(destinationPath);
  } catch {
    fs.rmSync(tempPath, { force: true });
    throw new Error(
      `Cannot replace ${destinationPath} while it is in use. Stop the application with Ctrl+C, then retry.`,
    );
  }
  const removedSidecars = removeSqliteSidecars(destinationPath);
  fs.renameSync(tempPath, destinationPath);
  return removedSidecars;
}

export async function restoreDatabase(options: {
  backupPath: string;
  destinationPath: string;
  force?: boolean;
  safetyBackupDir?: string;
  now?: Date;
}): Promise<RestoreResult> {
  const backupPath = path.resolve(options.backupPath);
  const destinationPath = path.resolve(options.destinationPath);
  assertFile(backupPath, 'Backup');

  if (path.resolve(backupPath) === destinationPath) {
    throw new Error('Backup path and destination path must be different.');
  }

  const snapshot = inspectDatabase(backupPath);
  if (!snapshot.integrityOk) {
    throw new Error(`Backup failed integrity check: ${backupPath}`);
  }

  const destinationExists = fs.existsSync(destinationPath);
  if (destinationExists && !options.force) {
    throw new Error(
      `Refusing to overwrite ${destinationPath}. Stop the application, then pass --force to restore.`,
    );
  }

  let safetyBackupPath: string | null = null;
  if (destinationExists) {
    const safety = await backupDatabase({
      sourcePath: destinationPath,
      backupDir: options.safetyBackupDir ?? defaultBackupDir(destinationPath),
      now: options.now,
    });
    safetyBackupPath = safety.backupPath;
  }

  const removedSidecars = await writeSnapshotFile(backupPath, destinationPath);
  return { backupPath, destinationPath, safetyBackupPath, removedSidecars };
}

export async function rehearseBackupRestore(options: {
  sourcePath: string;
  backupDir?: string;
  now?: Date;
}): Promise<RehearsalResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const source = inspectDatabase(sourcePath);
  if (!source.integrityOk) {
    throw new Error(`Source database failed integrity check: ${sourcePath}`);
  }

  const backupResult = await backupDatabase({
    sourcePath,
    backupDir: options.backupDir,
    now: options.now,
  });

  const rehearsalPath = path.join(
    path.dirname(backupResult.backupPath),
    `rehearsal-${path.basename(backupResult.backupPath)}`,
  );
  fs.copyFileSync(backupResult.backupPath, rehearsalPath);

  const appliedMigrations: string[] = [];
  const migratedDb = createDb(rehearsalPath, (statements) => appliedMigrations.push(...statements));
  migratedDb.close();

  const migrated = inspectDatabase(rehearsalPath);
  return {
    source,
    backupPath: backupResult.backupPath,
    rehearsalPath,
    migrated,
    appliedMigrations,
    countsMatch:
      source.clients === migrated.clients &&
      source.projects === migrated.projects &&
      source.tasks === migrated.tasks,
    driveReferencesPreserved: driveReferencesMatch(
      source.driveReferences,
      migrated.driveReferences,
    ),
    encryptedTokensPreserved: source.hasEncryptedDriveTokens === migrated.hasEncryptedDriveTokens,
  };
}

export function rehearsalPassed(result: RehearsalResult): boolean {
  return (
    result.source.integrityOk &&
    result.migrated.integrityOk &&
    result.source.foreignKeysOk &&
    result.migrated.foreignKeysOk &&
    result.countsMatch &&
    result.driveReferencesPreserved &&
    result.encryptedTokensPreserved
  );
}

export function formatRehearsalReport(result: RehearsalResult): string {
  const lines = [
    'Backup / restore rehearsal',
    `Source:     ${result.source.path}`,
    `Backup:     ${result.backupPath}`,
    `Rehearsal:  ${result.rehearsalPath}`,
    '',
    `Integrity:  source ${result.source.integrityOk ? 'ok' : 'FAILED'} · migrated ${result.migrated.integrityOk ? 'ok' : 'FAILED'}`,
    `Foreign keys: source ${result.source.foreignKeysOk ? 'ok' : 'FAILED'} · migrated ${result.migrated.foreignKeysOk ? 'ok' : 'FAILED'}`,
    `Counts:     clients ${result.source.clients}→${result.migrated.clients}, projects ${result.source.projects}→${result.migrated.projects}, tasks ${result.source.tasks}→${result.migrated.tasks}`,
    `Migrations: ${result.appliedMigrations.length === 0 ? 'none (already current)' : result.appliedMigrations.join('; ')}`,
    `Encrypted Drive tokens present: ${result.migrated.hasEncryptedDriveTokens ? 'yes' : 'no'}`,
    `Drive references preserved: ${result.driveReferencesPreserved ? 'yes' : 'NO'}`,
  ];

  if (result.migrated.driveReferences.length === 0) {
    lines.push('Drive folder IDs: none stored locally');
  } else {
    lines.push('Drive folder IDs:');
    for (const reference of result.migrated.driveReferences) {
      lines.push(
        `  - ${reference.kind} ${reference.id}: ${reference.folderId}${reference.folderUrl ? ` (${reference.folderUrl})` : ''}`,
      );
    }
  }

  lines.push('');
  lines.push(rehearsalPassed(result) ? 'Rehearsal passed.' : 'Rehearsal FAILED.');
  return lines.join('\n');
}
