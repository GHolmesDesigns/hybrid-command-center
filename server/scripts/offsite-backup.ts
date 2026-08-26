import fs from 'node:fs';
import path from 'node:path';
import { AwsCliBackupStore, AwsSnsNotifier } from '../aws-backup-store.ts';
import { backupHealth, runOffsiteBackup, runOffsiteRehearsal } from '../backup-operations.ts';
import { config } from '../config.ts';

const bucket = process.env.HCC_BACKUP_BUCKET?.trim();
const topicArn = process.env.HCC_ALERT_TOPIC_ARN?.trim();
const stateDir =
  process.env.HCC_BACKUP_STATE_DIR?.trim() || '/var/lib/hybrid-command-center/backup-state';
const backupDir =
  process.env.HCC_BACKUP_DIR?.trim() || path.join(path.dirname(config.databasePath), 'backups');
if (!bucket) throw new Error('HCC_BACKUP_BUCKET is required.');
if (!topicArn) throw new Error('HCC_ALERT_TOPIC_ARN is required.');

const store = new AwsCliBackupStore(bucket);
const notifier = new AwsSnsNotifier(topicArn);
const command = process.argv[2];

if (command === 'backup') {
  const result = await runOffsiteBackup({
    sourcePath: config.databasePath,
    backupDir,
    markerDir: stateDir,
    store,
    notifier,
    keyAvailable: () => Boolean(process.env.GOOGLE_TOKEN_ENCRYPTION_KEY?.trim()),
  });
  console.log(
    `Uploaded ${result.key}; ${result.retention.kept.length} successful snapshots retained.`,
  );
} else if (command === 'rehearse') {
  const latest = (await store.list('snapshots/')).sort((a, b) => b.key.localeCompare(a.key))[0];
  if (!latest) throw new Error('No off-site snapshot exists to rehearse.');
  await runOffsiteRehearsal({
    key: latest.key,
    disposableDir: path.join(backupDir, '.rehearsal'),
    markerDir: stateDir,
    store,
    notifier,
  });
  console.log(`Restore rehearsal passed for ${latest.key}.`);
} else if (command === 'health') {
  const stats = fs.statfsSync(path.dirname(config.databasePath));
  const health = backupHealth({
    markerDir: stateDir,
    freeBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  });
  if (!health.ok) {
    const message = `Hybrid Command Center backup health alert: ${health.issues.join(', ')}`;
    await notifier.notify(message);
    console.error(message);
    process.exitCode = 1;
  } else console.log('Backup age, rehearsal state, and disk pressure are healthy.');
} else {
  throw new Error('Usage: offsite-backup.ts <backup|rehearse|health>');
}
