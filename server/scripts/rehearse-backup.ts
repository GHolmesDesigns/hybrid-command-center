import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';
import {
  DEFAULT_BACKUP_KEEP,
  defaultBackupDir,
  formatRehearsalReport,
  parseBackupCli,
  parseKeepOption,
  pruneBackups,
  pruneRehearsalCopies,
  recordRehearsalOutcome,
  rehearseBackupRestore,
  rehearsalPassed,
} from '../backup.ts';

const { flags, options } = parseBackupCli(process.argv.slice(2));
const sourcePath = options.database || config.databasePath;
const backupDir = options.dir || defaultBackupDir(sourcePath);

const usage =
  'Usage: npm run db:backup:rehearse -- [--keep <count>] [--log <file>] [--database <path>] [--dir <backup-dir>]';

/**
 * A scheduled run leaves nothing on a console anyone reads, so `--log` is how it leaves a
 * trail. Appended, never truncated: the value of a rehearsal log is that it shows the run
 * before the one that broke.
 */
function appendLog(logPath: string, report: string) {
  const resolved = path.resolve(logPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.appendFileSync(
    resolved,
    `${'='.repeat(72)}\n${new Date().toISOString()}\n${report}\n`,
    'utf8',
  );
  return resolved;
}

try {
  if (flags.has('keep')) {
    throw new Error(
      `${usage}\n--keep needs a count: \`--keep 3\` keeps three snapshots, \`--keep 0\` keeps every one. Default: ${DEFAULT_BACKUP_KEEP}.`,
    );
  }
  if (flags.has('log')) throw new Error(`${usage}\n--log needs a file path.`);
  const keep = parseKeepOption(options.keep);

  const result = await rehearseBackupRestore({ sourcePath, backupDir });
  const passed = rehearsalPassed(result);
  const report = formatRehearsalReport(result);

  // The rehearsal takes a real snapshot and a full copy of it, so on a schedule it is the
  // fastest way to fill the directory this card exists to bound. Retention runs on its
  // output for the same reason it runs on `db:backup`'s, and only after the run finished.
  const snapshots = pruneBackups({ backupDir, keep, protect: [result.source.path] });
  const copies = pruneRehearsalCopies({ backupDir, keep });

  console.log(report);
  if (snapshots.pruned.length > 0 || copies.pruned.length > 0) {
    console.log(
      `Retention removed ${snapshots.pruned.length} older ${snapshots.pruned.length === 1 ? 'snapshot' : 'snapshots'} and ${copies.pruned.length} stale rehearsal ${copies.pruned.length === 1 ? 'copy' : 'copies'}.`,
    );
  }

  if (options.log) console.log(`Appended to ${appendLog(options.log, report)}`);

  const markerPath = recordRehearsalOutcome({ backupDir, passed, report });
  if (markerPath) console.error(`Recorded the failure at ${markerPath}`);

  if (!passed) process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  // A rehearsal that could not run is a rehearsal that did not pass. Anything else lets a
  // missing database or an unreadable backup directory read as a clean bill of health.
  if (!message.startsWith(usage)) {
    recordRehearsalOutcome({
      backupDir,
      passed: false,
      report: `Rehearsal could not run.\n${message}`,
    });
    if (options.log) appendLog(options.log, `Rehearsal could not run.\n${message}`);
  }
  process.exit(1);
}
