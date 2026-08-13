import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

export const PROJECT_SUBFOLDERS = [
  '01_Admin',
  '02_Briefs',
  '03_Working_Files',
  '04_Review',
  '05_Final_Deliverables',
] as const;
/**
 * The levels pino accepts. `LOG_LEVEL` is documented in `.env.example`, so it has to be the
 * value actually in use — pino does not read the variable on its own, and for a while nothing
 * else did either, which left the documented knob doing nothing. An unrecognized value falls
 * back to `info` rather than failing startup: a typo in a log level should not stop the app.
 */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The shortest `GOOGLE_TOKEN_ENCRYPTION_KEY` this app will start with. `server/drive/tokens.ts`
 * SHA-256s the value into an AES-256 key, so a three-character secret produces ciphertext that
 * looks exactly as encrypted as a strong one — the weakness is invisible everywhere except
 * here. The key stays optional, because Drive is optional and `driveConfigured()` is what
 * reports it, but a key that is present has to be usable.
 */
export const ENCRYPTION_KEY_MIN_LENGTH = 32;

/**
 * What each variable falls back to when it is unset. These are the values `.env.example`
 * documents, and `config.test.ts` reads that file to keep the two from drifting. Variables
 * with no entry here — the Google trio — are optional and default to nothing.
 */
export const ENVIRONMENT_DEFAULTS = {
  PORT: '8787',
  HOST: '127.0.0.1',
  DATABASE_PATH: './data/command-center.db',
  APP_ORIGIN: 'http://localhost:5173',
  GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/drive/oauth/callback',
  LOG_LEVEL: 'info',
} as const;

/**
 * A port arrives as text, so it is checked as text before it becomes a number: `Number('abc')`
 * is `NaN`, and `listen(NaN)` binds an arbitrary free port rather than failing, which is the
 * defect this schema exists to stop.
 */
const portNumber = z
  .string()
  .regex(/^\d+$/, 'must be a port number, digits only')
  .transform(Number)
  .refine((value) => value >= 1 && value <= 65535, 'must be a port number between 1 and 65535');

/**
 * The scheme is checked, not just the syntax. `new URL('localhost:5173')` succeeds — it reads
 * `localhost:` as the scheme — so a browser origin written without one is a valid URL and a
 * useless CORS origin, which is exactly the typo this catches at boot rather than at the
 * browser. Both variables this covers address the local app over http or https.
 */
const absoluteUrl = z.url({
  protocol: /^https?$/,
  error: 'must be an http or https URL, scheme included',
});

const environment = z.object({
  PORT: portNumber,
  HOST: z.string(),
  DATABASE_PATH: z.string(),
  APP_ORIGIN: absoluteUrl,
  // Drive is optional, so its three variables are too. What is refused is a value that is
  // present and unusable.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: absoluteUrl,
  GOOGLE_TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(ENCRYPTION_KEY_MIN_LENGTH, `must be at least ${ENCRYPTION_KEY_MIN_LENGTH} characters`)
    .optional(),
  // A typo in a log level should not stop the app, so this one is the schema's single
  // forgiving field: an unrecognized value falls back rather than failing the boot.
  LOG_LEVEL: z.enum(LOG_LEVELS).catch(ENVIRONMENT_DEFAULTS.LOG_LEVEL),
});

type EnvironmentVariable = keyof typeof environment.shape;
/** Every variable the schema reads, so `.env.example` can be checked against it. */
export const ENVIRONMENT_VARIABLES = Object.keys(environment.shape) as EnvironmentVariable[];

/** `.env` files quote nothing, so an unset variable and a blank one mean the same thing. */
const read = (name: EnvironmentVariable) => process.env[name]?.trim() || undefined;

const parsed = environment.safeParse({
  PORT: read('PORT') ?? ENVIRONMENT_DEFAULTS.PORT,
  HOST: read('HOST') ?? ENVIRONMENT_DEFAULTS.HOST,
  DATABASE_PATH: read('DATABASE_PATH') ?? ENVIRONMENT_DEFAULTS.DATABASE_PATH,
  APP_ORIGIN: read('APP_ORIGIN') ?? ENVIRONMENT_DEFAULTS.APP_ORIGIN,
  GOOGLE_CLIENT_ID: read('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: read('GOOGLE_CLIENT_SECRET'),
  GOOGLE_REDIRECT_URI: read('GOOGLE_REDIRECT_URI') ?? ENVIRONMENT_DEFAULTS.GOOGLE_REDIRECT_URI,
  GOOGLE_TOKEN_ENCRYPTION_KEY: read('GOOGLE_TOKEN_ENCRYPTION_KEY'),
  LOG_LEVEL: read('LOG_LEVEL')?.toLowerCase() ?? ENVIRONMENT_DEFAULTS.LOG_LEVEL,
});

if (!parsed.success) {
  /**
   * Every problem at once, each naming its variable, and none of them quoting the value:
   * two of these variables are secrets, and a startup failure is not a reason to print one.
   *
   * Thrown rather than exited on, so the failure is a value a test can assert about instead
   * of an exit code, and so the module cannot half-load and hand out a `config` it refused.
   */
  const problems = parsed.error.issues.map(
    (issue) => `  ${issue.path.join('.') || 'environment'}: ${issue.message}`,
  );
  throw new Error(
    ['Invalid environment configuration. Fix .env and start again:', ...problems].join('\n'),
  );
}
const env = parsed.data;

export const config = {
  logLevel: env.LOG_LEVEL as LogLevel,
  port: env.PORT,
  host: env.HOST,
  databasePath: path.resolve(env.DATABASE_PATH),
  appOrigin: env.APP_ORIGIN,
  google: {
    clientId: env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    redirectUri: env.GOOGLE_REDIRECT_URI,
    encryptionKey: env.GOOGLE_TOKEN_ENCRYPTION_KEY ?? '',
  },
};
