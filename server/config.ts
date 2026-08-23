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
 * The only listen addresses this app may bind. `localhost` is here because an operator who
 * writes it means loopback and the resolver agrees; everything else — `0.0.0.0`, `::`, a LAN
 * address, a hostname — is an address another machine can reach. `127.0.0.2` is loopback to the
 * kernel and is deliberately not on this list: the gate is a small set of values an operator
 * types on purpose, not a subnet calculator.
 */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

/** Case-insensitive because `HOST=LocalHost` binds loopback and means to. */
const isLoopbackHost = (host: string) =>
  LOOPBACK_HOSTS.some((loopback) => loopback === host.trim().toLowerCase());

/**
 * Whether the operator-password session from `docs/cloud-hosting.md` §5 is configured. It is not
 * built — there is no password hash, no session secret, and no CSRF — so the answer is `false`
 * for every environment, and the bind gate below therefore refuses every non-loopback `HOST`.
 *
 * This is annotated `boolean` rather than left to infer `false` on purpose: the type is the
 * contract the gate is written against, and the value is what today's implementation can honestly
 * report. When Infra 2 ships §5, this becomes the full §5.1 checklist — password hash and session
 * secret present, `APP_ORIGIN` an `https:` URL, and a production flag acknowledging TLS
 * termination — read from the parsed environment. There is no weaker interim mode: a LAN bind
 * without authentication publishes every write path and both Drive OAuth routes.
 */
const AUTHENTICATION_CONFIGURED: boolean = false;

/**
 * Named so the message and the test read the same rule. It names the variable and the fix and
 * quotes no value, which matters because the same error list carries secrets' variables.
 */
const BIND_GATE_MESSAGE =
  `must be a loopback address — ${LOOPBACK_HOSTS.join(', ')} — while this app has no ` +
  'authentication. Any other value publishes every API route, Drive OAuth and every write ' +
  'path included, to whoever can reach the interface. See docs/cloud-hosting.md §5.1 and the ' +
  'HOST row in README.md';

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
  // The bind gate from `docs/cloud-hosting.md` §5.1, enforced here rather than only in the
  // README: refuse to start on an address other machines can reach while nothing authenticates
  // them. It is a field rule rather than an object-level one so that a bad `HOST` is still
  // reported alongside a bad `PORT` — Zod skips object refinements once the shape has failed.
  HOST: z
    .string()
    .refine((value) => isLoopbackHost(value) || AUTHENTICATION_CONFIGURED, BIND_GATE_MESSAGE),
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
  POST_BRIDGE_API_KEY: z.string().optional(),
  BUFFER_API_KEY: z.string().optional(),
  // One-release migration alias. The canonical value always wins when both are present.
  BUFFER_KEY: z.string().optional(),
  // When the Buffer account has more than one organization, this names the one to read.
  BUFFER_ORGANIZATION_ID: z.string().optional(),
  PUBLISH_TIMEZONE: z
    .string()
    .optional()
    .refine(
      (value) => !value || Intl.supportedValuesOf('timeZone').includes(value),
      'must be an IANA timezone such as America/New_York',
    ),
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
  POST_BRIDGE_API_KEY: read('POST_BRIDGE_API_KEY'),
  BUFFER_API_KEY: read('BUFFER_API_KEY'),
  BUFFER_KEY: read('BUFFER_KEY'),
  BUFFER_ORGANIZATION_ID: read('BUFFER_ORGANIZATION_ID'),
  PUBLISH_TIMEZONE: read('PUBLISH_TIMEZONE'),
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
  publish: {
    apiKey: env.POST_BRIDGE_API_KEY ?? '',
    timezone: env.PUBLISH_TIMEZONE ?? '',
  },
  buffer: {
    apiKey: env.BUFFER_API_KEY ?? env.BUFFER_KEY ?? '',
    organizationId: env.BUFFER_ORGANIZATION_ID ?? '',
  },
};

/** Publishing is optional, but half-configuration never counts as available. */
export const publishConfigured = () => Boolean(config.publish.apiKey && config.publish.timezone);

/** Buffer read access is optional and independent of Post Bridge publishing. */
export const bufferConfigured = () => Boolean(config.buffer.apiKey);
