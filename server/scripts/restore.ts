import { config } from '../config.ts';
import { defaultBackupDir, inspectDatabase, parseBackupCli, restoreDatabase } from '../backup.ts';

const { flags, options, positionals } = parseBackupCli(process.argv.slice(2));
const backupPath = positionals[0];

if (!backupPath) {
  console.error(
    'Usage: npm run db:restore -- <backup-file> [--force] [--database <path>] [--dir <safety-dir>]',
  );
  process.exit(1);
}

const destinationPath = options.database || config.databasePath;
const safetyBackupDir = options.dir || defaultBackupDir(destinationPath);

try {
  const result = await restoreDatabase({
    backupPath,
    destinationPath,
    force: flags.has('force'),
    safetyBackupDir,
  });
  const snapshot = inspectDatabase(result.destinationPath);
  console.log(`Restored ${result.backupPath}`);
  console.log(`Destination: ${result.destinationPath}`);
  if (result.safetyBackupPath) console.log(`Previous database saved to ${result.safetyBackupPath}`);
  if (result.removedSidecars.length > 0) {
    console.log(`Removed leftover SQLite sidecars: ${result.removedSidecars.join(', ')}`);
  }
  console.log(
    `Integrity ${snapshot.integrityOk ? 'ok' : 'FAILED'}; clients ${snapshot.clients}, projects ${snapshot.projects}, tasks ${snapshot.tasks}; Drive folder refs ${snapshot.driveReferences.length}.`,
  );
  console.log(
    'Run `npm run db:migrate` if this backup predates the current schema, then start the app.',
  );
  console.log('Restore the matching GOOGLE_TOKEN_ENCRYPTION_KEY before reconnecting Drive.');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
