import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE = fileURLToPath(new URL('./shutdown.fixture.ts', import.meta.url));

function spawnFixture(args: string[] = []) {
  return spawn(process.execPath, ['--experimental-strip-types', FIXTURE, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function waitForMatch(child: ChildProcess, pattern: RegExp, timeoutMs = 5_000) {
  return new Promise<RegExpMatchArray>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = pattern.exec(output);
      if (!match) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      resolve(match);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      if (pattern.exec(output)) return;
      clearTimeout(timer);
      reject(new Error(`Process exited ${code} before matching ${pattern}. Output:\n${output}`));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000) {
  return new Promise<number>((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Timed out waiting for the fixture to exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pid ${pid} was still alive after ${timeoutMs}ms`);
}

describe('E2E shutdown guard', () => {
  it('exits when stdin closes', async () => {
    const child = spawnFixture();
    await waitForMatch(child, /READY \d+/);
    child.stdin?.end();
    await expect(waitForExit(child)).resolves.toBe(0);
  });

  it('exits when the parent process dies', async () => {
    const parent = spawnFixture(['--parent']);
    const match = await waitForMatch(parent, /CHILD (\d+)/);
    const childPid = Number(match[1]);
    expect(childPid).toBeGreaterThan(0);
    parent.kill();
    await waitUntilDead(childPid);
  });

  it('treats a second stop as a no-op', async () => {
    const child = spawnFixture();
    const ready = await waitForMatch(child, /READY (\d+)/);
    const port = ready[1];
    let output = ready[0];
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString();
    });
    const response = await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST' });
    expect(response.status).toBe(204);
    await expect(waitForExit(child)).resolves.toBe(0);
    expect(output.match(/Stopping the E2E fixture/g)).toHaveLength(1);
  });
});
