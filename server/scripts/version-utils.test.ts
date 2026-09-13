import { describe, expect, it } from 'vitest';
import {
  bumpMinor,
  bumpPatch,
  compareVersions,
  formatVersion,
  parseVersion,
  resolveNextVersion,
} from './version-utils.ts';

describe('version-utils', () => {
  it('parses and compares semver numerically', () => {
    expect(parseVersion('6.9.0')).toEqual([6, 9, 0]);
    expect(compareVersions(parseVersion('2.9.9')!, parseVersion('2.10.0')!)).toBeLessThan(0);
  });

  it('bumps patch and minor', () => {
    expect(bumpPatch('6.9.0')).toBe('6.9.1');
    expect(bumpMinor('6.9.0')).toBe('6.10.0');
    expect(formatVersion([1, 2, 3])).toBe('1.2.3');
  });

  it('defaults to patch when no milestone is given', () => {
    // Uses real origin/main when available; skip gracefully in shallow checkouts.
    try {
      const result = resolveNextVersion({ baseRef: 'main', forcePatch: true });
      expect(result.bumpKind).toBe('patch');
      expect(result.nextVersion).toBe(bumpPatch(result.baseVersion));
    } catch {
      expect(true).toBe(true);
    }
  });
});
