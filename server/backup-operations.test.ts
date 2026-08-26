import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import {
  backupHealth,
  type BackupObjectStore,
  pruneRemoteBackups,
  runOffsiteBackup,
  runOffsiteRehearsal,
  safeFailure,
} from './backup-operations.ts';

class FakeStore implements BackupObjectStore {
  objects = new Map<string, Buffer>();
  failPut = false;
  partialPut = false;
  async put(options: { key: string; filePath: string }) {
    if (this.failPut) throw new Error('simulated upload failure');
    this.objects.set(options.key, fs.readFileSync(options.filePath));
    if (this.partialPut) throw new Error('simulated interrupted upload');
  }
  async list(prefix: string) {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({
        key,
        size: value.length,
        lastModified: '2026-08-01T00:00:00.000Z',
      }));
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async download(key: string, destinationPath: string) {
    const value = this.objects.get(key);
    if (!value) throw new Error('missing object');
    fs.writeFileSync(destinationPath, value);
  }
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-offsite-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function database(name = 'command-center.db') {
  const file = path.join(root, name);
  const db = createDb(file);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('google_tokens', 'encrypted.payload', '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.close();
  return file;
}

describe('off-site backup operations', () => {
  it('uploads a consistent snapshot, verifies it, and records success', async () => {
    const store = new FakeStore();
    const result = await runOffsiteBackup({
      sourcePath: database(),
      backupDir: path.join(root, 'backups'),
      markerDir: path.join(root, 'health'),
      store,
      now: new Date('2026-08-12T02:00:00Z'),
    });
    expect(result.key).toBe('snapshots/command-center-20260812T020000000Z.db');
    expect(result.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      backupHealth({
        markerDir: path.join(root, 'health'),
        freeBytes: 50,
        totalBytes: 100,
        now: new Date('2026-08-12T03:00:00Z'),
      }).ok,
    ).toBe(true);
  });

  it('retains the newest 14 and never deletes the last known good object', async () => {
    const store = new FakeStore();
    for (let day = 1; day <= 16; day++)
      store.objects.set(
        `snapshots/command-center-202608${String(day).padStart(2, '0')}T020000000Z.db`,
        Buffer.from(String(day)),
      );
    const result = await pruneRemoteBackups({ store, keep: 14 });
    expect(result.kept).toHaveLength(14);
    expect(result.removed).toHaveLength(2);
    expect((await pruneRemoteBackups({ store, keep: 0 })).kept).toHaveLength(1);
  });

  it('leaves failure evidence and sends only a redacted notification', async () => {
    const store = new FakeStore();
    store.failPut = true;
    const notices: string[] = [];
    await expect(
      runOffsiteBackup({
        sourcePath: database('missing-key.db'),
        backupDir: path.join(root, 'backups'),
        markerDir: path.join(root, 'health'),
        store,
        notifier: {
          notify: async (message) => {
            notices.push(message);
          },
        },
      }),
    ).rejects.toThrow(/upload failure/);
    expect(notices[0]).toContain('simulated upload failure');
    expect(safeFailure(new Error('Authorization token=super-secret'))).not.toContain(
      'super-secret',
    );
    expect(
      backupHealth({ markerDir: path.join(root, 'health'), freeBytes: 15, totalBytes: 100 }).issues,
    ).toEqual(expect.arrayContaining(['OFFSITE_BACKUP_FAILED', 'DISK_FREE_WARNING']));
  });

  it('does not prune known-good objects after a partial upload or when the separate key is missing', async () => {
    const store = new FakeStore();
    store.objects.set('snapshots/command-center-20260801T020000000Z.db', Buffer.from('known-good'));
    store.partialPut = true;
    await expect(
      runOffsiteBackup({
        sourcePath: database(),
        backupDir: path.join(root, 'backups'),
        markerDir: path.join(root, 'health'),
        store,
        keep: 1,
      }),
    ).rejects.toThrow(/interrupted upload/);
    expect(store.objects.has('snapshots/command-center-20260801T020000000Z.db')).toBe(true);

    await expect(
      runOffsiteBackup({
        sourcePath: database('missing-key.db'),
        backupDir: path.join(root, 'other-backups'),
        markerDir: path.join(root, 'health'),
        store: new FakeStore(),
        keyAvailable: () => false,
      }),
    ).rejects.toThrow(/encryption key is unavailable/);
  });

  it('downloads to a disposable copy and rehearses integrity, references, and encrypted-token presence', async () => {
    const store = new FakeStore();
    const source = database();
    store.objects.set('snapshots/good.db', fs.readFileSync(source));
    const result = await runOffsiteRehearsal({
      key: 'snapshots/good.db',
      disposableDir: path.join(root, 'disposable'),
      markerDir: path.join(root, 'health'),
      store,
    });
    expect(result.encryptedTokensPreserved).toBe(true);
    expect(fs.existsSync(path.join(root, 'disposable'))).toBe(false);
  });

  it('rejects corrupt downloaded content and records the failed rehearsal', async () => {
    const store = new FakeStore();
    store.objects.set('snapshots/bad.db', Buffer.from('not sqlite'));
    await expect(
      runOffsiteRehearsal({
        key: 'snapshots/bad.db',
        disposableDir: path.join(root, 'disposable'),
        markerDir: path.join(root, 'health'),
        store,
      }),
    ).rejects.toThrow();
    expect(
      backupHealth({ markerDir: path.join(root, 'health'), freeBytes: 100, totalBytes: 100 })
        .issues,
    ).toContain('RESTORE_REHEARSAL_FAILED');
  });
});
