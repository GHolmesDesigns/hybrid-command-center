import type { Db } from './db.ts';

type ClosableServer = {
  close(callback: (error?: Error) => void): unknown;
  closeAllConnections(): unknown;
};

type ShutdownRuntime = {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): unknown;
};

export const HTTP_SHUTDOWN_DRAIN_MS = 5_000;

/**
 * Stops new HTTP work before releasing SQLite. The guard matters because a second signal may
 * arrive while `server.close()` is draining an in-flight request; it must not close either
 * resource twice.
 */
export function closeOnSignals(
  server: ClosableServer,
  db: Pick<Db, 'close'>,
  runtime: ShutdownRuntime = process,
  drainMs = HTTP_SHUTDOWN_DRAIN_MS,
) {
  let stopping = false;
  let finished = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;

    const finish = (serverError?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(forceCloseTimer);
      let closeError: unknown = serverError;
      try {
        db.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) console.error('Command Center did not close cleanly:', closeError);
      runtime.exit(closeError ? 1 : 0);
    };

    // Long-lived MCP SSE responses are allowed to finish gracefully first. After this finite
    // bound, terminate any remaining HTTP connections so server.close() can release SQLite.
    const forceCloseTimer = setTimeout(() => {
      try {
        server.closeAllConnections();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }, drainMs);
    forceCloseTimer.unref();

    try {
      server.close(finish);
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  };

  runtime.once('SIGINT', stop);
  runtime.once('SIGTERM', stop);
  return stop;
}
