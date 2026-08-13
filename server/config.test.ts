import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep these hermetic: a developer's real .env must not decide what the defaults are.
vi.mock('dotenv/config', () => ({}));

const loadConfig = async () => {
  vi.resetModules();
  return (await import('./config.ts')).config;
};

describe('API host binding', () => {
  const original = process.env.HOST;
  afterEach(() => {
    if (original === undefined) delete process.env.HOST;
    else process.env.HOST = original;
  });

  it('binds loopback by default so the unauthenticated API is not reachable from the LAN', async () => {
    delete process.env.HOST;
    expect((await loadConfig()).host).toBe('127.0.0.1');
  });

  it('honors an explicit HOST override so LAN exposure stays deliberate', async () => {
    process.env.HOST = '0.0.0.0';
    expect((await loadConfig()).host).toBe('0.0.0.0');
  });

  it('treats an empty HOST as unset rather than binding every interface', async () => {
    process.env.HOST = '';
    expect((await loadConfig()).host).toBe('127.0.0.1');
  });
});

describe('log level', () => {
  const original = process.env.LOG_LEVEL;
  afterEach(() => {
    if (original === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = original;
  });

  it('defaults to info when LOG_LEVEL is unset', async () => {
    delete process.env.LOG_LEVEL;
    expect((await loadConfig()).logLevel).toBe('info');
  });

  it('honors LOG_LEVEL, so the documented variable is the one in use', async () => {
    process.env.LOG_LEVEL = 'debug';
    expect((await loadConfig()).logLevel).toBe('debug');
  });

  it('accepts a level in any casing, with surrounding whitespace', async () => {
    process.env.LOG_LEVEL = '  WARN ';
    expect((await loadConfig()).logLevel).toBe('warn');
  });

  it('falls back to info for a level pino would reject, rather than failing startup', async () => {
    process.env.LOG_LEVEL = 'verbose';
    expect((await loadConfig()).logLevel).toBe('info');
  });
});
