/**
 * The guard both E2E servers stop on, so neither can outlive the run that started it.
 *
 * Playwright tears its web servers down when the suite ends, passing or failing. On POSIX
 * that is a signal to the process group; on Windows there are no signals, so it force-kills
 * the tree instead — and a run that is interrupted before teardown ever happens, by a
 * command timeout or a Ctrl+C in the wrong window, kills the runner and nothing under it.
 *
 * Signals cover POSIX and Ctrl+C. Stdin EOF covers a parent that closed its pipes.
 * The parent-PID watchdog covers the rest: Playwright's Windows path is `cmd.exe`, and
 * losing that process means the run is over whether or not stdin ever ended. The one cost
 * of the stdin watch is that a server launched with stdin already closed stops immediately
 * — launch it through Playwright or a terminal, both of which give it a real stdin.
 */
export function stopWhenTheRunEnds(name: string, close: () => Promise<void> | void) {
  let stopping = false;
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = true;
    clearInterval(watchdog);
    console.log(`Stopping the E2E ${name} (${reason}).`);
    // Nothing may outlive the run, so a close that will not finish still exits.
    setTimeout(() => process.exit(0), 5_000).unref();
    void Promise.resolve()
      .then(close)
      .catch((error: unknown) => console.error(`E2E ${name} did not close cleanly:`, error))
      .then(() => process.exit(0));
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)
    process.on(signal, () => stop(signal));

  const parentPid = process.ppid;
  const watchdog = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      stop('parent gone');
    }
  }, 250);
  watchdog.unref();

  process.stdin.on('end', () => stop('stdin closed'));
  process.stdin.on('error', () => stop('stdin closed'));
  process.stdin.resume();

  return stop;
}
