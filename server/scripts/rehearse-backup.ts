import { config } from '../config.ts';
import {
  defaultBackupDir,
  formatRehearsalReport,
  parseBackupCli,
  rehearseBackupRestore,
  rehearsalPassed,
} from '../backup.ts';

const { options } = parseBackupCli(process.argv.slice(2));
const sourcePath = options.database || config.databasePath;
const backupDir = options.dir || defaultBackupDir(sourcePath);

try {
  const result = await rehearseBackupRestore({ sourcePath, backupDir });
  console.log(formatRehearsalReport(result));
  if (!rehearsalPassed(result)) process.exit(1);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
