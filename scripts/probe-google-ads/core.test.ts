import { describe, expect, it } from 'vitest';
import {
  AdsRequestBudget,
  describeAdsOutcome,
  ADS_REQUEST_CAP,
  parseAdsProbeArgs,
  renderAdsPlan,
  runAdsProbe,
  type AdsProbeConfig,
  type AdsTransport,
} from './core.ts';

const config: AdsProbeConfig = {
  account: '1234567890',
  start: '2026-07-05',
  end: '2026-10-02',
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
};
const args = [
  '--live',
  '--yes',
  '--account-approved',
  '--account',
  config.account,
  '--start',
  config.start,
  '--end',
  config.end,
];

describe('Google Ads probe guards', () => {
  it('plans locally without needing credentials and names every proposed request', () => {
    expect(parseAdsProbeArgs([], {}).live).toBe(false);
    expect(renderAdsPlan()).toContain('1 approved-account dated metrics SearchStream');
  });

  it('refuses each missing guard for its own reason, and enforces the 90-date boundary', () => {
    const env = {
      GOOGLE_ADS_CLIENT_ID: 'a',
      GOOGLE_ADS_CLIENT_SECRET: 'b',
      GOOGLE_ADS_REFRESH_TOKEN: 'c',
    };
    const withEnd = (end: string) => [...args.slice(0, -1), end];
    expect(
      parseAdsProbeArgs(
        args.filter((a) => a !== '--account-approved'),
        env,
      ).error,
    ).toBe('--yes and --account-approved are required');
    expect(
      parseAdsProbeArgs(
        args.filter((a) => a !== '--yes'),
        env,
      ).error,
    ).toBe('--yes and --account-approved are required');
    const noAccount = args.filter((a) => a !== '--account' && a !== config.account);
    expect(parseAdsProbeArgs(noAccount, env).error).toBe(
      'an explicit 10-digit --account is required',
    );
    expect(parseAdsProbeArgs(args, {}).error).toMatch(/GOOGLE_ADS_CLIENT_ID/);
    expect(parseAdsProbeArgs(['--unknown'], env).error).toBe('unknown plan arguments');
    expect(parseAdsProbeArgs(['--help'], env).help).toBe(true);
    expect(parseAdsProbeArgs([...args, '--account', config.account], env).error).toBe(
      'invalid or repeated option',
    );
    // 2026-07-05..2026-10-02 is exactly 90 calendar dates; one more day is refused.
    expect(parseAdsProbeArgs(args, env).config?.end).toBe('2026-10-02');
    expect(parseAdsProbeArgs(withEnd('2026-10-03'), env).error).toMatch(/at most 90 days/);
    expect(parseAdsProbeArgs(withEnd('2026-07-04'), env).error).toMatch(/at most 90 days/);
    expect(parseAdsProbeArgs(withEnd('2026-07-05'), env).config?.end).toBe('2026-07-05');
  });

  it('reads only the approved account, omits developer token, and reports empty rows honestly', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const payloads = [
      { access_token: 'temporary' },
      { resourceNames: ['customers/1234567890', 'customers/9999999999'] },
      [{ results: [{ customer: { id: '1234567890' } }] }],
      [],
      [],
    ];
    const transport: AdsTransport = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => payloads[calls.length - 1] };
    };
    const result = await runAdsProbe(config, transport);
    expect(result).toEqual({
      requests: 5,
      accessibleCount: 2,
      customer: { accepted: true, rows: 1 },
      campaign: { accepted: true, rows: 0 },
      metrics: { accepted: true, rows: 0 },
    });
    expect(calls.slice(2).every(({ url }) => url.includes('/customers/1234567890/'))).toBe(true);
    expect(
      calls.every(
        ({ init }) =>
          !JSON.stringify(init.headers ?? {})
            .toLowerCase()
            .includes('developer-token'),
      ),
    ).toBe(true);
    expect(JSON.stringify(calls[4].init.body)).toContain(
      "segments.date BETWEEN '2026-07-05' AND '2026-10-02'",
    );
  });

  it('stops before account reads when direct access is absent', async () => {
    let count = 0;
    const transport: AdsTransport = async () => ({
      ok: true,
      status: 200,
      json: async () =>
        ++count === 1 ? { access_token: 'token' } : { resourceNames: ['customers/9999999999'] },
    });
    await expect(runAdsProbe(config, transport)).rejects.toThrow('not directly accessible');
    expect(count).toBe(2);
  });

  it('stops before request nine, even if the probe grows', () => {
    expect(ADS_REQUEST_CAP).toBe(8);
    const budget = new AdsRequestBudget();
    for (let n = 1; n <= ADS_REQUEST_CAP; n++) expect(budget.take()).toBe(n);
    expect(() => budget.take()).toThrow('request cap reached');
    expect(budget.used).toBe(ADS_REQUEST_CAP);
  });

  it('stops on HTTP, malformed OAuth, malformed discovery, and malformed stream responses', async () => {
    const response =
      (payload: unknown): AdsTransport =>
      async () => ({
        ok: true,
        status: 200,
        json: async () => payload,
      });
    await expect(
      runAdsProbe(config, async () => ({ ok: false, status: 403, json: async () => ({}) })),
    ).rejects.toThrow('HTTP 403');
    await expect(runAdsProbe(config, response({}))).rejects.toThrow('missing access token');
    let call = 0;
    await expect(
      runAdsProbe(config, async () =>
        response(++call === 1 ? { access_token: 'token' } : { resourceNames: ['bad'] })('', {}),
      ),
    ).rejects.toThrow('invalid accessible-customer');
  });

  it('records each rejected query and still runs the rest, keeping only the Google status enum', async () => {
    const calls: string[] = [];
    const transport: AdsTransport = async (_url, init) => {
      calls.push(String(init.body ?? ''));
      const n = calls.length;
      if (n === 1) return { ok: true, status: 200, json: async () => ({ access_token: 't' }) };
      if (n === 2)
        return {
          ok: true,
          status: 200,
          json: async () => ({ resourceNames: ['customers/1234567890'] }),
        };
      if (n === 3)
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: { status: 'INVALID_ARGUMENT', message: 'secret 1234567890' },
          }),
        };
      if (n === 4)
        return {
          ok: false,
          status: 500,
          json: async () => {
            throw new Error('not json');
          },
        };
      return { ok: true, status: 200, json: async () => ({ results: [] }) };
    };
    const result = await runAdsProbe(config, transport);
    expect(result.requests).toBe(5);
    expect(result.customer).toEqual({
      accepted: false,
      httpStatus: 400,
      errorStatus: 'INVALID_ARGUMENT',
    });
    expect(result.campaign).toEqual({ accepted: false, httpStatus: 500, errorStatus: null });
    expect(result.metrics).toEqual({ accepted: false, httpStatus: null, errorStatus: null });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(describeAdsOutcome(result.customer)).toBe('rejected (HTTP 400, INVALID_ARGUMENT)');
    expect(describeAdsOutcome({ accepted: true, rows: 3 })).toBe('accepted, 3 rows');
  });

  it('sends every request with a timeout signal', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const payloads = [
      { access_token: 't' },
      { resourceNames: ['customers/1234567890'] },
      [],
      [],
      [],
    ];
    await runAdsProbe(config, async (_url, init) => {
      signals.push(init.signal);
      return { ok: true, status: 200, json: async () => payloads[signals.length - 1] };
    });
    expect(signals).toHaveLength(5);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('stops on transport and JSON failures without exposing their bodies', async () => {
    await expect(
      runAdsProbe(config, async () => {
        throw new Error('secret');
      }),
    ).rejects.toThrow('network request failed');
    await expect(
      runAdsProbe(config, async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('secret');
        },
      })),
    ).rejects.toThrow('invalid JSON response');
  });
});
