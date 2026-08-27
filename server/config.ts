import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';
import { isAllowedGoogleRedirectUri } from '../shared/drive-oauth.ts';

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
 *
 * The same floor applies to `SESSION_SECRET` when it is set: a short secret would mint session
 * HMACs that look fine and protect nothing.
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
export const isLoopbackHost = (host: string) =>
  LOOPBACK_HOSTS.some((loopback) => loopback === host.trim().toLowerCase());

/**
 * The §5.1 checklist from `docs/cloud-hosting.md`. Completing it turns operator authentication
 * on (C114), including when `HOST` stays loopback behind Caddy. A non-loopback bind is still
 * refused by the Zod bind gate until every item is true, and the production preflight refuses
 * non-loopback entirely. `OPERATOR_PASSWORD_HASH` must come from the environment for this gate —
 * a settings-row hash is enough for loopback testing later, not for publishing the API.
 * `TRUSTED_PROXY_HOPS` must be set explicitly (even to `0`) so a hosted deploy cannot silently
 * inherit the loopback default and then trust a forged `X-Forwarded-For`.
 */
export type AuthenticationChecklist = {
  sessionSecret: string;
  operatorPasswordHash: string;
  appOrigin: string;
  productionTlsTerminated: boolean;
  trustedProxyHopsConfigured: boolean;
};

export const authenticationConfigured = (input: AuthenticationChecklist): boolean =>
  input.sessionSecret.length >= ENCRYPTION_KEY_MIN_LENGTH &&
  input.operatorPasswordHash.length > 0 &&
  input.appOrigin.startsWith('https:') &&
  input.productionTlsTerminated &&
  input.trustedProxyHopsConfigured;

/**
 * Named so the message and the test read the same rule. It names the variable and the fix and
 * quotes no value, which matters because the same error list carries secrets' variables.
 */
const BIND_GATE_MESSAGE =
  `must be a loopback address — ${LOOPBACK_HOSTS.join(', ')} — while operator authentication ` +
  'is incomplete. A non-loopback bind requires SESSION_SECRET (at least 32 characters), ' +
  'OPERATOR_PASSWORD_HASH, an https APP_ORIGIN, PRODUCTION_TLS_TERMINATED=true, and ' +
  'TRUSTED_PROXY_HOPS set explicitly (even to 0). See docs/cloud-hosting.md §5.1 and the ' +
  'HOST row in README.md';

/**
 * What each variable falls back to when it is unset. These are the values `.env.example`
 * documents, and `config.test.ts` reads that file to keep the two from drifting. Variables
 * with no entry here — the Google trio, session secret, operator hash, TLS flag — are optional
 * and default to nothing.
 */
export const ENVIRONMENT_DEFAULTS = {
  PORT: '8787',
  HOST: '127.0.0.1',
  DATABASE_PATH: './data/command-center.db',
  APP_ORIGIN: 'http://localhost:5173',
  GOOGLE_REDIRECT_URI: 'http://localhost:8787/api/drive/oauth/callback',
  LOG_LEVEL: 'info',
  TRUSTED_PROXY_HOPS: '0',
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

const nonNegativeInt = z
  .string()
  .regex(/^\d+$/, 'must be a non-negative integer')
  .transform(Number);

/** `.env` files quote nothing, so an unset variable and a blank one mean the same thing. */
const read = (name: string) => process.env[name]?.trim() || undefined;

/**
 * Whether `TRUSTED_PROXY_HOPS` was present in the environment before the default applied.
 * An explicit `0` counts — the checklist needs the operator to have decided, not inherited.
 */
const trustedProxyHopsConfigured = read('TRUSTED_PROXY_HOPS') !== undefined;

const environment = z.object({
  PORT: portNumber,
  // The bind gate from `docs/cloud-hosting.md` §5.1, enforced here rather than only in the
  // README: refuse to start on an address other machines can reach while authentication is
  // incomplete. It is a field rule rather than an object-level one so that a bad `HOST` is still
  // reported alongside a bad `PORT` — Zod skips object refinements once the shape has failed.
  // The checklist is evaluated from the same raw reads the schema is about to parse, so a short
  // SESSION_SECRET still fails its own field rule and does not quietly open the bind.
  HOST: z.string().refine((value) => {
    if (isLoopbackHost(value)) return true;
    const sessionSecret = read('SESSION_SECRET') ?? '';
    const operatorPasswordHash = read('OPERATOR_PASSWORD_HASH') ?? '';
    const appOrigin = read('APP_ORIGIN') ?? ENVIRONMENT_DEFAULTS.APP_ORIGIN;
    return authenticationConfigured({
      sessionSecret,
      operatorPasswordHash,
      appOrigin,
      productionTlsTerminated: read('PRODUCTION_TLS_TERMINATED') === 'true',
      trustedProxyHopsConfigured,
    });
  }, BIND_GATE_MESSAGE),
  DATABASE_PATH: z.string(),
  APP_ORIGIN: absoluteUrl,
  // Drive is optional, so its three variables are too. What is refused is a value that is
  // present and unusable.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: absoluteUrl.refine(
    isAllowedGoogleRedirectUri,
    'must be http://localhost|127.0.0.1…/api/drive/oauth/callback or https://…/api/drive/oauth/callback with no query or hash',
  ),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(ENCRYPTION_KEY_MIN_LENGTH, `must be at least ${ENCRYPTION_KEY_MIN_LENGTH} characters`)
    .optional(),
  // Browser Picker developer key and Cloud project number (C52). Optional with Drive; required
  // together before Settings can open Picker. Never a secret with Drive scopes — restrict by
  // HTTP referrer in Cloud Console.
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_APP_ID: z
    .string()
    .regex(/^\d+$/, 'must be the numeric Google Cloud project number')
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
  // Operator auth (C51). Optional on loopback; required together for a non-loopback bind.
  SESSION_SECRET: z
    .string()
    .min(ENCRYPTION_KEY_MIN_LENGTH, `must be at least ${ENCRYPTION_KEY_MIN_LENGTH} characters`)
    .optional(),
  OPERATOR_PASSWORD_HASH: z.string().optional(),
  // Only the exact token `true` acknowledges TLS termination; any other non-empty value is a
  // misconfiguration rather than a silent false.
  PRODUCTION_TLS_TERMINATED: z
    .string()
    .optional()
    .refine((value) => value === undefined || value === 'true', "must be exactly 'true' when set"),
  TRUSTED_PROXY_HOPS: nonNegativeInt,
});

type EnvironmentVariable = keyof typeof environment.shape;
/** Every variable the schema reads, so `.env.example` can be checked against it. */
export const ENVIRONMENT_VARIABLES = Object.keys(environment.shape) as EnvironmentVariable[];

const parsed = environment.safeParse({
  PORT: read('PORT') ?? ENVIRONMENT_DEFAULTS.PORT,
  HOST: read('HOST') ?? ENVIRONMENT_DEFAULTS.HOST,
  DATABASE_PATH: read('DATABASE_PATH') ?? ENVIRONMENT_DEFAULTS.DATABASE_PATH,
  APP_ORIGIN: read('APP_ORIGIN') ?? ENVIRONMENT_DEFAULTS.APP_ORIGIN,
  GOOGLE_CLIENT_ID: read('GOOGLE_CLIENT_ID'),
  GOOGLE_CLIENT_SECRET: read('GOOGLE_CLIENT_SECRET'),
  GOOGLE_REDIRECT_URI: read('GOOGLE_REDIRECT_URI') ?? ENVIRONMENT_DEFAULTS.GOOGLE_REDIRECT_URI,
  GOOGLE_TOKEN_ENCRYPTION_KEY: read('GOOGLE_TOKEN_ENCRYPTION_KEY'),
  GOOGLE_API_KEY: read('GOOGLE_API_KEY'),
  GOOGLE_APP_ID: read('GOOGLE_APP_ID'),
  POST_BRIDGE_API_KEY: read('POST_BRIDGE_API_KEY'),
  BUFFER_API_KEY: read('BUFFER_API_KEY'),
  BUFFER_KEY: read('BUFFER_KEY'),
  BUFFER_ORGANIZATION_ID: read('BUFFER_ORGANIZATION_ID'),
  PUBLISH_TIMEZONE: read('PUBLISH_TIMEZONE'),
  LOG_LEVEL: read('LOG_LEVEL')?.toLowerCase() ?? ENVIRONMENT_DEFAULTS.LOG_LEVEL,
  SESSION_SECRET: read('SESSION_SECRET'),
  OPERATOR_PASSWORD_HASH: read('OPERATOR_PASSWORD_HASH'),
  PRODUCTION_TLS_TERMINATED: read('PRODUCTION_TLS_TERMINATED'),
  TRUSTED_PROXY_HOPS: read('TRUSTED_PROXY_HOPS') ?? ENVIRONMENT_DEFAULTS.TRUSTED_PROXY_HOPS,
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
    apiKey: env.GOOGLE_API_KEY ?? '',
    appId: env.GOOGLE_APP_ID ?? '',
  },
  publish: {
    apiKey: env.POST_BRIDGE_API_KEY ?? '',
    timezone: env.PUBLISH_TIMEZONE ?? '',
  },
  buffer: {
    apiKey: env.BUFFER_API_KEY ?? env.BUFFER_KEY ?? '',
    organizationId: env.BUFFER_ORGANIZATION_ID ?? '',
  },
  auth: {
    sessionSecret: env.SESSION_SECRET ?? '',
    operatorPasswordHash: env.OPERATOR_PASSWORD_HASH ?? '',
    productionTlsTerminated: env.PRODUCTION_TLS_TERMINATED === 'true',
    trustedProxyHops: env.TRUSTED_PROXY_HOPS,
    /** Whether hops was explicitly set (for bind checklist). */
    trustedProxyHopsConfigured,
  },
};

/** Publishing is optional, but half-configuration never counts as available. */
export const publishConfigured = () => Boolean(config.publish.apiKey && config.publish.timezone);

/** Buffer read access is optional and independent of Post Bridge publishing. */
export const bufferConfigured = () => Boolean(config.buffer.apiKey);

/** Runtime view of the §5.1 checklist against the loaded config. */
export const authIsConfigured = () =>
  authenticationConfigured({
    sessionSecret: config.auth.sessionSecret,
    operatorPasswordHash: config.auth.operatorPasswordHash,
    appOrigin: config.appOrigin,
    productionTlsTerminated: config.auth.productionTlsTerminated,
    trustedProxyHopsConfigured: config.auth.trustedProxyHopsConfigured,
  });

export type ProductionRuntimeConfig = Pick<
  typeof config,
  'host' | 'databasePath' | 'appOrigin' | 'google' | 'auth'
>;

/**
 * The hosted process stays on loopback behind Caddy, so the ordinary bind gate cannot prove that
 * a production launch is safe. This explicit preflight is run before SQLite is opened or the HTTP
 * server listens. It reports variable names, never values, and rejects the SSM staging sentinel.
 */
export function productionRuntimeIssues(input: ProductionRuntimeConfig): string[] {
  const issues: string[] = [];
  const origin = new URL(input.appOrigin);
  const requiredSecret = (name: string, value: string, minimum = 1) => {
    if (value === 'UNSET' || value.length < minimum) issues.push(`${name} is missing or unusable`);
  };

  if (!isLoopbackHost(input.host))
    issues.push('HOST must remain loopback behind the trusted proxy');
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.port
  ) {
    issues.push('APP_ORIGIN must be an https origin with no path, query, fragment, or port');
  }
  if (!path.isAbsolute(input.databasePath)) issues.push('DATABASE_PATH must be absolute');
  requiredSecret('SESSION_SECRET', input.auth.sessionSecret, ENCRYPTION_KEY_MIN_LENGTH);
  requiredSecret('OPERATOR_PASSWORD_HASH', input.auth.operatorPasswordHash);
  if (!input.auth.productionTlsTerminated) issues.push('PRODUCTION_TLS_TERMINATED must be true');
  if (!input.auth.trustedProxyHopsConfigured || input.auth.trustedProxyHops !== 1)
    issues.push('TRUSTED_PROXY_HOPS must be explicitly set to 1');

  requiredSecret('GOOGLE_CLIENT_ID', input.google.clientId);
  requiredSecret('GOOGLE_CLIENT_SECRET', input.google.clientSecret);
  requiredSecret(
    'GOOGLE_TOKEN_ENCRYPTION_KEY',
    input.google.encryptionKey,
    ENCRYPTION_KEY_MIN_LENGTH,
  );
  requiredSecret('GOOGLE_API_KEY', input.google.apiKey);
  requiredSecret('GOOGLE_APP_ID', input.google.appId);
  const expectedRedirect = `${origin.origin}/api/drive/oauth/callback`;
  if (input.google.redirectUri !== expectedRedirect)
    issues.push('GOOGLE_REDIRECT_URI must use APP_ORIGIN and the fixed OAuth callback path');
  return issues;
}

export function assertProductionRuntimeConfig(input: ProductionRuntimeConfig = config): void {
  const issues = productionRuntimeIssues(input);
  if (issues.length > 0) {
    throw new Error(
      [
        'Production runtime preflight failed before listen:',
        ...issues.map((issue) => `  ${issue}`),
      ].join('\n'),
    );
  }
}
