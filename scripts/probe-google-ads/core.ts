import { z } from 'zod';

export const ADS_API_VERSION = 'v25';
export const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
export const ADS_REQUEST_CAP = 8;
const customerId = z
  .string()
  .regex(/^\d{10}$/, 'account must be a 10-digit customer ID without dashes');
const date = z.iso.date();

export const ADS_QUERIES = {
  customer:
    'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1',
  campaign:
    'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign',
  metrics: (start: string, end: string) =>
    `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${start}' AND '${end}'`,
};

export interface AdsProbeConfig {
  account: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  start: string;
  end: string;
}
export type AdsTransport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export function parseAdsProbeArgs(
  args: string[],
  env: NodeJS.ProcessEnv,
): {
  help?: boolean;
  live?: boolean;
  config?: AdsProbeConfig;
  error?: string;
} {
  if (args.includes('--help')) return { help: true };
  if (!args.includes('--live'))
    return args.length ? { error: 'unknown plan arguments' } : { live: false };
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--live' || flag === '--yes' || flag === '--account-approved') continue;
    if (
      !['--account', '--start', '--end'].includes(flag) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--') ||
      options.has(flag)
    )
      return { error: 'invalid or repeated option' };
    options.set(flag, args[++i]);
  }
  if (!args.includes('--yes') || !args.includes('--account-approved'))
    return { error: '--yes and --account-approved are required' };
  const account = customerId.safeParse(options.get('--account'));
  if (!account.success) return { error: 'an explicit 10-digit --account is required' };
  const start = date.safeParse(options.get('--start'));
  const end = date.safeParse(options.get('--end'));
  if (
    !start.success ||
    !end.success ||
    start.data > end.data ||
    (Date.parse(end.data) - Date.parse(start.data)) / 86400000 > 89
  )
    return { error: 'explicit --start and --end must cover at most 90 days' };
  const clientId = env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = env.GOOGLE_ADS_CLIENT_SECRET;
  const refreshToken = env.GOOGLE_ADS_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken)
    return {
      error:
        'GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, and GOOGLE_ADS_REFRESH_TOKEN are required',
    };
  return {
    live: true,
    config: {
      account: account.data,
      start: start.data,
      end: end.data,
      clientId,
      clientSecret,
      refreshToken,
    },
  };
}

export function renderAdsPlan(): string {
  return `Google Ads ${ADS_API_VERSION} read-only probe (OAuth scope ${ADS_SCOPE}).\nDefault: plan only, no network contact.\nLive requires --live --yes --account-approved --account <10-digit-id> --start YYYY-MM-DD --end YYYY-MM-DD, credentials in environment, then typing LIVE.\nProposed requests: 1 OAuth refresh; 1 ListAccessibleCustomers; 1 approved-account customer metadata SearchStream; 1 approved-account campaign metadata SearchStream; 1 approved-account dated metrics SearchStream.\nHard cap: ${ADS_REQUEST_CAP} HTTP requests, including OAuth and failed calls. No developer-token header. No Ads writes. Results contain counts only; never commit a transcript.`;
}

const accessibleSchema = z.object({
  resourceNames: z.array(z.string().regex(/^customers\/\d{10}$/)).max(1000),
});
const streamSchema = z
  .array(z.object({ results: z.array(z.unknown()).max(10000).optional() }))
  .max(100);

export async function runAdsProbe(config: AdsProbeConfig, transport: AdsTransport) {
  let requests = 0;
  async function request(url: string, init: RequestInit): Promise<unknown> {
    if (++requests > ADS_REQUEST_CAP) throw new Error('request cap reached');
    let response: Pick<Response, 'ok' | 'status' | 'json'>;
    try {
      response = await transport(url, init);
    } catch {
      throw new Error('network request failed');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} at request ${requests}`);
    try {
      return await response.json();
    } catch {
      throw new Error('invalid JSON response');
    }
  }
  const tokenResult = z.object({ access_token: z.string().min(1) }).safeParse(
    await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
        grant_type: 'refresh_token',
      }),
    }),
  );
  if (!tokenResult.success) throw new Error('OAuth response missing access token');
  const headers = {
    Authorization: `Bearer ${tokenResult.data.access_token}`,
    'Content-Type': 'application/json',
  };
  const accessible = accessibleSchema.safeParse(
    await request(
      `https://googleads.googleapis.com/${ADS_API_VERSION}/customers:listAccessibleCustomers`,
      { method: 'GET', headers },
    ),
  );
  if (!accessible.success) throw new Error('invalid accessible-customer response');
  const approvedAccountPresent = accessible.data.resourceNames.includes(
    `customers/${config.account}`,
  );
  if (!approvedAccountPresent) throw new Error('approved account was not directly accessible');
  async function search(query: string): Promise<number> {
    const response = streamSchema.safeParse(
      await request(
        `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${config.account}/googleAds:searchStream`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ query }),
        },
      ),
    );
    if (!response.success) throw new Error('invalid or oversized SearchStream response');
    return response.data.reduce((sum, batch) => sum + (batch.results?.length ?? 0), 0);
  }
  const metadataRows = await search(ADS_QUERIES.customer);
  const campaignRows = await search(ADS_QUERIES.campaign);
  const metricRows = await search(ADS_QUERIES.metrics(config.start, config.end));
  return {
    requests,
    accessibleCount: accessible.data.resourceNames.length,
    approvedAccountPresent,
    metadataRows,
    campaignRows,
    metricRows,
  };
}
