import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_VERSION } from '../shared/branding.ts';

interface PackageMetadata {
  version?: unknown;
  packages?: Record<string, { version?: unknown }>;
}

const readJson = (relativePath: string): PackageMetadata =>
  JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')) as PackageMetadata;

describe('application version metadata', () => {
  it('keeps every application version value aligned', () => {
    const packageJson = readJson('../package.json');
    const packageLockJson = readJson('../package-lock.json');

    expect({
      appVersion: APP_VERSION,
      packageVersion: packageJson.version,
      lockfileVersion: packageLockJson.version,
      lockfileRootPackageVersion: packageLockJson.packages?.['']?.version,
    }).toEqual({
      appVersion: APP_VERSION,
      packageVersion: APP_VERSION,
      lockfileVersion: APP_VERSION,
      lockfileRootPackageVersion: APP_VERSION,
    });
  });
});
