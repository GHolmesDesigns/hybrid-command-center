import path from 'node:path';
import { config } from '../config.ts';
import {
  DEFAULT_BACKUP_KEEP,
  backupDatabase,
  defaultBackupDir,
  formatRehearsalWarning,
  parseBackupCli,
  parseKeepOption,
  readRehearsalFailure,
} from '../backup.ts';

const { flags, options } = parseBackupCli(process.argv.slice(2));
const sourcePath = options.database || config.databasePath;
const backupDir = options.dir || defaultBackupDir(sourcePath);

try {
  // A bare `--keep` parses as a flag, not an option, and would otherwise fall through to
  // the default while reading as if it had set something.
  if (flags.has('keep')) {
    throw new Error(
      'Usage: npm run db:backup -- [--keep <count>] [--database <path>] [--dir <backup-dir>]\n' +
        `--keep needs a count: \`--keep 3\` keeps three snapshots, \`--keep 0\` keeps every one. Default: ${DEFAULT_BACKUP_KEEP}.`,
    );
  }
  const keep = parseKeepOption(options.keep);

  const result = await backupDatabase({ sourcePath, backupDir, keep });
  console.log(`Backup written to ${result.backupPath}`);
  console.log(`SQLite pages copied: ${result.pages}`);

  if (keep === 0) {
    console.log(`Retention off (--keep 0): ${result.kept.length} snapshots kept in ${backupDir}.`);
  } else if (result.pruned.length === 0) {
    console.log(`Retention keeps the newest ${keep}; ${result.kept.length} stored, none removed.`);
  } else {
    console.log(
      `Retention keeps the newest ${keep}; removed ${result.pruned.length} older ${result.pruned.length === 1 ? 'snapshot' : 'snapshots'}:`,
    );
    for (const pruned of result.pruned) console.log(`  - ${path.basename(pruned)}`);
  }

  console.log(
    'This snapshot includes committed WAL/journal pages. Keep GOOGLE_TOKEN_ENCRYPTION_KEY with it if Drive is connected.',
  );

  const failure = readRehearsalFailure(backupDir);
  if (failure) console.warn(formatRehearsalWarning(failure));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
