import { describe, expect, it } from 'vitest';
import {
  AdsRequestBudget,
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

  it('refuses missing approval, identity, credentials, and unbounded dates', () => {
    const env = {
      GOOGLE_ADS_CLIENT_ID: 'a',
      GOOGLE_ADS_CLIENT_SECRET: 'b',
      GOOGLE_ADS_REFRESH_TOKEN: 'c',
    };
    expect(
      parseAdsProbeArgs(
        args.filter((a) => a !== '--account-approved'),
        env,
      ).error,
    ).toBeTruthy();
    expect(
      parseAdsProbeArgs(
        args.filter((a) => a !== config.account),
        env,
      ).error,
    ).toBeTruthy();
    expect(parseAdsProbeArgs(args, {}).error).toBeTruthy();
    expect(parseAdsProbeArgs([...args.slice(0, -1), '2026-12-31'], env).error).toBeTruthy();
    expect(parseAdsProbeArgs(['--unknown'], env).error).toBe('unknown plan arguments');
    expect(parseAdsProbeArgs(['--help'], env).help).toBe(true);
    expect(parseAdsProbeArgs([...args, '--account', config.account], env).error).toBeTruthy();
    expect(parseAdsProbeArgs([...args.slice(0, -1), '2026-07-01'], env).error).toBeTruthy();
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
      approvedAccountPresent: true,
      metadataRows: 1,
      campaignRows: 0,
      metricRows: 0,
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
    call = 0;
    await expect(
      runAdsProbe(config, async () =>
        response(
          ++call === 1
            ? { access_token: 'token' }
            : call === 2
              ? { resourceNames: ['customers/1234567890'] }
              : { results: [] },
        )('', {}),
      ),
    ).rejects.toThrow('invalid or oversized SearchStream');
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
