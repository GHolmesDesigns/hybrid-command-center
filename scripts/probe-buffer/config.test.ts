import { describe, expect, it } from 'vitest';
import { parseBufferProbeArgs } from './config.ts';

const now = new Date('2026-08-23T12:00:00Z');
const base = [
  '--account',
  'account_1',
  '--organization',
  'org_1',
  '--scheduled-at',
  '2026-08-26T12:00:00Z',
  '--probe-label',
  'hcc-buffer-0826',
  '--channel',
  'tiktok:tt_1',
  '--channel',
  'youtube:yt_1',
];

describe('Buffer probe guards', () => {
  it('plans by default without reading a credential', () => {
    const outcome = parseBufferProbeArgs(base, {}, now);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.config).toMatchObject({ mode: 'plan', apiKey: '' });
  });

  it('requires every live acknowledgement and the environment credential', () => {
    const outcome = parseBufferProbeArgs(['--live', ...base], {}, now);
    expect(outcome.refusals).toEqual(
      expect.arrayContaining([
        'Live mode needs --yes.',
        'Live mode needs --channels-approved for the exact named channel ids.',
        'Live mode needs BUFFER_API_KEY in the environment.',
      ]),
    );
  });

  it('uses the canonical key before the one-release alias', () => {
    const outcome = parseBufferProbeArgs(
      ['--live', '--yes', '--channels-approved', ...base],
      { BUFFER_API_KEY: 'canonical', BUFFER_KEY: 'alias' },
      now,
    );
    expect(outcome.config?.apiKey).toBe('canonical');
  });

  it('accepts the alias only when the canonical key is absent', () => {
    const outcome = parseBufferProbeArgs(
      ['--live', '--yes', '--channels-approved', ...base],
      { BUFFER_KEY: 'alias' },
      now,
    );
    expect(outcome.config?.apiKey).toBe('alias');
  });

  it('binds one explicit public media fixture to its approved service', () => {
    const outcome = parseBufferProbeArgs(
      [...base, '--media', 'tiktok:image:https://static.example.com/probe.png'],
      {},
      now,
    );
    expect(outcome.refusals).toEqual([]);
    expect(outcome.config?.media).toEqual([
      {
        service: 'tiktok',
        kind: 'image',
        url: 'https://static.example.com/probe.png',
      },
    ]);
  });

  it('refuses a schedule inside the 48-hour safety margin', () => {
    const args = base.map((value) =>
      value === '2026-08-26T12:00:00Z' ? '2026-08-24T11:59:00Z' : value,
    );
    expect(parseBufferProbeArgs(args, {}, now).refusals).toContain(
      '--scheduled-at must be at least 48 hours away.',
    );
  });

  it('refuses unknown services, duplicate service routes, and command-line keys', () => {
    const outcome = parseBufferProbeArgs(
      [...base, '--channel', 'bluesky:bsky_1', '--channel', 'tiktok:tt_2', '--api-key', 'secret'],
      {},
      now,
    );
    expect(outcome.refusals.join('\n')).toMatch(/outside this card/);
    expect(outcome.refusals.join('\n')).toMatch(/duplicates an id or service/);
    expect(outcome.refusals.join('\n')).toMatch(/credential is read only from the environment/);
    expect(outcome.refusals.join('\n')).not.toContain('secret');
  });

  it.each([
    [['--account', 'bad id'], /account has an invalid id/],
    [['--organization', 'bad id'], /organization has an invalid id/],
    [['--probe-label', 'short'], /probe-label must be/],
    [['--scheduled-at', '2026-08-26T12:00:00'], /must carry Z/],
    [['--scheduled-at', 'not-a-dateZ'], /is not a date and time/],
    [['--base-url', 'http://api.buffer.com'], /credential-free HTTPS/],
    [['--base-url', 'not-a-url'], /absolute HTTPS URL/],
  ])('collects malformed option refusals for %j', (replacement, expected) => {
    const option = replacement[0];
    const index = base.indexOf(option);
    const args =
      index >= 0
        ? [...base.slice(0, index), ...replacement, ...base.slice(index + 2)]
        : [...base, ...replacement];
    expect(parseBufferProbeArgs(args, {}, now).refusals.join('\n')).toMatch(expected);
  });

  it('requires all plan identifiers and refuses duplicate ids and unsafe base URLs', () => {
    const missing = parseBufferProbeArgs([], {}, now);
    expect(missing.refusals.join('\n')).toMatch(/Pass --account exactly once/);
    expect(missing.refusals.join('\n')).toMatch(/Pass at least one explicit --channel/);

    const duplicated = parseBufferProbeArgs(
      [...base, '--channel', 'youtube:tt_1', '--base-url', 'https://user:pass@api.buffer.com'],
      {},
      now,
    );
    expect(duplicated.refusals.join('\n')).toMatch(/duplicates an id or service/);
    expect(duplicated.refusals.join('\n')).toMatch(/credential-free HTTPS/);
  });

  it('refuses positional words and options with missing values', () => {
    const outcome = parseBufferProbeArgs(['stray', '--account'], {}, now);
    expect(outcome.refusals).toContain('Unrecognised argument: stray.');
    expect(outcome.refusals).toContain('Unrecognised argument: --account (no value).');
  });

  it('refuses ambiguous, unsafe, duplicate, or unrouted media fixtures', () => {
    const outcome = parseBufferProbeArgs(
      [
        ...base.filter(
          (value, index) =>
            !(value === '--channel' && base[index + 1] === 'youtube:yt_1') &&
            value !== 'youtube:yt_1',
        ),
        '--media',
        'tiktok:image:http://static.example.com/probe.png',
        '--media',
        'tiktok:video:https://static.example.com/probe.mp4',
        '--media',
        'tiktok:image:https://static.example.com/second.png',
        '--media',
        'youtube:image:https://static.example.com/probe.png',
        '--media',
        'tiktok:image:https://static.example.com/probe.png?token=secret',
      ],
      {},
      now,
    );
    expect(outcome.refusals.join('\n')).toMatch(/credential-free, query-free HTTPS/);
    expect(outcome.refusals.join('\n')).toMatch(/duplicates the tiktok fixture/);
    expect(outcome.refusals.join('\n')).toMatch(/youtube, which is not an approved --channel/);
  });
});
