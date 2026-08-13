import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_KEEP,
  backupDatabase,
  backupFileName,
  defaultBackupDir,
  formatRehearsalWarning,
  inspectDatabase,
  listBackups,
  listRehearsalCopies,
  parseBackupCli,
  parseKeepOption,
  pruneBackups,
  pruneRehearsalCopies,
  readRehearsalFailure,
  recordRehearsalOutcome,
  rehearsalMarkerPath,
  rehearseBackupRestore,
  rehearsalPassed,
  removeSqliteSidecars,
  restoreDatabase,
  sidecarPaths,
} from './backup.ts';
import { createDb } from './db.ts';

const NOW = '2026-08-11T12:00:00.000Z';
const STAMP = new Date('2026-08-12T02:15:30.123Z');

const CLIENT_FOLDER_ID = '1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';
const PROJECT_FOLDER_ID = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876';
const ROOT_FOLDER_ID = '1RootFolderIdCommandCenter00';
const ADMIN_STEP_ID = '1AdminSubfolderId00000000001';
const CLIENT_FOLDER_URL = `https://drive.google.com/drive/folders/${CLIENT_FOLDER_ID}`;
const PROJECT_FOLDER_URL = `https://drive.google.com/drive/folders/${PROJECT_FOLDER_ID}`;
const ROOT_FOLDER_URL = `https://drive.google.com/drive/folders/${ROOT_FOLDER_ID}`;
const ADMIN_STEP_URL = `https://drive.google.com/drive/folders/${ADMIN_STEP_ID}`;
const ENCRYPTED_TOKENS = 'iv.test.ciphertext';

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

let directory: string;
const open: DatabaseSync[] = [];

const scratch = (...parts: string[]) => path.join(directory, ...parts);

const track = (db: DatabaseSync) => {
  open.push(db);
  return db;
};

const columnsOf = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );

function seedLegacyDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec(legacySchema);
  db.prepare(
    `INSERT INTO clients (id, name, slug, status, drive_status, drive_folder_id, drive_folder_url, created_at, updated_at)
     VALUES ('c1', 'Acme Studio', 'acme-studio', 'ACTIVE', 'CONNECTED', ?, ?, ?, ?)`,
  ).run(CLIENT_FOLDER_ID, CLIENT_FOLDER_URL, NOW, NOW);
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

function seedCurrentDatabase(file: string) {
  const db = createDb(file);
  db.prepare(
    `INSERT INTO clients (id, name, slug, status, drive_status, drive_folder_id, drive_folder_url, created_at, updated_at)
     VALUES ('c1', 'Acme Studio', 'acme-studio', 'ACTIVE', 'CONNECTED', ?, ?, ?, ?)`,
  ).run(CLIENT_FOLDER_ID, CLIENT_FOLDER_URL, NOW, NOW);
  db.prepare(
    `INSERT INTO projects (id, client_id, name, description, status, priority, drive_folder_id, drive_folder_url, drive_status, created_at, updated_at, last_activity_at)
     VALUES ('p1', 'c1', 'Identity System', 'Brand work', 'ACTIVE', 'HIGH', ?, ?, 'CONNECTED', ?, ?, ?)`,
  ).run(PROJECT_FOLDER_ID, PROJECT_FOLDER_URL, NOW, NOW, NOW);
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, position, created_at, updated_at)
     VALUES ('t1', 'p1', 'Build concepts', 'Explore directions', 'TODO', 'HIGH', 0, ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO drive_steps (entity_type, entity_id, step_key, folder_id, folder_url, created_at)
     VALUES ('project', 'p1', '01_Admin', ?, ?, ?)`,
  ).run(ADMIN_STEP_ID, ADMIN_STEP_URL, NOW);
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
    'drive_root_id',
    ROOT_FOLDER_ID,
    NOW,
  );
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
    'drive_root_url',
    ROOT_FOLDER_URL,
    NOW,
  );
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
    'google_tokens',
    ENCRYPTED_TOKENS,
    NOW,
  );
  db.close();
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-backup-'));
});

afterEach(() => {
  while (open.length) open.pop()?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('backup helpers', () => {
  it('builds a Windows-safe timestamped backup name', () => {
    expect(backupFileName(STAMP)).toBe('command-center-20260812T021530123Z.db');
    expect(backupFileName(STAMP)).not.toMatch(/:/);
  });

  it('keeps backups next to the database file', () => {
    const databasePath = scratch('command-center.db');
    expect(defaultBackupDir(databasePath)).toBe(path.join(path.dirname(databasePath), 'backups'));
  });

  it('parses CLI flags, options, and the backup path', () => {
    expect(
      parseBackupCli([
        'data/backups/one.db',
        '--force',
        '--database',
        './data/live.db',
        '--dir',
        './safety',
      ]),
    ).toEqual({
      flags: new Set(['force']),
      options: { database: './data/live.db', dir: './safety' },
      positionals: ['data/backups/one.db'],
    });
  });
});

describe('backupDatabase', () => {
  it('captures rows that still live in WAL instead of the main file', async () => {
    const source = scratch('live.db');
    const setup = new DatabaseSync(source);
    setup.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL)`);
    setup.close();

    const db = track(new DatabaseSync(source));
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;`);
    db.prepare(`INSERT INTO items (id, label) VALUES ('row-1', 'in-wal')`).run();
    expect(fs.existsSync(`${source}-wal`)).toBe(true);

    const nakedCopy = scratch('naked.db');
    fs.copyFileSync(source, nakedCopy);

    const result = await backupDatabase({
      sourcePath: source,
      backupDir: scratch('backups'),
      now: STAMP,
    });

    expect(result.backupPath).toBe(scratch('backups', 'command-center-20260812T021530123Z.db'));
    expect(result.pages).toBeGreaterThan(0);
    for (const sidecar of sidecarPaths(result.backupPath)) {
      expect(fs.existsSync(sidecar)).toBe(false);
    }

    const snapshot = track(new DatabaseSync(result.backupPath, { readOnly: true }));
    expect(snapshot.prepare(`SELECT label FROM items`).all()).toEqual([{ label: 'in-wal' }]);
    expect(snapshot.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);

    const naked = track(new DatabaseSync(nakedCopy, { readOnly: true }));
    expect(naked.prepare(`SELECT label FROM items`).all()).toEqual([]);
  });

  it('does not migrate a legacy source while backing it up', async () => {
    const source = scratch('legacy.db');
    seedLegacyDatabase(source);

    await backupDatabase({ sourcePath: source, backupDir: scratch('backups'), now: STAMP });

    const db = track(new DatabaseSync(source, { readOnly: true }));
    expect(columnsOf(db, 'projects')).not.toContain('last_activity_at');
    expect(columnsOf(db, 'projects')).not.toContain('drive_folder_id');
  });
});

const names = (files: string[]) => files.map((file) => path.basename(file));

/** Snapshot files with controlled stamps — retention reads names, never file times. */
function seedBackupFiles(directory: string, stamps: string[], withSidecars = false) {
  fs.mkdirSync(directory, { recursive: true });
  return stamps.map((stamp) => {
    const file = path.join(directory, `command-center-${stamp}.db`);
    fs.writeFileSync(file, `snapshot ${stamp}`);
    if (withSidecars) {
      for (const sidecar of sidecarPaths(file)) fs.writeFileSync(sidecar, `stale ${stamp}`);
    }
    return file;
  });
}

describe('backup retention', () => {
  it('reads a keep count and refuses anything that is not one', () => {
    expect(parseKeepOption(undefined)).toBe(DEFAULT_BACKUP_KEEP);
    expect(parseKeepOption('3')).toBe(3);
    expect(parseKeepOption(' 3 ')).toBe(3);
    expect(parseKeepOption('0')).toBe(0);

    for (const bad of ['', 'three', '-1', '2.5', '3 snapshots']) {
      expect(() => parseKeepOption(bad)).toThrow(/whole number/);
    }
  });

  it('keeps the newest three snapshots and their sidecars, and deletes only older ones', async () => {
    const source = scratch('command-center.db');
    seedCurrentDatabase(source);
    const directory = scratch('backups');
    const [oldest, middle, newest] = seedBackupFiles(
      directory,
      ['20260801T120000000Z', '20260802T120000000Z', '20260803T120000000Z'],
      true,
    );

    const result = await backupDatabase({
      sourcePath: source,
      backupDir: directory,
      keep: 3,
      now: STAMP,
    });

    expect(names(result.kept)).toEqual([
      'command-center-20260812T021530123Z.db',
      'command-center-20260803T120000000Z.db',
      'command-center-20260802T120000000Z.db',
    ]);
    expect(names(result.pruned)).toEqual(['command-center-20260801T120000000Z.db']);
    expect(names(listBackups(directory))).toEqual(names(result.kept));

    // The pruned snapshot takes its sidecars with it; the surviving ones keep theirs.
    expect(fs.existsSync(oldest)).toBe(false);
    for (const sidecar of sidecarPaths(oldest)) expect(fs.existsSync(sidecar)).toBe(false);
    for (const survivor of [middle, newest]) {
      expect(fs.existsSync(survivor)).toBe(true);
      for (const sidecar of sidecarPaths(survivor)) expect(fs.existsSync(sidecar)).toBe(true);
    }

    // The new snapshot is a real one, not a placeholder that happened to sort first.
    expect(inspectDatabase(result.backupPath).clients).toBe(1);
  });

  it('prunes nothing when the backup fails', async () => {
    const source = scratch('command-center.db');
    seedCurrentDatabase(source);
    const directory = scratch('backups');
    const existing = seedBackupFiles(directory, [
      '20260801T120000000Z',
      '20260802T120000000Z',
      '20260805T120000000Z',
    ]);

    // The snapshot cannot be written: today's name is already taken.
    await expect(
      backupDatabase({
        sourcePath: source,
        backupDir: directory,
        keep: 1,
        now: new Date('2026-08-05T12:00:00.000Z'),
      }),
    ).rejects.toThrow(/Backup already exists/);
    expect(names(listBackups(directory))).toEqual(names(existing).reverse());

    // The snapshot never starts: there is no database to copy.
    await expect(
      backupDatabase({ sourcePath: scratch('gone.db'), backupDir: directory, keep: 1 }),
    ).rejects.toThrow(/does not exist/);
    expect(listBackups(directory)).toHaveLength(3);
    for (const file of existing) expect(fs.existsSync(file)).toBe(true);
  });

  it('never deletes the last remaining backup', () => {
    const directory = scratch('backups');
    const [only] = seedBackupFiles(directory, ['20260801T120000000Z']);

    expect(pruneBackups({ backupDir: directory, keep: 1 })).toEqual({ kept: [only], pruned: [] });
    expect(fs.existsSync(only)).toBe(true);

    // Even asked to keep fewer than one, retention leaves the newest standing.
    expect(pruneBackups({ backupDir: directory, keep: -5 }).pruned).toEqual([]);
    expect(listBackups(directory)).toEqual([only]);
  });

  it('collapses to exactly one snapshot at --keep 1', () => {
    const directory = scratch('backups');
    seedBackupFiles(directory, [
      '20260801T120000000Z',
      '20260802T120000000Z',
      '20260803T120000000Z',
    ]);

    const result = pruneBackups({ backupDir: directory, keep: 1 });

    expect(names(result.kept)).toEqual(['command-center-20260803T120000000Z.db']);
    expect(names(result.pruned)).toEqual([
      'command-center-20260802T120000000Z.db',
      'command-center-20260801T120000000Z.db',
    ]);
    expect(listBackups(directory)).toHaveLength(1);
  });

  it('keeps every snapshot at --keep 0', async () => {
    const source = scratch('command-center.db');
    seedCurrentDatabase(source);
    const directory = scratch('backups');
    seedBackupFiles(directory, ['20260801T120000000Z', '20260802T120000000Z']);

    const result = await backupDatabase({
      sourcePath: source,
      backupDir: directory,
      keep: 0,
      now: STAMP,
    });

    expect(result.pruned).toEqual([]);
    expect(result.kept).toHaveLength(3);
    expect(listBackups(directory)).toHaveLength(3);
  });

  it('takes a backup without pruning when no keep count is given', async () => {
    const source = scratch('command-center.db');
    seedCurrentDatabase(source);
    const directory = scratch('backups');
    seedBackupFiles(directory, ['20260801T120000000Z', '20260802T120000000Z']);

    // Restore's safety copy and the rehearsal's snapshot both land here.
    const result = await backupDatabase({ sourcePath: source, backupDir: directory, now: STAMP });

    expect(result.pruned).toEqual([]);
    expect(listBackups(directory)).toHaveLength(3);
  });

  it('ignores files it did not write', () => {
    const directory = scratch('backups');
    const [snapshot] = seedBackupFiles(directory, ['20260801T120000000Z']);
    const strangers = [
      path.join(directory, 'rehearsal-command-center-20260731T120000000Z.db'),
      path.join(directory, 'command-center.db'),
      path.join(directory, 'notes.txt'),
      rehearsalMarkerPath(directory),
    ];
    for (const stranger of strangers) fs.writeFileSync(stranger, 'not a snapshot');

    expect(listBackups(directory)).toEqual([snapshot]);
    expect(pruneBackups({ backupDir: directory, keep: 1 }).pruned).toEqual([]);
    for (const stranger of strangers) expect(fs.existsSync(stranger)).toBe(true);
  });

  it('leaves one rehearsal copy behind, or all of them at --keep 0', () => {
    const directory = scratch('backups');
    fs.mkdirSync(directory, { recursive: true });
    const stamps = ['20260801T120000000Z', '20260802T120000000Z', '20260803T120000000Z'];
    const copies = stamps.map((stamp) => {
      const file = path.join(directory, `rehearsal-command-center-${stamp}.db`);
      fs.writeFileSync(file, `copy ${stamp}`);
      return file;
    });
    const [snapshot] = seedBackupFiles(directory, ['20260801T120000000Z']);

    expect(pruneRehearsalCopies({ backupDir: directory, keep: 0 }).pruned).toEqual([]);

    const result = pruneRehearsalCopies({ backupDir: directory, keep: DEFAULT_BACKUP_KEEP });

    // One copy is worth keeping to look at. A scheduled rehearsal writing a full database
    // copy per run is exactly the growth this card exists to stop.
    expect(names(result.kept)).toEqual(['rehearsal-command-center-20260803T120000000Z.db']);
    expect(result.pruned).toHaveLength(2);
    expect(listRehearsalCopies(directory)).toEqual([copies[2]]);
    expect(fs.existsSync(snapshot)).toBe(true);
  });

  it('leaves a protected snapshot alone even when it is the oldest', () => {
    const directory = scratch('backups');
    const [oldest, middle, newest] = seedBackupFiles(directory, [
      '20260801T120000000Z',
      '20260802T120000000Z',
      '20260803T120000000Z',
    ]);

    // Rehearsing an old snapshot with `--dir` set to its own directory: retention must not
    // delete the database being read.
    const result = pruneBackups({ backupDir: directory, keep: 1, protect: [oldest] });

    expect(names(result.pruned)).toEqual(['command-center-20260802T120000000Z.db']);
    expect(names(result.kept)).toEqual([
      'command-center-20260803T120000000Z.db',
      'command-center-20260801T120000000Z.db',
    ]);
    expect(fs.existsSync(oldest)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
    expect(fs.existsSync(middle)).toBe(false);
  });

  it('reports an empty directory rather than failing', () => {
    expect(listBackups(scratch('missing'))).toEqual([]);
    expect(pruneBackups({ backupDir: scratch('missing'), keep: 3 })).toEqual({
      kept: [],
      pruned: [],
    });
  });
});

describe('rehearsal outcome marker', () => {
  it('records a failure beside the backups and clears it on the next pass', () => {
    const directory = scratch('backups');

    expect(readRehearsalFailure(directory)).toBeNull();

    const markerPath = recordRehearsalOutcome({
      backupDir: directory,
      passed: false,
      report: 'Backup / restore rehearsal\n\nRehearsal FAILED.',
      now: STAMP,
    });

    expect(markerPath).toBe(rehearsalMarkerPath(directory));
    expect(fs.readFileSync(markerPath!, 'utf8')).toContain('Rehearsal FAILED.');

    const failure = readRehearsalFailure(directory);
    expect(failure).toEqual({ markerPath, recordedAt: STAMP.toISOString() });

    // What a person sees the next time they run any backup command.
    const warning = formatRehearsalWarning(failure!);
    expect(warning).toContain('rehearsal FAILED');
    expect(warning).toContain(STAMP.toISOString());
    expect(warning).toContain('npm run db:backup:rehearse');

    expect(
      recordRehearsalOutcome({
        backupDir: directory,
        passed: true,
        report: 'Rehearsal passed.',
      }),
    ).toBeNull();
    expect(readRehearsalFailure(directory)).toBeNull();
    expect(fs.existsSync(markerPath!)).toBe(false);
  });

  it('clears a marker that was never there', () => {
    const directory = scratch('backups');
    expect(
      recordRehearsalOutcome({ backupDir: directory, passed: true, report: 'Rehearsal passed.' }),
    ).toBeNull();
  });
});

describe('restoreDatabase', () => {
  it('refuses to overwrite without --force', async () => {
    const backup = scratch('backup.db');
    const destination = scratch('live.db');
    seedCurrentDatabase(backup);
    seedCurrentDatabase(destination);

    await expect(
      restoreDatabase({ backupPath: backup, destinationPath: destination }),
    ).rejects.toThrow(/Refusing to overwrite/);
  });

  it('replaces the live database and keeps a safety copy', async () => {
    const backup = scratch('backup.db');
    const destination = scratch('live.db');
    seedCurrentDatabase(backup);

    const live = createDb(destination);
    live
      .prepare(
        `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
         VALUES ('old', 'Old Client', 'old-client', 'ACTIVE', 'DISCONNECTED', ?, ?)`,
      )
      .run(NOW, NOW);
    live.close();

    const result = await restoreDatabase({
      backupPath: backup,
      destinationPath: destination,
      force: true,
      safetyBackupDir: scratch('backups'),
      now: STAMP,
    });

    expect(result.safetyBackupPath).toBe(
      scratch('backups', 'command-center-20260812T021530123Z.db'),
    );
    for (const sidecar of sidecarPaths(destination)) {
      expect(fs.existsSync(sidecar)).toBe(false);
    }

    const restored = inspectDatabase(destination);
    expect(restored.integrityOk).toBe(true);
    expect(restored.clients).toBe(1);
    expect(restored.driveReferences).toEqual(
      expect.arrayContaining([
        {
          kind: 'client',
          id: 'c1',
          folderId: CLIENT_FOLDER_ID,
          folderUrl: CLIENT_FOLDER_URL,
        },
        {
          kind: 'project',
          id: 'p1',
          folderId: PROJECT_FOLDER_ID,
          folderUrl: PROJECT_FOLDER_URL,
        },
        {
          kind: 'drive_step',
          id: 'project:p1:01_Admin',
          folderId: ADMIN_STEP_ID,
          folderUrl: ADMIN_STEP_URL,
        },
        {
          kind: 'drive_root',
          id: 'drive_root',
          folderId: ROOT_FOLDER_ID,
          folderUrl: ROOT_FOLDER_URL,
        },
      ]),
    );

    const safety = inspectDatabase(result.safetyBackupPath!);
    expect(safety.clients).toBe(1);
    expect(safety.driveReferences).toEqual([]);
  });

  it('restores onto a missing destination without --force', async () => {
    const backup = scratch('backup.db');
    seedCurrentDatabase(backup);
    const destination = scratch('nested', 'command-center.db');

    await restoreDatabase({ backupPath: backup, destinationPath: destination });

    expect(inspectDatabase(destination).clients).toBe(1);
  });

  it('deletes leftover WAL, SHM, and journal files', () => {
    const destination = scratch('live.db');
    fs.writeFileSync(destination, 'placeholder');
    fs.writeFileSync(`${destination}-wal`, 'stale-wal');
    fs.writeFileSync(`${destination}-shm`, 'stale-shm');
    fs.writeFileSync(`${destination}-journal`, 'stale-journal');

    expect(removeSqliteSidecars(destination)).toEqual([
      `${destination}-wal`,
      `${destination}-shm`,
      `${destination}-journal`,
    ]);
    for (const sidecar of sidecarPaths(destination)) {
      expect(fs.existsSync(sidecar)).toBe(false);
    }
  });
});

describe('rehearseBackupRestore', () => {
  it('backs up a current database, migrates a copy, and keeps Drive references', async () => {
    const source = scratch('command-center.db');
    seedCurrentDatabase(source);

    const result = await rehearseBackupRestore({
      sourcePath: source,
      backupDir: scratch('backups'),
      now: STAMP,
    });

    expect(rehearsalPassed(result)).toBe(true);
    expect(result.appliedMigrations).toEqual([]);
    expect(result.countsMatch).toBe(true);
    expect(result.driveReferencesPreserved).toBe(true);
    expect(result.encryptedTokensPreserved).toBe(true);
    expect(result.migrated.clients).toBe(1);
    expect(result.migrated.projects).toBe(1);
    expect(result.migrated.tasks).toBe(1);
    expect(result.migrated.hasEncryptedDriveTokens).toBe(true);
    expect(result.migrated.driveReferences).toHaveLength(4);
    expect(fs.existsSync(result.backupPath)).toBe(true);
    expect(fs.existsSync(result.rehearsalPath)).toBe(true);
    expect(inspectDatabase(source).driveReferences).toEqual(result.migrated.driveReferences);
  });

  it('migrates a legacy copy without losing client Drive folder ids or row counts', async () => {
    const source = scratch('legacy.db');
    seedLegacyDatabase(source);

    const result = await rehearseBackupRestore({
      sourcePath: source,
      backupDir: scratch('backups'),
      now: STAMP,
    });

    expect(rehearsalPassed(result)).toBe(true);
    expect(result.appliedMigrations.length).toBeGreaterThan(0);
    expect(result.migrated.clients).toBe(1);
    expect(result.migrated.projects).toBe(1);
    expect(result.migrated.tasks).toBe(1);
    expect(result.migrated.driveReferences).toEqual([
      {
        kind: 'client',
        id: 'c1',
        folderId: CLIENT_FOLDER_ID,
        folderUrl: CLIENT_FOLDER_URL,
      },
    ]);

    const migrated = track(new DatabaseSync(result.rehearsalPath, { readOnly: true }));
    expect(columnsOf(migrated, 'projects')).toEqual(
      expect.arrayContaining(['drive_folder_id', 'last_activity_at']),
    );
  });
});
