import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { closeOnSignals } from './shutdown.ts';

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
    const server = { close: vi.fn((done: (error?: Error) => void) => done()) };
    closeOnSignals(server, db, run);

    run.signals.emit('SIGTERM');
    run.signals.emit('SIGINT');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(db.close).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledWith(0);
  });

  it('exits non-zero when closing fails', () => {
    const run = runtime();
    const db = { close: vi.fn() };
    const error = new Error('listener close failed');
    const server = { close: vi.fn((done: (error?: Error) => void) => done(error)) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    closeOnSignals(server, db, run);
    run.signals.emit('SIGTERM');

    expect(db.close).toHaveBeenCalledTimes(1);
    expect(run.exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith('Command Center did not close cleanly:', error);
    log.mockRestore();
  });
});
