import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Keep these hermetic: a developer's real .env must not decide what the defaults are.
vi.mock('dotenv/config', () => ({}));

const loadConfig = async () => {
  vi.resetModules();
  return (await import('./config.ts')).config;
};

/**
 * Sets a variable for one test and remembers what it displaced, so a case that has to be
 * invalid — and therefore throws on import — still leaves the environment as it found it.
 */
const overrides = new Map<string, string | undefined>();
const setEnv = (name: string, value: string | undefined) => {
  if (!overrides.has(name)) overrides.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
afterEach(() => {
  for (const [name, value] of overrides) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  overrides.clear();
});

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

describe('port', () => {
  it('defaults to 8787 as a number', async () => {
    setEnv('PORT', undefined);
    expect((await loadConfig()).port).toBe(8787);
  });

  it('reads an explicit port as a number', async () => {
    setEnv('PORT', '9001');
    expect((await loadConfig()).port).toBe(9001);
  });

  /**
   * The defect this replaces: `Number('abc')` is `NaN`, and `listen(NaN)` binds an arbitrary
   * free port rather than failing, so the app came up somewhere nobody had configured.
   */
  it('refuses a port that is not a number, naming PORT rather than binding an arbitrary one', async () => {
    setEnv('PORT', 'abc');
    await expect(loadConfig()).rejects.toThrow(/PORT: must be a port number/);
  });

  it('refuses a port outside the range a socket can bind', async () => {
    setEnv('PORT', '99999');
    await expect(loadConfig()).rejects.toThrow(/PORT: must be a port number between 1 and 65535/);
  });
});

describe('origins', () => {
  it('refuses an APP_ORIGIN that is not a URL, so CORS fails at boot rather than at the browser', async () => {
    setEnv('APP_ORIGIN', 'localhost:5173');
    await expect(loadConfig()).rejects.toThrow(/APP_ORIGIN: must be an http or https URL/);
  });

  it('refuses a GOOGLE_REDIRECT_URI that is not a URL', async () => {
    setEnv('GOOGLE_REDIRECT_URI', 'not a uri');
    await expect(loadConfig()).rejects.toThrow(/GOOGLE_REDIRECT_URI: must be an http or https URL/);
  });

  it('reports every bad variable at once, rather than one restart at a time', async () => {
    setEnv('PORT', 'abc');
    setEnv('APP_ORIGIN', 'localhost:5173');
    await expect(loadConfig()).rejects.toThrow(/PORT:[\s\S]*APP_ORIGIN:/);
  });
});

describe('Drive credentials', () => {
  const load = async () => {
    vi.resetModules();
    const { config } = await import('./config.ts');
    const { driveConfigured } = await import('./drive/browse.ts');
    return { config, driveConfigured };
  };
  /** Long enough to satisfy the minimum, and recognizable if it ever reached an error message. */
  const STRONG_KEY = 'k'.repeat(48);

  // The long timeout is the module reset, not the assertion: reaching `driveConfigured` means
  // re-importing the Drive graph, googleapis included, rather than the one small module the
  // rest of this file loads.
  it(
    'boots without the Google trio, with Drive reporting itself unconfigured',
    { timeout: 30_000 },
    async () => {
      for (const name of [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'GOOGLE_TOKEN_ENCRYPTION_KEY',
      ])
        setEnv(name, undefined);

      const { config, driveConfigured } = await load();
      expect(config.google).toMatchObject({ clientId: '', clientSecret: '', encryptionKey: '' });
      expect(driveConfigured()).toBe(false);
    },
  );

  it('accepts a key long enough to be worth SHA-256ing into an AES-256 key', async () => {
    setEnv('GOOGLE_TOKEN_ENCRYPTION_KEY', STRONG_KEY);
    expect((await loadConfig()).google.encryptionKey).toBe(STRONG_KEY);
  });

  /**
   * A short key is the failure that looks like success: `tokens.ts` hashes whatever it is
   * given, so three characters produce ciphertext indistinguishable from a strong secret's.
   */
  it('refuses a key too short to be a secret, naming the variable', async () => {
    setEnv('GOOGLE_TOKEN_ENCRYPTION_KEY', 'abc');
    await expect(loadConfig()).rejects.toThrow(
      /GOOGLE_TOKEN_ENCRYPTION_KEY: must be at least 32 characters/,
    );
  });

  it('does not print the rejected secret, since a startup failure is not a reason to leak one', async () => {
    setEnv('GOOGLE_TOKEN_ENCRYPTION_KEY', 'short-but-real-secret');
    await expect(loadConfig()).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining('short-but-real-secret') as unknown as string,
      }),
    );
  });
});

describe('.env.example', () => {
  /** `KEY=value` pairs as the file writes them, comments and blank lines dropped. */
  const documented = () => {
    const raw = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
    return new Map(
      raw
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.trim().startsWith('#'))
        .map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index).trim(), line.slice(index + 1).trim()] as const;
        }),
    );
  };

  /**
   * The schema and the file it is documented in are the two halves of one contract, and
   * nothing else notices when they drift: a variable added to the schema and forgotten here
   * is discovered by whoever copies `.env.example` and cannot start the app.
   */
  it('documents every variable the schema reads, with the same defaults', async () => {
    vi.resetModules();
    const { ENVIRONMENT_DEFAULTS, ENVIRONMENT_VARIABLES } = await import('./config.ts');
    const example = documented();

    for (const name of ENVIRONMENT_VARIABLES) {
      expect(example.has(name), `${name} is missing from .env.example`).toBe(true);
      const fallback = (ENVIRONMENT_DEFAULTS as Record<string, string | undefined>)[name];
      // Optional variables — the Google trio — are documented empty, since there is nothing
      // to fall back to and a placeholder would look like a value.
      expect(example.get(name), `${name} disagrees with the schema`).toBe(fallback ?? '');
    }
  });

  it('documents nothing the schema does not read', async () => {
    vi.resetModules();
    const { ENVIRONMENT_VARIABLES } = await import('./config.ts');
    expect([...documented().keys()].sort()).toEqual([...ENVIRONMENT_VARIABLES].sort());
  });
});
