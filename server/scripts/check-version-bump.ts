/**
 * Fails when the current branch has not moved the application version past the
 * base branch. Complements the version-consistency test: that one asks whether
 * the four version values agree with each other, this one asks whether the
 * version actually moved.
 *
 * The comparison is against the base branch *tip*, not the merge base. Two
 * branches cut from the same commit can both bump correctly and independently
 * land on the same number; their merge base still holds the older version, so a
 * merge-base comparison passes both. Comparing against the tip catches the
 * second one once the first has merged.
 *
 * Exits 0 and explains itself when the comparison is not meaningful, rather
 * than passing silently.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const DEFAULT_BASE = 'origin/main';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const baseRef =
  process.argv.slice(2).find((arg) => !arg.startsWith('-')) ?? process.env.BASE_REF ?? DEFAULT_BASE;

const git = (...args: string[]) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const skip: (reason: string) => never = (reason) => {
  console.log(`check:version-bump skipped — ${reason}`);
  process.exit(0);
};

const fail: (message: string) => never = (message) => {
  console.error(`check:version-bump failed — ${message}`);
  process.exit(1);
};

const tryGit = (...args: string[]) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

const versionAt = (ref: string) => {
  const raw = tryGit('show', `${ref}:package.json`);
  if (raw === null) return null;
  try {
    return (JSON.parse(raw) as { version?: unknown }).version;
  } catch {
    return null;
  }
};

const parse = (version: string) => {
  const match = SEMVER.exec(version);
  return match ? match.slice(1, 4).map(Number) : null;
};

/** Positive when a is newer than b, negative when older, zero when identical. */
const compare = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

if (tryGit('rev-parse', '--git-dir') === null) {
  skip('not a Git checkout, so there is no base branch to compare against.');
}

const baseCommit = tryGit('rev-parse', '--verify', `${baseRef}^{commit}`);
if (baseCommit === null) {
  skip(`base ref '${baseRef}' could not be resolved. Fetch it, or pass another ref.`);
}

const headCommit = tryGit('rev-parse', 'HEAD');
if (headCommit === null) {
  skip('HEAD could not be resolved.');
}

const currentVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;
const baseVersion = versionAt(baseRef);

if (typeof baseVersion !== 'string') {
  skip(`no readable version in package.json at '${baseRef}'.`);
}

const current = parse(currentVersion);
const base = parse(baseVersion);

if (!current || !base) {
  skip(
    `version is not a plain MAJOR.MINOR.PATCH value (this branch '${currentVersion}', ${baseRef} '${baseVersion}').`,
  );
}

const order = compare(current, base);

if (order === 0) {
  if (headCommit === baseCommit) {
    skip(
      `HEAD is '${baseRef}' itself and carries the same version, so there is nothing to compare.`,
    );
  }
  const mergeBase = tryGit('merge-base', 'HEAD', baseRef);
  const mergeBaseVersion = mergeBase ? versionAt(mergeBase) : null;
  fail(
    `this branch is ${currentVersion} and ${baseRef} is already ${baseVersion}. ` +
      (mergeBaseVersion === currentVersion
        ? 'The version was never bumped on this branch.'
        : `The branch bumped from ${String(mergeBaseVersion)}, but ${baseRef} reached the same number first — another card has already shipped as ${baseVersion}.`) +
      ' Rebase and bump again.',
  );
}

if (order < 0) {
  fail(
    `this branch is ${currentVersion} but ${baseRef} is already ${baseVersion}. ` +
      'The branch is behind; rebase and bump past it.',
  );
}

console.log(
  `check:version-bump passed — ${currentVersion} is ahead of ${baseRef} (${baseVersion}).`,
);
