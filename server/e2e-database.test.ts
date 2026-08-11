import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_DATABASE_PATH, validateE2eDatabasePath } from '../e2e/database.ts';

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
});
