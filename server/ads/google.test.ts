/**
 * The real Google Ads provider against a stubbed `fetch` (C258): never Google.
 *
 * What this protects: the three performance reads send `Authorization` and a `login-customer-id`
 * only when one is configured, never a `developer-token`; each is its own query; a stream that was
 * cut off or runs past the size cap is an error rather than a short result; and a populated row's
 * 64-bit integers and fractional conversions come through as the numbers they are.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADS_SYNC_LIMITS } from '../../shared/ads.ts';
import { createGoogleAdsProvider } from './google.ts';

const credentials = { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb' };
const ID = '1234567890';
const WINDOW = { startDate: '2026-07-05', endDate: '2026-10-02' };

interface Sent {
  url: string;
  headers: Record<string, string>;
  query: string;
}
const sent: Sent[] = [];

/** One body per call, delivered as the chunks given so a stream can be cut mid-array. */
function stubFetch(...bodies: (string | string[])[]) {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      sent.push({ url, headers: init.headers, query: JSON.parse(init.body).query });
      const body = bodies[Math.min(call, bodies.length - 1)]!;
      call += 1;
      const chunks = Array.isArray(body) ? body : [body];
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { status: 200 },
      );
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe('Google Ads performance reads', () => {
  it('sends the three queries as separate calls with Authorization only', async () => {
    stubFetch(
      JSON.stringify([
        {
          results: [
            {
              customer: {
                id: ID,
                descriptiveName: 'Agency',
                currencyCode: 'USD',
                timeZone: 'America/New_York',
                status: 'ENABLED',
              },
            },
          ],
        },
      ]),
      JSON.stringify([{ results: [] }]),
      JSON.stringify([{ results: [] }]),
    );
    const provider = createGoogleAdsProvider(credentials);
    await provider.readAccount('token', ID);
    await provider.readCampaigns('token', ID);
    await provider.readCampaignDays('token', ID, WINDOW);
    expect(sent.map((call) => call.url)).toEqual(
      Array(3).fill(`https://googleads.googleapis.com/v25/customers/${ID}/googleAds:searchStream`),
    );
    expect(sent[1]!.query).toBe(
      'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign',
    );
    expect(sent[2]!.query).toBe(
      "SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '2026-07-05' AND '2026-10-02'",
    );
    // The campaign query carries no metric, so a campaign with no activity cannot be filtered out.
    expect(sent[1]!.query).not.toMatch(/metrics|segments/);
    for (const call of sent) {
      expect(call.headers.Authorization).toBe('Bearer token');
      expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain(
        'developer-token',
      );
      expect(Object.keys(call.headers).map((key) => key.toLowerCase())).not.toContain(
        'login-customer-id',
      );
    }
  });

  it('sends login-customer-id exactly when one is given', async () => {
    stubFetch(JSON.stringify([{ results: [] }]));
    const provider = createGoogleAdsProvider(credentials);
    await provider.readCampaigns('token', ID, { loginCustomerId: '9999999999' });
    await provider.readCampaignDays('token', ID, WINDOW, { loginCustomerId: '9999999999' });
    expect(sent.map((call) => call.headers['login-customer-id'])).toEqual([
      '9999999999',
      '9999999999',
    ]);
    expect(sent.every((call) => !('developer-token' in call.headers))).toBe(true);
  });

  it('reads populated rows: 64-bit integers as strings, a fractional conversion, an omitted zero', async () => {
    stubFetch(
      JSON.stringify([
        {
          results: [
            {
              campaign: {
                id: '42',
                name: 'Brand',
                status: 'ENABLED',
                advertisingChannelType: 'SEARCH',
              },
            },
            {
              campaign: {
                id: '43',
                name: 'Quiet',
                status: 'PAUSED',
                advertisingChannelType: 'SMART',
              },
            },
          ],
        },
      ]),
      JSON.stringify([
        {
          results: [
            {
              campaign: { id: '42' },
              segments: { date: '2026-10-01' },
              metrics: {
                impressions: '1200',
                clicks: '34',
                costMicros: '12345678',
                conversions: 2.5,
              },
            },
          ],
        },
        {
          // Google leaves a zero metric out entirely; the row itself was still reported.
          results: [
            {
              campaign: { id: '42' },
              segments: { date: '2026-10-02' },
              metrics: { impressions: '5' },
            },
          ],
        },
      ]),
    );
    const provider = createGoogleAdsProvider(credentials);
    expect(await provider.readCampaigns('t', ID)).toEqual([
      { customerId: ID, campaignId: '42', name: 'Brand', status: 'ENABLED', channelType: 'SEARCH' },
      { customerId: ID, campaignId: '43', name: 'Quiet', status: 'PAUSED', channelType: 'SMART' },
    ]);
    expect(await provider.readCampaignDays('t', ID, WINDOW)).toEqual([
      {
        customerId: ID,
        campaignId: '42',
        date: '2026-10-01',
        impressions: 1200,
        clicks: 34,
        costMicros: 12_345_678,
        conversions: 2.5,
      },
      {
        customerId: ID,
        campaignId: '42',
        date: '2026-10-02',
        impressions: 5,
        clicks: 0,
        costMicros: 0,
        conversions: 0,
      },
    ]);
  });

  it('fails a stream that stops before its closing bracket instead of returning the rows it had', async () => {
    const whole = JSON.stringify([
      {
        results: [
          { campaign: { id: '42' }, segments: { date: '2026-10-01' }, metrics: { clicks: '1' } },
        ],
      },
      {
        results: [
          { campaign: { id: '42' }, segments: { date: '2026-10-02' }, metrics: { clicks: '2' } },
        ],
      },
    ]);
    stubFetch([whole.slice(0, Math.floor(whole.length * 0.7))]);
    await expect(
      createGoogleAdsProvider(credentials).readCampaignDays('t', ID, WINDOW),
    ).rejects.toThrow(/ended before it was complete/);
  });

  it('refuses a response past the size cap without reading it all', async () => {
    const chunk = 'x'.repeat(1_000_000);
    stubFetch(Array(ADS_SYNC_LIMITS.responseChars / 1_000_000 + 2).fill(chunk));
    await expect(
      createGoogleAdsProvider(credentials).readCampaignDays('t', ID, WINDOW),
    ).rejects.toThrow(/too large/);
  });

  it('refuses a non-OK answer with the status only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"private detail"}', { status: 429 })),
    );
    const error = await createGoogleAdsProvider(credentials)
      .readCampaigns('t', ID)
      .catch((e: Error) => e);
    expect((error as Error).message).toBe('HTTP 429');
  });
});
