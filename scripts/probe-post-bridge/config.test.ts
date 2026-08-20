import { describe, expect, it } from 'vitest';
import {
  parseAccountSpecification,
  parseArgv,
  parseProbeArgs,
  PROBE_API_KEY_ENV,
  PROBE_MIN_SCHEDULE_HOURS,
  PROBE_STOP_CONDITIONS,
} from './config.ts';

const NOW = new Date('2026-08-20T12:00:00Z');
const FAR = '2026-08-25T14:00:00Z';
const KEY = { [PROBE_API_KEY_ENV]: 'pb_live_test' };

const live = (extra: string[] = []): string[] => [
  '--live',
  '--yes',
  '--accounts-approved',
  '--scheduled-at',
  FAR,
  '--probe-label',
  'hcc-probe-0820',
  '--account',
  'linkedin:101',
  ...extra,
];

const refusals = (argv: string[], env: Record<string, string | undefined> = {}): string[] =>
  parseProbeArgs(argv, env, NOW).refusals;

describe('parseArgv', () => {
  it('keeps every repeat of an option', () => {
    const parsed = parseArgv(['--account', 'linkedin:1', '--account', 'linkedin:2']);
    expect(parsed.options.get('account')).toEqual(['linkedin:1', 'linkedin:2']);
  });

  it('treats an option with no value as unknown rather than as a flag', () => {
    expect(parseArgv(['--probe-label', '--yes']).unknown).toEqual(['--probe-label (no value)']);
  });

  it('treats a bare word as unknown, because this script takes no positionals', () => {
    expect(parseArgv(['probe']).unknown).toEqual(['probe']);
  });
});

describe('parseAccountSpecification', () => {
  it('accepts <platform>:<id>', () => {
    expect(parseAccountSpecification('linkedin:101')).toEqual({
      platform: 'linkedin',
      accountId: 101,
    });
  });

  it('refuses a platform this app does not know, so a typo cannot become an ignored key', () => {
    expect(parseAccountSpecification('linkedln:101')).toContain('names no platform');
  });

  it('refuses a missing half, a non-numeric id, and a zero id', () => {
    expect(typeof parseAccountSpecification('linkedin')).toBe('string');
    expect(typeof parseAccountSpecification('linkedin:abc')).toBe('string');
    expect(typeof parseAccountSpecification('linkedin:0')).toBe('string');
    expect(typeof parseAccountSpecification('linkedin:1:2')).toBe('string');
  });
});

describe('live mode', () => {
  it('accepts a complete invocation', () => {
    const outcome = parseProbeArgs(live(), KEY, NOW);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.config?.mode).toBe('live');
    expect(outcome.config?.apiKey).toBe('pb_live_test');
    expect(outcome.config?.accounts).toEqual([{ platform: 'linkedin', accountId: 101 }]);
  });

  it('needs the key from the environment', () => {
    expect(refusals(live())).toContain(`Live mode needs ${PROBE_API_KEY_ENV} in the environment.`);
  });

  it('refuses the key as an argument, naming the variable instead', () => {
    const said = refusals([...live(), '--api-key', 'pb_live_test'], KEY);
    expect(said.join(' ')).toContain(PROBE_API_KEY_ENV);
    expect(said.join(' ')).toContain('process list');
  });

  it('needs --yes', () => {
    const argv = live().filter((argument) => argument !== '--yes');
    expect(refusals(argv, KEY).join(' ')).toContain('needs --yes');
  });

  it('needs the operator to state the accounts are approved', () => {
    const argv = live().filter((argument) => argument !== '--accounts-approved');
    expect(refusals(argv, KEY).join(' ')).toContain('--accounts-approved');
  });

  it('needs at least one explicit account and has no default', () => {
    const argv = live().filter(
      (argument, index, all) => argument !== 'linkedin:101' && all[index + 1] !== 'linkedin:101',
    );
    expect(refusals(argv, KEY).join(' ')).toContain('There is no default account');
  });

  it('refuses the same account named twice', () => {
    expect(refusals(live(['--account', 'linkedin:101']), KEY).join(' ')).toContain('named twice');
  });

  it('leaves the key out of a plan-mode config, so plan mode cannot reach the provider', () => {
    const argv = live().filter((argument) => argument !== '--live');
    const outcome = parseProbeArgs(argv, KEY, NOW);
    expect(outcome.config?.mode).toBe('plan');
    expect(outcome.config?.apiKey).toBe('');
  });
});

describe('--scheduled-at', () => {
  const withSchedule = (value: string): string[] => [
    ...live().slice(0, 3),
    '--scheduled-at',
    value,
    '--probe-label',
    'hcc-probe-0820',
    '--account',
    'linkedin:101',
  ];

  it('needs to be at least the minimum horizon away', () => {
    const soon = new Date(NOW.getTime() + 47 * 3_600_000).toISOString();
    expect(refusals(withSchedule(soon), KEY).join(' ')).toContain(
      `at least ${PROBE_MIN_SCHEDULE_HOURS}`,
    );
  });

  it('refuses a past instant', () => {
    expect(refusals(withSchedule('2026-08-19T12:00:00Z'), KEY).join(' ')).toContain('hours away');
  });

  it('refuses a local-time string rather than guessing a zone', () => {
    expect(refusals(withSchedule('2026-08-25T14:00:00'), KEY).join(' ')).toContain('no time zone');
  });

  it('accepts an explicit offset and normalizes it', () => {
    const outcome = parseProbeArgs(withSchedule('2026-08-25T14:00:00+02:00'), KEY, NOW);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.config?.scheduledAt).toBe('2026-08-25T12:00:00.000Z');
  });

  it('refuses nonsense and a missing value', () => {
    expect(refusals(withSchedule('yesterdayZ'), KEY).join(' ')).toContain('not a date and time');
    expect(refusals(live().filter((argument) => argument !== FAR)).join(' ')).toContain(
      '--scheduled-at exactly once',
    );
  });
});

describe('--probe-label', () => {
  const withLabel = (value: string): string[] => [
    '--live',
    '--yes',
    '--accounts-approved',
    '--scheduled-at',
    FAR,
    '--probe-label',
    value,
    '--account',
    'linkedin:101',
  ];

  it('refuses a label too short, too long, or in the wrong alphabet', () => {
    expect(refusals(withLabel('short'), KEY).join(' ')).toContain('--probe-label');
    expect(refusals(withLabel('a'.repeat(49)), KEY).join(' ')).toContain('--probe-label');
    expect(refusals(withLabel('HCC-Probe-0820'), KEY).join(' ')).toContain('--probe-label');
    expect(refusals(withLabel('hcc probe 0820'), KEY).join(' ')).toContain('--probe-label');
  });

  it('accepts a plain lowercase label', () => {
    expect(parseProbeArgs(withLabel('hcc-probe-0820'), KEY, NOW).refusals).toEqual([]);
  });
});

describe('notices', () => {
  it('says up front which questions this invocation cannot answer', () => {
    const outcome = parseProbeArgs(live(), KEY, NOW);
    const said = outcome.notices.join(' ');
    expect(said).toContain('question 1');
    expect(said).toContain('No youtube account');
    expect(said).toContain('--video');
    expect(said).toContain('--provider-ui-post');
  });

  it('stops saying question 1 is unaskable once a platform has two accounts', () => {
    const outcome = parseProbeArgs(live(['--account', 'linkedin:102']), KEY, NOW);
    expect(outcome.notices.join(' ')).not.toContain('question 1');
  });
});

describe('--base-url', () => {
  it('defaults to the versioned provider URL and refuses anything not https', () => {
    expect(parseProbeArgs(live(), KEY, NOW).config?.baseUrl).toBe('https://api.post-bridge.com/v1');
    expect(refusals(live(['--base-url', 'http://localhost:1/v1']), KEY).join(' ')).toContain(
      'must be https',
    );
  });
});

describe('the stop conditions', () => {
  it('are stated rather than checked, and cover every human condition on the card', () => {
    const said = PROBE_STOP_CONDITIONS.join(' ');
    expect(said).toContain('disposable or explicitly approved');
    expect(said).toContain('production content');
    expect(said).toContain('read back');
    expect(said).toContain('clean up immediately');
    expect(said).toContain('leave a post scheduled');
  });
});
