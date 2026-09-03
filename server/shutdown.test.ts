import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closeOnSignals, HTTP_SHUTDOWN_DRAIN_MS } from './shutdown.ts';

function runtime() {
  const signals = new EventEmitter();
  return {
    signals,
    exit: vi.fn(),
    once(signal: 'SIGINT' | 'SIGTERM', listener: () => void) {
      signals.once(signal, listener);
    },
  };
}

describe('production shutdown', () => {
  it('closes the server and database once and exits zero on SIGTERM', () => {
    const run = runtime();
    const db = { close: vi.fn() };
    const server = {
      close: vi.fn((done: (error?: Error) => void) => done()),
      closeAllConnections: vi.fn(),
    };
    closeOnSignals(server, db, run);

    run.signals.emit('SIGTERM');
    run.signals.emit('SIGINT');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when closing fails', () => {
    const run = runtime();
    const db = { close: vi.fn() };
    const error = new Error('listener close failed');
    const server = {
      close: vi.fn((done: (error?: Error) => void) => done(error)),
      closeAllConnections: vi.fn(),
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    closeOnSignals(server, db, run);
    run.signals.emit('SIGTERM');

    expect(db.close).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('Command Center did not close cleanly:', error);
    log.mockRestore();
  });

  it('force-closes connections only after the documented drain bound', () => {
    vi.useFakeTimers();
    try {
      const run = runtime();
      const db = { close: vi.fn() };
      let finish!: (error?: Error) => void;
      const server = {
        close: vi.fn((done: (error?: Error) => void) => {
          finish = done;
        }),
        closeAllConnections: vi.fn(() => finish()),
      };

      closeOnSignals(server, db, run);
      run.signals.emit('SIGTERM');
      vi.advanceTimersByTime(HTTP_SHUTDOWN_DRAIN_MS - 1);

      expect(server.closeAllConnections).not.toHaveBeenCalled();
      expect(db.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(db.close).toHaveBeenCalledTimes(1);
      expect(run.exit).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
