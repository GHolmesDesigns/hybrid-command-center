import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_DATABASE_PATH, resetE2eDatabase, validateE2eDatabasePath } from './database.ts';

describe('E2E database safety', () => {
  it('accepts only the dedicated E2E database path', () => {
    expect(validateE2eDatabasePath('./data/e2e.db')).toBe(E2E_DATABASE_PATH);
  });

  it('rejects the application database path', () => {
    expect(() => validateE2eDatabasePath('./data/command-center.db')).toThrow(
      'Refusing to reset non-E2E database',
    );
  });

  it('rejects another file with the same basename', () => {
    expect(() => validateE2eDatabasePath(path.join('other', 'e2e.db'))).toThrow(
      'Refusing to reset non-E2E database',
    );
  });

  it('removes the dedicated E2E database and its SQLite sidecar files', () => {
    const databasePath = validateE2eDatabasePath('./data/e2e.db');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.writeFileSync(databasePath, '');
    fs.writeFileSync(`${databasePath}-wal`, '');
    expect(resetE2eDatabase('./data/e2e.db')).toBe(databasePath);
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.existsSync(`${databasePath}-wal`)).toBe(false);
  });
});
