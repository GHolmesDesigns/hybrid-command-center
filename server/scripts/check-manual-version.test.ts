import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The script that catches the manual falling behind `package.json` — the exact way it once
 * sat at 5.4.0 through four releases with nothing failing red. Driven as a real process
 * against a throwaway directory, because what the script does is read files relative to
 * its working directory; mocking that away would leave nothing worth asserting.
 */

const SCRIPT = fileURLToPath(new URL('./check-manual-version.ts', import.meta.url));

const stampedManual = (version: string) => `<!doctype html>
<html>
  <body>
    <aside class="rail">
      <div class="railfoot">
        <b>G.Holmes Designs</b><br />
        Version ${version}<br />
        Local-first &middot; hosted-capable
      </div>
    </aside>
    <header class="masthead">
      <p class="eyebrow">
        <span>G.Holmes Designs &middot; Studio operations</span>
        <span class="draft">Release ${version}</span>
      </p>
      <dl class="stats">
        <div class="stat">
          <dt>Version</dt>
          <dd>${version}</dd>
        </div>
      </dl>
    </header>
    <footer class="footer">
      <p>
        Hybrid Command Center ${version} &mdash; operating manual, updated 2026-08-28. Compiled
        from <code>USER_MANUAL.md</code>.
      </p>
      <p>5.4.2 splits that runbook into two columns, and it is pinned by tests since 5.4.1.</p>
    </footer>
  </body>
</html>
`;

let dir: string;

const write = (relPath: string, content: string) => {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

const setAppVersion = (version: string) =>
  write('package.json', JSON.stringify({ version }, null, 2));

const setManual = (version: string) =>
  write('docs/manual/hybrid-command-center-manual.html', stampedManual(version));

function check() {
  try {
    const stdout = execFileSync('node', ['--experimental-strip-types', SCRIPT], {
      cwd: dir,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-manual-version-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('check:manual-version', () => {
  it('passes when every stamp agrees with package.json', () => {
    setAppVersion('5.5.1');
    setManual('5.5.1');

    const result = check();
    expect(result.status).toBe(0);
    expect(result.output).toContain("passed — the manual's stamps agree with 5.5.1");
  });

  it('never flags a historical attribution embedded beside the stamps', () => {
    // The fixture footer always carries "5.4.2 splits..." and "since 5.4.1" regardless of
    // the current version — if the script matched on a bare version-number pattern instead
    // of markup anchored to each specific stamp, these would false-positive as a fifth and
    // sixth stamp.
    setAppVersion('6.0.0');
    setManual('6.0.0');

    const result = check();
    expect(result.status).toBe(0);
  });

  it('fails when the manual was never bumped past the last release', () => {
    setAppVersion('5.5.1');
    setManual('5.5.0');

    const result = check();
    expect(result.status).toBe(1);
    expect(result.output).toContain('package.json is 5.5.1');
    expect(result.output).toContain('rail footer (5.5.0)');
    expect(result.output).toContain('masthead badge (5.5.0)');
    expect(result.output).toContain('stats block (5.5.0)');
    expect(result.output).toContain('colophon (5.5.0)');
  });

  it('fails when only one stamp was missed', () => {
    setAppVersion('5.5.1');
    const html = stampedManual('5.5.1').replace(
      '<span class="draft">Release 5.5.1</span>',
      '<span class="draft">Release 5.5.0</span>',
    );
    write('docs/manual/hybrid-command-center-manual.html', html);

    const result = check();
    expect(result.status).toBe(1);
    expect(result.output).toContain('masthead badge (5.5.0)');
    expect(result.output).not.toContain('rail footer (5.5.0)');
  });

  it('fails loudly rather than skipping when a stamp cannot be found at all', () => {
    setAppVersion('5.5.1');
    write(
      'docs/manual/hybrid-command-center-manual.html',
      '<html><body>no stamps here</body></html>',
    );

    const result = check();
    expect(result.status).toBe(1);
    expect(result.output).toContain('could not find');
    expect(result.output).toContain('rail footer');
  });

  it('fails loudly when the manual is missing entirely', () => {
    setAppVersion('5.5.1');

    const result = check();
    expect(result.status).toBe(1);
    expect(result.output).toContain('could not read');
  });
});
