/**
 * Owner-run production MCP smoke configuration (C134 / #384).
 *
 * Plan by default — contacts nothing. Live mode performs discovery and one bounded read via the
 * operator connection diagnostic, asserting workspace checksums are unchanged. It never creates
 * handoffs or runs write tools.
 */
export const EVAL_SMOKE_PASSWORD_ENV = 'HCC_EVAL_SMOKE_PASSWORD';

export type EvalSmokeConfig = {
  mode: 'plan' | 'live';
  baseUrl: string;
  password: string;
};

export type EvalSmokeGuardOutcome = {
  config?: EvalSmokeConfig;
  refusals: string[];
};

export const EVAL_SMOKE_USAGE = `Usage
  Plan only; contacts nothing:
    npm run eval:mcp-smoke -- --base-url https://hcc.example.com

  Owner-run live smoke (read-only):
    HCC_EVAL_SMOKE_PASSWORD=… npm run eval:mcp-smoke -- --live --yes \\
      --base-url https://hcc.example.com

The operator password is read from HCC_EVAL_SMOKE_PASSWORD. It is never accepted on the command
line. The live path calls POST /api/mcp/health/test only — discovery plus one bounded resource
read — and asserts workspaceChecksumUnchanged. No MCP write tool is invoked.`;

export const EVAL_SMOKE_STOP_CONDITIONS = [
  'Stop unless the base URL is an owner-approved non-local origin (or an explicit local lab).',
  'Stop if the diagnostic reports ok=false or workspaceChecksumUnchanged=false.',
  'Never call a coordination, workspace, Signal, or integration write tool.',
  'Never commit the password, cookie, or raw transcript.',
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
    if (name === 'base-url') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) unknown.push(`${argument} (no value)`);
      else {
        options.set(name, [...(options.get(name) ?? []), value]);
        index += 1;
      }
    } else if (name === 'live' || name === 'yes' || name === 'help') {
      flags.add(name);
    } else {
      unknown.push(argument);
      if (
        /(?:api-?)?key|token|password/i.test(name) &&
        argv[index + 1] &&
        !argv[index + 1].startsWith('--')
      )
        index += 1;
    }
  }
  return { flags, options, unknown };
}

export function parseEvalSmokeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): EvalSmokeGuardOutcome {
  const parsed = parseArgv(argv);
  const refusals: string[] = [];
  if (parsed.unknown.length) {
    for (const item of parsed.unknown) refusals.push(`Unknown argument: ${item}`);
  }
  const urls = parsed.options.get('base-url') ?? [];
  if (urls.length !== 1) refusals.push('Pass --base-url exactly once.');
  const baseUrl = urls[0] ?? '';
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        refusals.push('--base-url must be http: or https:.');
      }
      if (url.username || url.password || url.search || url.hash) {
        refusals.push('--base-url must not carry credentials, query, or hash.');
      }
    } catch {
      refusals.push('--base-url is not a valid URL.');
    }
  }

  const live = parsed.flags.has('live');
  const yes = parsed.flags.has('yes');
  if (live && !yes) refusals.push('Live mode requires --yes.');
  const password = (env[EVAL_SMOKE_PASSWORD_ENV] ?? '').trim();
  if (live && !password) refusals.push(`Live mode requires ${EVAL_SMOKE_PASSWORD_ENV}.`);

  if (refusals.length) return { refusals };
  return {
    config: {
      mode: live ? 'live' : 'plan',
      baseUrl: baseUrl.replace(/\/$/, ''),
      password,
    },
    refusals: [],
  };
}
