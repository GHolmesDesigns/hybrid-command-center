export const BUFFER_API_KEY_ENV = 'BUFFER_API_KEY';
export const BUFFER_KEY_ALIAS_ENV = 'BUFFER_KEY';
export const BUFFER_PROBE_BASE_URL = 'https://api.buffer.com';
export const BUFFER_PROBE_MIN_HOURS = 48;
export const BUFFER_PROBE_SERVICES = ['tiktok', 'youtube'] as const;

export interface BufferProbeChannel {
  service: (typeof BUFFER_PROBE_SERVICES)[number];
  id: string;
}

export interface BufferProbeMediaFixture {
  service: (typeof BUFFER_PROBE_SERVICES)[number];
  kind: 'image' | 'video';
  url: string;
}

export interface BufferProbeConfig {
  mode: 'plan' | 'live';
  apiKey: string;
  baseUrl: string;
  accountId: string;
  organizationId: string;
  scheduledAt: string;
  probeLabel: string;
  channels: readonly BufferProbeChannel[];
  targets: readonly BufferProbeChannel[];
  media: readonly BufferProbeMediaFixture[];
}

export interface BufferProbeGuardOutcome {
  config?: BufferProbeConfig;
  refusals: string[];
}

const FLAGS = new Set(['live', 'yes', 'channels-approved', 'help']);
const OPTIONS = new Set([
  'account',
  'organization',
  'scheduled-at',
  'probe-label',
  'channel',
  'target',
  'media',
  'base-url',
]);
const LABEL = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;
const ID = /^[A-Za-z0-9_-]{1,200}$/;

export const BUFFER_PROBE_USAGE = `Usage
  Plan only; contacts nothing:
    npm run probe:buffer -- --account <id> --organization <id> --scheduled-at <instant> \\
      --probe-label <label> --channel tiktok:<id> --channel youtube:<id> \
      [--target tiktok:<id>] \
      [--media tiktok:image:<public-https-url>]

  Owner-run live probe:
    BUFFER_API_KEY=… npm run probe:buffer -- --live --yes --channels-approved \\
      --account <id> --organization <id> --scheduled-at <instant> --probe-label <label> \\
      --channel tiktok:<id> --channel youtube:<id> [--target tiktok:<id>] \
      [--media tiktok:image:<public-https-url>]

The key is read from BUFFER_API_KEY. BUFFER_KEY is a one-release fallback only when the canonical
setting is absent. Neither key is accepted on the command line.`;

export const BUFFER_PROBE_STOP_CONDITIONS = [
  'Stop if the account, organization, or connected channel set differs from the owner-approved list.',
  'Stop unless every named channel and disposable fixture has explicit owner approval.',
  'Stop if a create, edit, read, delete, or complete absence check is ambiguous.',
  'Never retry an ambiguous write, provoke a rate limit, or leave a probe post scheduled.',
] as const;

interface Parsed {
  flags: Set<string>;
  options: Map<string, string[]>;
  unknown: string[];
}

function parseArgv(argv: readonly string[]): Parsed {
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
    if (OPTIONS.has(name)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) unknown.push(`${argument} (no value)`);
      else {
        options.set(name, [...(options.get(name) ?? []), value]);
        index += 1;
      }
    } else if (FLAGS.has(name)) flags.add(name);
    else {
      unknown.push(argument);
      // Never echo a value supplied beside a credential-shaped unknown option. Treat it as part
      // of the refused option and discard it before the refusal list is rendered.
      if (/(?:api-?)?key|token/i.test(name) && argv[index + 1] && !argv[index + 1].startsWith('--'))
        index += 1;
    }
  }
  return { flags, options, unknown };
}

function one(options: Map<string, string[]>, name: string, refusals: string[]): string {
  const values = options.get(name) ?? [];
  if (values.length !== 1) {
    refusals.push(`Pass --${name} exactly once.`);
    return '';
  }
  return values[0];
}

function parseChannel(value: string): BufferProbeChannel | string {
  const [service, id, ...rest] = value.split(':');
  if (!service || !id || rest.length) return `--channel ${value} is not <service>:<channel id>.`;
  if (!(BUFFER_PROBE_SERVICES as readonly string[]).includes(service))
    return `--channel ${value} is outside this card. Use tiktok or youtube.`;
  if (!ID.test(id)) return `--channel ${value} has an invalid channel id.`;
  return { service: service as BufferProbeChannel['service'], id };
}

function parseMedia(value: string): BufferProbeMediaFixture | string {
  const match = /^(tiktok|youtube):(image|video):(.+)$/.exec(value);
  if (!match) return `--media ${value} is not <service>:<image|video>:<public HTTPS URL>.`;
  const [, service, kind, rawUrl] = match;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      return `--media ${service}:${kind}:… must be a credential-free, query-free HTTPS file URL.`;
    return {
      service: service as BufferProbeMediaFixture['service'],
      kind: kind as BufferProbeMediaFixture['kind'],
      url: url.toString(),
    };
  } catch {
    return `--media ${service}:${kind}:… must carry an absolute HTTPS file URL.`;
  }
}

export function parseBufferProbeArgs(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  now: Date,
): BufferProbeGuardOutcome {
  const refusals: string[] = [];
  const { flags, options, unknown } = parseArgv(argv);
  for (const argument of unknown)
    refusals.push(
      /--(?:api-?)?key|--token/i.test(argument)
        ? `${argument} is not an argument. The credential is read only from the environment.`
        : `Unrecognised argument: ${argument}.`,
    );

  const accountId = one(options, 'account', refusals);
  if (accountId && !ID.test(accountId)) refusals.push('--account has an invalid id.');

  const organizationId = one(options, 'organization', refusals);
  if (organizationId && !ID.test(organizationId))
    refusals.push('--organization has an invalid id.');

  const probeLabel = one(options, 'probe-label', refusals);
  if (probeLabel && !LABEL.test(probeLabel))
    refusals.push(
      '--probe-label must be 8–48 lowercase letters, digits, or hyphens and be unused.',
    );

  const scheduledValue = one(options, 'scheduled-at', refusals);
  let scheduledAt = '';
  if (scheduledValue) {
    if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(scheduledValue))
      refusals.push('--scheduled-at must carry Z or an explicit offset.');
    else {
      const instant = new Date(scheduledValue);
      if (Number.isNaN(instant.getTime())) refusals.push('--scheduled-at is not a date and time.');
      else if ((instant.getTime() - now.getTime()) / 3_600_000 < BUFFER_PROBE_MIN_HOURS)
        refusals.push(`--scheduled-at must be at least ${BUFFER_PROBE_MIN_HOURS} hours away.`);
      else scheduledAt = instant.toISOString();
    }
  }

  const channels: BufferProbeChannel[] = [];
  for (const value of options.get('channel') ?? []) {
    const parsed = parseChannel(value);
    if (typeof parsed === 'string') refusals.push(parsed);
    else if (
      channels.some((channel) => channel.id === parsed.id || channel.service === parsed.service)
    )
      refusals.push(`--channel ${value} duplicates an id or service.`);
    else channels.push(parsed);
  }
  if (!channels.length)
    refusals.push('Pass at least one explicit --channel <service>:<channel id>.');

  const targets: BufferProbeChannel[] = [];
  for (const value of options.get('target') ?? []) {
    const parsed = parseChannel(value);
    if (typeof parsed === 'string') refusals.push(parsed.replace('--channel', '--target'));
    else if (targets.some((target) => target.id === parsed.id || target.service === parsed.service))
      refusals.push(`--target ${value} duplicates an id or service.`);
    else if (
      !channels.some((channel) => channel.id === parsed.id && channel.service === parsed.service)
    )
      refusals.push(`--target ${value} is not present in the approved connected --channel set.`);
    else targets.push(parsed);
  }
  if (!targets.length && !(options.get('target')?.length ?? 0)) targets.push(...channels);

  const media: BufferProbeMediaFixture[] = [];
  for (const value of options.get('media') ?? []) {
    const parsed = parseMedia(value);
    if (typeof parsed === 'string') refusals.push(parsed);
    else if (media.some((fixture) => fixture.service === parsed.service))
      refusals.push(`--media duplicates the ${parsed.service} fixture.`);
    else media.push(parsed);
  }
  for (const fixture of media) {
    if (!targets.some((target) => target.service === fixture.service))
      refusals.push(`--media names ${fixture.service}, which is not an approved write --target.`);
  }

  const baseUrls = options.get('base-url') ?? [];
  if (baseUrls.length > 1) refusals.push('Pass --base-url at most once.');
  const baseUrl = baseUrls[0] ?? BUFFER_PROBE_BASE_URL;
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      refusals.push('--base-url must be a credential-free HTTPS origin or path.');
  } catch {
    refusals.push('--base-url must be an absolute HTTPS URL.');
  }

  const canonical = (env[BUFFER_API_KEY_ENV] ?? '').trim();
  const alias = (env[BUFFER_KEY_ALIAS_ENV] ?? '').trim();
  const live = flags.has('live');
  if (live) {
    if (!flags.has('yes')) refusals.push('Live mode needs --yes.');
    if (!flags.has('channels-approved'))
      refusals.push('Live mode needs --channels-approved for the exact named channel ids.');
    if (!canonical && !alias)
      refusals.push(`Live mode needs ${BUFFER_API_KEY_ENV} in the environment.`);
  }

  if (refusals.length) return { refusals };
  return {
    refusals,
    config: {
      mode: live ? 'live' : 'plan',
      apiKey: live ? canonical || alias : '',
      baseUrl,
      accountId,
      organizationId,
      scheduledAt,
      probeLabel,
      channels,
      targets,
      media,
    },
  };
}
