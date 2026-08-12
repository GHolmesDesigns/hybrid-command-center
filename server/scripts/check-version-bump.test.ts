import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The script that enforces "every merged card ships a version bump". It is worth testing
 * because the rule it guards is easy to get wrong in a way nothing else notices: two cards
 * cut from the same commit can both bump correctly and both land on the same number, and
 * only a comparison against the base branch *tip* catches the second one.
 *
 * Driven as a real process against real throwaway repositories, because what the script
 * does is read Git — mocking that away would leave nothing worth asserting.
 */

const SCRIPT = fileURLToPath(new URL('./check-version-bump.ts', import.meta.url));

let repo: string;

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const setVersion = (version: string) =>
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }, null, 2));

const commit = (version: string, message = `ship ${version}`) => {
  setVersion(version);
  // Something always changes, so a commit that deliberately leaves the version alone is
  // still a commit rather than a Git error about having nothing to record.
  fs.writeFileSync(path.join(repo, 'card.txt'), message);
  git('add', '.');
  git('commit', '-m', message);
};

/** Runs the script the way `npm run check:version-bump` does, from inside the repository. */
function check(baseRef: string) {
  try {
    const stdout = execFileSync('node', ['--experimental-strip-types', SCRIPT, baseRef], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, output: `${failure.stdout}${failure.stderr}` };
  }
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-version-'));
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Version Test');
  git('config', 'commit.gpgsign', 'false');
  commit('2.10.0', 'initial');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('check:version-bump', () => {
  it('passes when the branch moved the version past the base', () => {
    git('checkout', '-b', 'card');
    commit('2.10.1');

    const result = check('main');
    expect(result.status).toBe(0);
    expect(result.output).toContain('passed — 2.10.1 is ahead of main (2.10.0)');
  });

  it('passes on a minor and on a major, not only on a patch', () => {
    git('checkout', '-b', 'card');
    commit('2.11.0');
    expect(check('main').status).toBe(0);
    commit('3.0.0');
    expect(check('main').status).toBe(0);
  });

  it('fails when the branch never bumped at all', () => {
    git('checkout', '-b', 'card');
    commit('2.10.0', 'a card that forgot the bump');

    const result = check('main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('The version was never bumped on this branch.');
  });

  it('fails when another card reached the same number first', () => {
    // The case that a merge-base comparison lets through, and the one that actually
    // happens: two branches cut from 2.10.0, both correctly bump to 2.10.1, and the second
    // one to merge would otherwise ship a version that is already taken.
    git('checkout', '-b', 'card');
    commit('2.10.1');
    git('checkout', 'main');
    commit('2.10.1', 'the other card, merged first');
    git('checkout', 'card');

    const result = check('main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('another card has already shipped as 2.10.1');
    expect(result.output).toContain('Rebase and bump again.');
  });

  it('fails when the branch is behind the base', () => {
    git('checkout', '-b', 'card');
    git('checkout', 'main');
    commit('2.11.0');
    git('checkout', 'card');

    const result = check('main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('The branch is behind; rebase and bump past it.');
  });

  it('compares by number rather than by text, so 2.9.9 is older than 2.10.0', () => {
    // '2.9.9' > '2.10.0' as a string. The rule is semver, not lexicographic.
    git('checkout', '-b', 'card');
    commit('2.9.9');

    const result = check('main');
    expect(result.status).toBe(1);
    expect(result.output).toContain('The branch is behind');
  });

  it('skips rather than fails when the base ref cannot be resolved', () => {
    // A shallow CI checkout has no such ref. Failing there would block every pull request
    // for a reason that has nothing to do with the card.
    const result = check('origin/not-a-branch');
    expect(result.status).toBe(0);
    expect(result.output).toContain("base ref 'origin/not-a-branch' could not be resolved");
  });

  it('skips when HEAD is the base branch itself', () => {
    const result = check('main');
    expect(result.status).toBe(0);
    expect(result.output).toContain('there is nothing to compare');
  });

  it('skips when the version is not a plain MAJOR.MINOR.PATCH value', () => {
    git('checkout', '-b', 'card');
    commit('2.11.0-rc.1');

    const result = check('main');
    expect(result.status).toBe(0);
    expect(result.output).toContain('is not a plain MAJOR.MINOR.PATCH value');
  });

  it('reads the base version from the ref rather than from the working tree', () => {
    git('checkout', '-b', 'card');
    commit('2.10.1');
    // An uncommitted edit must not decide the answer either way.
    setVersion('2.10.1');

    expect(check('main').status).toBe(0);
  });
});
