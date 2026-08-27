import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import {
  backupDatabase,
  inspectDatabase,
  parseBackupCli,
  rehearseBackupRestore,
  rehearsalPassed,
  restoreDatabase,
  formatRehearsalReport,
} from '../backup.ts';
import {
  cutoverVerificationPassed,
  formatCutoverVerificationReport,
  verifyPostRestore,
  type CutoverSnapshot,
} from '../domain/cutover-rehearsal.ts';
import { createDb } from '../db.ts';

const { flags, options } = parseBackupCli(process.argv.slice(2));

const usage = `Usage: npm run cutover:rehearse -- [--plan] [--disposable-dir <path>] [--source <database>] [--rollback-rehearsal] [--stopped]

  --plan                 Print the operator sequence without touching data.
  --disposable-dir <path>  Required for a live rehearsal; all artifacts stay under this directory.
  --source <database>    Database to rehearse (default: DATABASE_PATH).
  --rollback-rehearsal   After backup, simulate a post-cutover write and restore the snapshot.
  --stopped              Operator confirms the application is stopped before restore (required with --rollback-rehearsal).`;

function toCutoverSnapshot(databasePath: string): CutoverSnapshot {
  const snapshot = inspectDatabase(databasePath);
  return {
    clients: snapshot.clients,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    integrityOk: snapshot.integrityOk,
    foreignKeysOk: snapshot.foreignKeysOk,
    hasEncryptedDriveTokens: snapshot.hasEncryptedDriveTokens,
    driveReferenceCount: snapshot.driveReferences.length,
  };
}

function printPlan() {
  console.log(`Cloud cutover rehearsal plan (C55)

Operator-only actions — stop before any step that moves production data, credentials, DNS, or grants.

1. Confirm prerequisite cards C51–C54 are merged and staging checks are green.
2. Stop local writes or take the supported online backup, then verify the snapshot.
3. Transfer the snapshot and GOOGLE_TOKEN_ENCRYPTION_KEY through separate approved channels.
4. Restore and migrate on an empty persistent volume on disposable staging.
5. Rehearse backup/restore on a copy before traffic (db:backup:rehearse or this script).
6. Start authenticated HTTPS, verify clients/projects/tasks, Signal, Files, and Sync to Folder.
7. Revoke the old full-Drive Google grant and reconnect through drive.file plus Picker.
8. Declare the host authoritative only after every checklist item passes.
9. Rollback: freeze writes, fresh hosted backup, restore that snapshot — never the pre-cutover laptop copy.

See docs/cloud-cutover-rehearsal.md for the full checklist, failure table, and monitoring confirmation.`);
}

function assertStoppedForRestore() {
  if (!flags.has('stopped')) {
    throw new Error(
      'Rollback rehearsal restores over the live file. Pass --stopped after stopping the application.',
    );
  }
}

try {
  if (flags.has('plan')) {
    printPlan();
    process.exit(0);
  }

  const disposableDir = options['disposable-dir'];
  if (!disposableDir) {
    throw new Error(`${usage}\n--disposable-dir is required unless --plan is given.`);
  }

  const resolvedDisposable = path.resolve(disposableDir);
  fs.mkdirSync(resolvedDisposable, { recursive: true });

  const sourcePath = path.resolve(options.source || config.databasePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source database not found: ${sourcePath}`);
  }

  const backupDir = path.join(resolvedDisposable, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const before = toCutoverSnapshot(sourcePath);
  console.log(`Source: ${sourcePath}`);
  console.log(
    `Snapshot: clients ${before.clients}, projects ${before.projects}, tasks ${before.tasks}, Drive refs ${before.driveReferenceCount}`,
  );

  const rehearsal = await rehearseBackupRestore({ sourcePath, backupDir });
  console.log('');
  console.log(formatRehearsalReport(rehearsal));
  if (!rehearsalPassed(rehearsal)) process.exit(1);

  if (flags.has('rollback-rehearsal')) {
    assertStoppedForRestore();
    const liveCopy = path.join(resolvedDisposable, 'live-command-center.db');
    fs.copyFileSync(sourcePath, liveCopy);

    const backup = await backupDatabase({ sourcePath: liveCopy, backupDir });
    console.log('');
    console.log(`Rollback snapshot: ${backup.backupPath}`);

    const stamp = new Date().toISOString();
    const rollbackId = `rollback-${Date.now()}`;
    const db = createDb(liveCopy);
    try {
      db.prepare(
        `INSERT INTO clients (id, name, slug, status, drive_status, created_at, updated_at)
         VALUES (?, ?, ?, 'ACTIVE', 'DISCONNECTED', ?, ?)`,
      ).run(rollbackId, 'Post-cutover write (must disappear)', rollbackId, stamp, stamp);
    } finally {
      db.close();
    }

    await restoreDatabase({
      backupPath: backup.backupPath,
      destinationPath: liveCopy,
      force: true,
      safetyBackupDir: backupDir,
    });

    const after = toCutoverSnapshot(liveCopy);
    const verification = verifyPostRestore(before, after);
    console.log('');
    console.log(
      formatCutoverVerificationReport({
        label: 'Frozen-write rollback rehearsal',
        before,
        after,
        verification,
      }),
    );
    if (!cutoverVerificationPassed(verification)) process.exit(1);
  }

  console.log('');
  console.log('Cutover rehearsal passed on disposable infrastructure.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
