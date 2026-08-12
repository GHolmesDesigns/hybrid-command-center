import { config } from '../config.ts';
import { backupDatabase, defaultBackupDir, parseBackupCli } from '../backup.ts';

const { options } = parseBackupCli(process.argv.slice(2));
const sourcePath = options.database || config.databasePath;
const backupDir = options.dir || defaultBackupDir(sourcePath);

try {
  const result = await backupDatabase({ sourcePath, backupDir });
  console.log(`Backup written to ${result.backupPath}`);
  console.log(`SQLite pages copied: ${result.pages}`);
  console.log(
    'This snapshot includes committed WAL/journal pages. Keep GOOGLE_TOKEN_ENCRYPTION_KEY with it if Drive is connected.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
