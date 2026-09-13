/**
 * Shared semver helpers for release finalization and version:next.
 */
import { execFileSync } from 'node:child_process';

export const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export const tryGit = (...args: string[]) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

export const parseVersion = (version: string) => {
  const match = SEMVER.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
};

export const formatVersion = (parts: number[]) => `${parts[0]}.${parts[1]}.${parts[2]}`;

/** Positive when a is newer than b, negative when older, zero when identical. */
export const compareVersions = (a: number[], b: number[]) =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const bumpPatch = (version: string) => {
  const parts = parseVersion(version);
  if (!parts) return null;
  parts[2] += 1;
  return formatVersion(parts);
};

export const bumpMinor = (version: string) => {
  const parts = parseVersion(version);
  if (!parts) return null;
  parts[1] += 1;
  parts[2] = 0;
  return formatVersion(parts);
};

export const versionAtRef = (ref: string) => {
  const raw = tryGit('show', `${ref}:package.json`);
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as { version?: unknown }).version;
  } catch {
    return null;
  }
};

export interface NextVersionOptions {
  baseRef?: string;
  milestone?: string;
  forceMinor?: boolean;
  forcePatch?: boolean;
}

/**
 * First card closed in a milestone takes the minor bump; later cards take patch.
 * Without a milestone, defaults to patch.
 */
export const resolveNextVersion = (options: NextVersionOptions = {}) => {
  const baseRef = options.baseRef ?? 'origin/main';
  const baseVersion = versionAtRef(baseRef);
  if (typeof baseVersion !== 'string') {
    throw new Error(`Could not read version from ${baseRef}. Run git fetch origin main.`);
  }
  if (!parseVersion(baseVersion)) {
    throw new Error(`Version at ${baseRef} is not MAJOR.MINOR.PATCH: ${baseVersion}`);
  }

  if (options.forceMinor) {
    const next = bumpMinor(baseVersion);
    if (!next) throw new Error(`Could not bump minor from ${baseVersion}`);
    return { baseVersion, nextVersion: next, bumpKind: 'minor' as const };
  }
  if (options.forcePatch) {
    const next = bumpPatch(baseVersion);
    if (!next) throw new Error(`Could not bump patch from ${baseVersion}`);
    return { baseVersion, nextVersion: next, bumpKind: 'patch' as const };
  }

  if (options.milestone) {
    const closed = milestoneClosedCount(options.milestone);
    if (closed === null) {
      throw new Error(
        `Could not resolve milestone "${options.milestone}". Pass --minor or --patch explicitly.`,
      );
    }
    const bumpKind = closed === 0 ? ('minor' as const) : ('patch' as const);
    const next = bumpKind === 'minor' ? bumpMinor(baseVersion) : bumpPatch(baseVersion);
    if (!next) throw new Error(`Could not compute next version from ${baseVersion}`);
    return { baseVersion, nextVersion: next, bumpKind };
  }

  const next = bumpPatch(baseVersion);
  if (!next) throw new Error(`Could not bump patch from ${baseVersion}`);
  return { baseVersion, nextVersion: next, bumpKind: 'patch' as const };
};

/** Returns closed issue count for a milestone title match, or null when gh is unavailable. */
export const milestoneClosedCount = (title: string) => {
  const repo = process.env.GITHUB_REPOSITORY ?? tryGit('remote', 'get-url', 'origin');
  let slug: string | null = null;
  if (process.env.GITHUB_REPOSITORY) {
    slug = process.env.GITHUB_REPOSITORY;
  } else if (repo) {
    const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(repo);
    slug = match?.[1] ?? null;
  }
  if (!slug) return null;

  try {
    const raw = execFileSync('gh', ['api', `repos/${slug}/milestones`, '--paginate'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const rows = JSON.parse(raw) as { title: string; closed_issues: number }[];
    for (const row of rows) {
      if (row.title === title || row.title.includes(title) || title.includes(row.title)) {
        return row.closed_issues;
      }
    }
    return null;
  } catch {
    return null;
  }
};
