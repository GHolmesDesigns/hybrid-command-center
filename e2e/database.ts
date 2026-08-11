import fs from 'node:fs';
import path from 'node:path';

export const E2E_DATABASE_PATH = path.resolve(process.cwd(), 'data/e2e.db');

export function validateE2eDatabasePath(configuredPath = process.env.DATABASE_PATH) {
  if (!configuredPath) throw new Error('DATABASE_PATH must be set for E2E tests.');

  const resolvedPath = path.resolve(configuredPath);
  if (resolvedPath !== E2E_DATABASE_PATH) {
    throw new Error(
      `Refusing to reset non-E2E database: expected ${E2E_DATABASE_PATH}, received ${resolvedPath}`,
    );
  }
  return resolvedPath;
}

export function resetE2eDatabase(configuredPath = process.env.DATABASE_PATH) {
  const databasePath = validateE2eDatabasePath(configuredPath);
  for (const suffix of ['', '-journal', '-shm', '-wal'])
    fs.rmSync(`${databasePath}${suffix}`, { force: true });
  return databasePath;
}
