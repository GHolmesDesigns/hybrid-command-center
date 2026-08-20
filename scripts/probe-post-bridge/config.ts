/**
 * The guards, and why they are a module rather than a few `if`s in the entry point.
 *
 * Everything dangerous about this script is decided here, before a transport exists. `--yes` on its
 * own is not a safety boundary; the boundary is that live mode is unreachable without a key from the
 * environment, an explicit acknowledgement of the stop conditions, an instant at least two days
 * away, a label nothing else is using, and every account named by its provider id. There is no
 * default account, no "first matching account on that platform", and no argument spelled slightly
 * wrong that lands in a weaker mode: an unrecognised argument is a refusal, because a typo in
 * `--scheduled-at` must not become "no schedule supplied".
 *
 * Refusals are collected rather than thrown one at a time, so an operator sees everything wrong
 * with the invocation in one pass instead of discovering the next one each time they fix the last.
 */
import { PUBLISH_PLATFORMS } from '../../shared/publish-capabilities.ts';

/** The environment variable the key comes from. It is never accepted as an argument. */
export const PROBE_API_KEY_ENV = 'POST_BRIDGE_API_KEY';

/**
 * How far ahead a probe post must be scheduled.
 *
 * Two days, so that every stage of a session — create, read back, patch, read back, delete, and the
 * inventory that proves the delete — happens with a wide margin before anything could go out. It is
 * also long enough that a run abandoned halfway leaves time to notice and clean up by hand.
 */
export const PROBE_MIN_SCHEDULE_HOURS = 48;

export const PROBE_DEFAULT_BASE_URL = 'https://api.post-bridge.com/v1';

/** 8–48 characters of lowercase, digits, and hyphens. Long enough to be unique, short enough to type. */
const PROBE_LABEL = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;

const KNOWN_FLAGS = ['live', 'yes', 'accounts-approved', 'help'] as const;
const KNOWN_OPTIONS = [
  'scheduled-at',
  'probe-label',
  'account',
  'base-url',
  'video',
  'provider-ui-post',
] as const;

export interface ProbeAccount {
  platform: string;
  accountId: number;
}

export interface ProbeConfig {
  /** `plan` contacts nothing at all and exists so the run can be reviewed before it is run. */
  mode: 'plan' | 'live';
  apiKey: string;
  baseUrl: string;
  scheduledAt: string;
  probeLabel: string;
  accounts: readonly ProbeAccount[];
  videoPath?: string;
  providerUiPostId?: string;
}

export interface ProbeGuardOutcome {
  config?: ProbeConfig;
  refusals: string[];
  /** Things a run will not be able to answer, said before it starts rather than after. */
  notices: string[];
}

interface ParsedArgv {
  flags: Set<string>;
  options: Map<string, string[]>;
  unknown: string[];
}

/**
 * `--flag` and `--option value`, with repeats kept.
 *
 * `--account` is given once per account and every one of them matters, so options collect into a
 * list rather than overwriting. A bare word is unknown rather than positional: this script takes no
 * positional arguments and a stray one usually means a missing `--`.
 */
export function parseArgv(argv: readonly string[]): ParsedArgv {
  const flags = new Set<string>();
  const options = new Map<string, string[]>();
  const unknown: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      unknown.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if ((KNOWN_OPTIONS as readonly string[]).includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        unknown.push(`${argument} (no value)`);
        continue;
      }
      options.set(name, [...(options.get(name) ?? []), value]);
      index += 1;
      continue;
    }
    if ((KNOWN_FLAGS as readonly string[]).includes(name)) {
      flags.add(name);
      continue;
    }
    unknown.push(argument);
  }
  return { flags, options, unknown };
}

/**
 * `platform:id`, both halves required.
 *
 * The platform is checked against the app's own list rather than passed through, so a typo cannot
 * produce a `platform_configurations` key the provider silently ignores — which would read as "the
 * field was accepted" in the result matrix.
 */
export function parseAccountSpecification(specification: string): ProbeAccount | string {
  const [platform, id, ...rest] = specification.split(':');
  if (!platform || !id || rest.length)
    return `--account ${specification} is not <platform>:<provider account id>.`;
  if (!(PUBLISH_PLATFORMS as readonly string[]).includes(platform))
    return `--account ${specification} names no platform this app knows. One of: ${PUBLISH_PLATFORMS.join(', ')}.`;
  if (!/^\d+$/.test(id) || Number(id) <= 0)
    return `--account ${specification} needs a positive whole provider account id.`;
  return { platform, accountId: Number(id) };
}

/**
 * An instant, and only one written unambiguously.
 *
 * A local-time string is refused rather than interpreted: the whole safety margin is expressed in
 * hours from now, and "is 2026-08-24T09:00 far enough away" has a different answer in two zones.
 */
function parseScheduledAt(value: string, now: Date): { instant: string } | string {
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(value))
    return `--scheduled-at ${value} carries no time zone. Use a trailing Z or an explicit offset.`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return `--scheduled-at ${value} is not a date and time.`;
  const hoursAway = (parsed.getTime() - now.getTime()) / 3_600_000;
  if (hoursAway < PROBE_MIN_SCHEDULE_HOURS)
    return `--scheduled-at ${value} is ${hoursAway.toFixed(1)} hours away; the probe needs at least ${PROBE_MIN_SCHEDULE_HOURS}.`;
  return { instant: parsed.toISOString() };
}

export const PROBE_USAGE = `Usage
  Plan the run and contact nothing:
    npm run probe:post-bridge -- --scheduled-at <instant> --probe-label <label> --account <platform>:<id> …

  Run it live against the named accounts:
    ${PROBE_API_KEY_ENV}=… npm run probe:post-bridge -- --live --yes --accounts-approved \\
      --scheduled-at <instant> --probe-label <label> --account <platform>:<id> … \\
      [--video <path>] [--provider-ui-post <id>] [--base-url <url>]

The key is read from ${PROBE_API_KEY_ENV} and is never accepted as an argument.`;

/**
 * The stop conditions, printed before the plan every time.
 *
 * They are human conditions and this script cannot check any of them, which is precisely why they
 * are read out rather than assumed: `--accounts-approved` is an operator saying they have.
 */
export const PROBE_STOP_CONDITIONS: readonly string[] = [
  'Stop if the platform has no disposable or explicitly approved connected account.',
  'Stop if a selected account carries client or customer production content whose policy this could affect.',
  'Stop if a scheduled probe post cannot be read back before the update is tested.',
  'Stop and clean up immediately on any unexpected processing or publishing state.',
  'Never use a customer asset, never provoke a 429, and never leave a post scheduled.',
];

/**
 * The whole invocation, checked.
 *
 * Returns a config only when nothing is wrong. Plan mode needs the same schedule, label, and
 * accounts as a live run, because a plan that omits them is not a plan of the run that would
 * happen.
 */
export function parseProbeArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  now: Date,
): ProbeGuardOutcome {
  const refusals: string[] = [];
  const notices: string[] = [];
  const { flags, options, unknown } = parseArgv(argv);

  for (const argument of unknown)
    refusals.push(
      argument.startsWith('--api-key') || argument.startsWith('--key')
        ? `${argument} is not an argument. The key is read from ${PROBE_API_KEY_ENV} so it never reaches a shell history or a process list.`
        : `Unrecognised argument: ${argument}.`,
    );

  const live = flags.has('live');

  const labels = options.get('probe-label') ?? [];
  if (labels.length !== 1) refusals.push('Pass --probe-label exactly once.');
  else if (!PROBE_LABEL.test(labels[0]))
    refusals.push(
      `--probe-label ${labels[0]} must be 8–48 characters of lowercase letters, digits, and hyphens, and must be one nothing in the provider is already using.`,
    );

  const scheduled = options.get('scheduled-at') ?? [];
  let scheduledAt = '';
  if (scheduled.length !== 1) refusals.push('Pass --scheduled-at exactly once.');
  else {
    const parsed = parseScheduledAt(scheduled[0], now);
    if (typeof parsed === 'string') refusals.push(parsed);
    else scheduledAt = parsed.instant;
  }

  const accounts: ProbeAccount[] = [];
  for (const specification of options.get('account') ?? []) {
    const parsed = parseAccountSpecification(specification);
    if (typeof parsed === 'string') refusals.push(parsed);
    else if (
      accounts.some(
        (existing) =>
          existing.accountId === parsed.accountId && existing.platform === parsed.platform,
      )
    )
      refusals.push(`--account ${specification} is named twice.`);
    else accounts.push(parsed);
  }
  if (!accounts.length)
    refusals.push(
      'Pass --account <platform>:<provider account id> at least once. There is no default account.',
    );

  const baseUrls = options.get('base-url') ?? [];
  if (baseUrls.length > 1) refusals.push('Pass --base-url at most once.');
  const baseUrl = baseUrls[0] ?? PROBE_DEFAULT_BASE_URL;
  if (!baseUrl.startsWith('https://')) refusals.push(`--base-url ${baseUrl} must be https.`);

  const videos = options.get('video') ?? [];
  if (videos.length > 1) refusals.push('Pass --video at most once.');
  const providerUiPosts = options.get('provider-ui-post') ?? [];
  if (providerUiPosts.length > 1) refusals.push('Pass --provider-ui-post at most once.');

  const apiKey = (env[PROBE_API_KEY_ENV] ?? '').trim();
  if (live) {
    if (!flags.has('yes'))
      refusals.push('Live mode needs --yes. It writes scheduled posts to the named accounts.');
    if (!flags.has('accounts-approved'))
      refusals.push(
        'Live mode needs --accounts-approved, which is you stating that every account above is disposable or explicitly approved and carries no client production content.',
      );
    if (!apiKey) refusals.push(`Live mode needs ${PROBE_API_KEY_ENV} in the environment.`);
  }

  const platforms = new Set(accounts.map((account) => account.platform));
  const samePlatformPair = [...platforms].some(
    (platform) => accounts.filter((account) => account.platform === platform).length >= 2,
  );
  if (!samePlatformPair)
    notices.push(
      'No platform has two named accounts, so question 1 — account_configurations and the same-platform policy — cannot be asked and stays still unverified.',
    );
  for (const [platform, question] of [
    ['youtube', 'the YouTube thumbnail role and contains_synthetic_media'],
    ['instagram', 'the Instagram cover_image role'],
    ['linkedin', 'the LinkedIn document role'],
    ['tiktok', 'the TikTok disclosure toggles'],
    ['facebook', 'Facebook story placement'],
  ] as const)
    if (!platforms.has(platform))
      notices.push(`No ${platform} account is named, so ${question} stays still unverified.`);
  if (!videos.length)
    notices.push(
      'No --video, so the two roles that need a video as the post’s own media — YouTube thumbnail and Instagram cover_image — stay still unverified.',
    );
  if (!providerUiPosts.length)
    notices.push(
      'No --provider-ui-post, so the shape of a post made in the provider’s own UI stays still unverified. The probe never creates one to stand in for it.',
    );

  if (refusals.length) return { refusals, notices };
  return {
    refusals,
    notices,
    config: {
      mode: live ? 'live' : 'plan',
      apiKey: live ? apiKey : '',
      baseUrl,
      scheduledAt,
      probeLabel: labels[0],
      accounts,
      ...(videos.length ? { videoPath: videos[0] } : {}),
      ...(providerUiPosts.length ? { providerUiPostId: providerUiPosts[0] } : {}),
    },
  };
}
