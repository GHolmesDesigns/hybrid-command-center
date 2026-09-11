export const PROBE_USAGE = `Usage:
  npm run probe:agent-cost -- [--live] [--yes] [--probe-label <label>] [--base-url <url>]

Plans by default. Live mode is owner-run only and never CI:
  - CURSOR_ADMIN_API_KEY in the environment
  - --live, --yes, and an unused --probe-label
  - type the probe label back at the prompt`;

export interface ProbeConfig {
  mode: 'plan' | 'live';
  apiKey: string;
  baseUrl: string;
  probeLabel: string;
  yes: boolean;
}

export interface ProbeParseOutcome {
  config?: ProbeConfig;
  refusals: string[];
  notices: string[];
}

export function parseProbeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  now = new Date(),
): ProbeParseOutcome {
  void now;
  const refusals: string[] = [];
  const notices: string[] = [];
  const live = argv.includes('--live');
  const yes = argv.includes('--yes');
  const probeLabelIndex = argv.indexOf('--probe-label');
  const probeLabel = probeLabelIndex >= 0 ? argv[probeLabelIndex + 1] : '';
  const baseUrlIndex = argv.indexOf('--base-url');
  const baseUrl = baseUrlIndex >= 0 ? argv[baseUrlIndex + 1] : 'https://api.cursor.com';
  const apiKey = env.CURSOR_ADMIN_API_KEY ?? '';

  if (!probeLabel) refusals.push('--probe-label is required.');
  if (live) {
    if (!yes) refusals.push('--yes is required for live mode.');
    if (!apiKey) refusals.push('CURSOR_ADMIN_API_KEY is required for live mode.');
  } else {
    notices.push('Plan only — nothing will be contacted.');
  }
  if (baseUrlIndex >= 0 && !baseUrl?.startsWith('http')) refusals.push('--base-url must be https.');

  if (refusals.length) return { refusals, notices };
  return {
    config: {
      mode: live ? 'live' : 'plan',
      apiKey,
      baseUrl: baseUrl ?? 'https://api.cursor.com',
      probeLabel: probeLabel ?? '',
      yes,
    },
    refusals,
    notices,
  };
}

export function renderPlan(config: ProbeConfig, notices: readonly string[]): string {
  const lines = [
    `Mode: ${config.mode}`,
    `Probe label: ${config.probeLabel}`,
    `Base URL: ${config.baseUrl}`,
    'Endpoint: GET /teams/v1/usage',
    'Expected: JSON usage rows with model, quantity, unit/currency, window, optional agent label.',
  ];
  for (const notice of notices) lines.push(notice);
  if (config.mode === 'plan') lines.push('Live mode would send Authorization: Bearer [redacted].');
  return lines.join('\n');
}
