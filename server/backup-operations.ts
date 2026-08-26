import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  backupDatabase,
  inspectDatabase,
  rehearseBackupRestore,
  rehearsalPassed,
} from './backup.ts';

export const DEFAULT_REMOTE_KEEP = 14;
export const DEFAULT_MAX_BACKUP_AGE_MS = 26 * 60 * 60 * 1000;

export interface StoredBackup {
  key: string;
  size: number;
  lastModified: string;
  metadata?: Record<string, string>;
}

export interface BackupObjectStore {
  put(options: {
    key: string;
    filePath: string;
    contentLength: number;
    checksumSha256: string;
  }): Promise<void>;
  list(prefix: string): Promise<StoredBackup[]>;
  remove(key: string): Promise<void>;
  download(key: string, destinationPath: string): Promise<void>;
}

export interface BackupNotifier {
  notify(message: string): Promise<void>;
}

export interface OperationMarker {
  operation: 'backup' | 'rehearsal';
  status: 'SUCCESS' | 'FAILURE';
  recordedAt: string;
  detail: string;
}

const BACKUP_OBJECT = /^snapshots\/command-center-\d{8}T\d{9}Z\.db$/;
const SECRET = /(token|secret|password|credential|authorization|cookie|key)/i;

export function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function safeFailure(error: unknown): string {
  const fallback = 'Backup operation failed; inspect the private service log.';
  if (!(error instanceof Error)) return fallback;
  const firstLine = error.message.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine || SECRET.test(firstLine)) return fallback;
  return firstLine.slice(0, 240);
}

export function writeOperationMarker(markerDir: string, marker: OperationMarker): string {
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, `${marker.operation}.json`);
  const temporary = `${markerPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, markerPath);
  return markerPath;
}

export function readOperationMarker(markerDir: string, operation: OperationMarker['operation']) {
  const markerPath = path.join(markerDir, `${operation}.json`);
  if (!fs.existsSync(markerPath)) return null;
  return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as OperationMarker;
}

export async function pruneRemoteBackups(options: {
  store: BackupObjectStore;
  prefix?: string;
  keep?: number;
}) {
  const prefix = options.prefix ?? 'snapshots/';
  const keep = Math.max(1, options.keep ?? DEFAULT_REMOTE_KEEP);
  const objects = (await options.store.list(prefix))
    .filter((object) => BACKUP_OBJECT.test(object.key))
    .sort((a, b) => b.key.localeCompare(a.key));
  const kept = objects.slice(0, keep);
  const removed: StoredBackup[] = [];
  for (const object of objects.slice(keep)) {
    await options.store.remove(object.key);
    removed.push(object);
  }
  return { kept, removed };
}

export async function runOffsiteBackup(options: {
  sourcePath: string;
  backupDir: string;
  markerDir: string;
  store: BackupObjectStore;
  notifier?: BackupNotifier;
  keyAvailable?: () => boolean;
  keep?: number;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  try {
    if (options.keyAvailable && !options.keyAvailable()) {
      throw new Error('The separately stored Drive-token encryption key is unavailable.');
    }
    const snapshot = await backupDatabase({
      sourcePath: options.sourcePath,
      backupDir: options.backupDir,
      now,
    });
    const stat = fs.statSync(snapshot.backupPath);
    const checksumSha256 = sha256File(snapshot.backupPath);
    const key = `snapshots/${path.basename(snapshot.backupPath)}`;
    await options.store.put({
      key,
      filePath: snapshot.backupPath,
      contentLength: stat.size,
      checksumSha256,
    });
    const remote = (await options.store.list('snapshots/')).find((object) => object.key === key);
    if (!remote || remote.size !== stat.size)
      throw new Error('Uploaded backup could not be verified.');
    const retention = await pruneRemoteBackups({ store: options.store, keep: options.keep });
    writeOperationMarker(options.markerDir, {
      operation: 'backup',
      status: 'SUCCESS',
      recordedAt: now.toISOString(),
      detail: key,
    });
    return { snapshot, key, checksumSha256, retention };
  } catch (error) {
    const detail = safeFailure(error);
    writeOperationMarker(options.markerDir, {
      operation: 'backup',
      status: 'FAILURE',
      recordedAt: now.toISOString(),
      detail,
    });
    await options.notifier?.notify(`Hybrid Command Center off-site backup failed: ${detail}`);
    throw error;
  }
}

export async function runOffsiteRehearsal(options: {
  key: string;
  disposableDir: string;
  markerDir: string;
  store: BackupObjectStore;
  notifier?: BackupNotifier;
  now?: Date;
}) {
  const now = options.now ?? new Date();
  fs.mkdirSync(options.disposableDir, { recursive: true });
  const downloaded = path.join(options.disposableDir, path.basename(options.key));
  try {
    await options.store.download(options.key, downloaded);
    const initial = inspectDatabase(downloaded);
    if (!initial.integrityOk || !initial.foreignKeysOk)
      throw new Error('Downloaded backup failed database checks.');
    const result = await rehearseBackupRestore({
      sourcePath: downloaded,
      backupDir: options.disposableDir,
      now,
    });
    if (!rehearsalPassed(result)) throw new Error('Downloaded backup failed restore rehearsal.');
    writeOperationMarker(options.markerDir, {
      operation: 'rehearsal',
      status: 'SUCCESS',
      recordedAt: now.toISOString(),
      detail: options.key,
    });
    return result;
  } catch (error) {
    const detail = safeFailure(error);
    writeOperationMarker(options.markerDir, {
      operation: 'rehearsal',
      status: 'FAILURE',
      recordedAt: now.toISOString(),
      detail,
    });
    await options.notifier?.notify(`Hybrid Command Center restore rehearsal failed: ${detail}`);
    throw error;
  } finally {
    fs.rmSync(options.disposableDir, { recursive: true, force: true });
  }
}

export function backupHealth(options: {
  markerDir: string;
  freeBytes: number;
  totalBytes: number;
  now?: Date;
  maxAgeMs?: number;
}) {
  const now = options.now ?? new Date();
  const backup = readOperationMarker(options.markerDir, 'backup');
  const rehearsal = readOperationMarker(options.markerDir, 'rehearsal');
  const issues: string[] = [];
  if (!backup || backup.status === 'FAILURE') issues.push('OFFSITE_BACKUP_FAILED');
  else if (
    now.getTime() - Date.parse(backup.recordedAt) >
    (options.maxAgeMs ?? DEFAULT_MAX_BACKUP_AGE_MS)
  )
    issues.push('OFFSITE_BACKUP_STALE');
  if (rehearsal?.status === 'FAILURE') issues.push('RESTORE_REHEARSAL_FAILED');
  const freeRatio = options.totalBytes > 0 ? options.freeBytes / options.totalBytes : 0;
  if (freeRatio < 0.1) issues.push('DISK_FREE_CRITICAL');
  else if (freeRatio < 0.2) issues.push('DISK_FREE_WARNING');
  return { ok: issues.length === 0, issues, freeRatio, backup, rehearsal };
}
