/**
 * The real Google Ads provider. Reads only: one token refresh, the account list, and per approved
 * account one customer query, one campaign query, and one dated metrics query (C258), each its own
 * SearchStream call so a campaign with no activity is still listed. It sends no developer-token
 * header (`docs/google-ads-api-surface.md`) and a `login-customer-id` only when one is configured.
 */
import { google } from 'googleapis';
import { z } from 'zod';
import {
  ADS_API_VERSION,
  ADS_SYNC_LIMITS,
  adsAccountSnapshotSchema,
  adsCampaignDaySchema,
  adsCampaignSnapshotSchema,
} from '../../shared/ads.ts';
import { fetchAccessibleCustomers, type AdsOAuthCredentials } from './oauth.ts';
import type { AdsProvider } from './provider.ts';

const ADS_REQUEST_TIMEOUT_MS = 30_000;
/** One customer row is a few hundred bytes; anything near this is not the answer asked for. */
const MAX_CUSTOMER_RESPONSE_CHARS = 100_000;

const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1';

const CAMPAIGN_QUERY =
  'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type FROM campaign';

const metricsQuery = (startDate: string, endDate: string) =>
  `SELECT campaign.id, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;

/**
 * REST JSON leaves out a field holding its default, so a missing `manager` is false (a manager is
 * always sent as true) and a missing `status` is the unspecified value, which is never enabled.
 */
const customerBatchesSchema = z
  .array(
    z.object({
      results: z
        .array(
          z.object({
            customer: z.object({
              id: z.string(),
              descriptiveName: z.string().default('(unnamed account)'),
              currencyCode: z.string(),
              timeZone: z.string(),
              manager: z.boolean().default(false),
              status: z.string().default('UNSPECIFIED'),
            }),
          }),
        )
        .default([]),
    }),
  )
  .max(10);

/**
 * 64-bit integers arrive as JSON strings and a zero may be left out, so an absent metric on a row
 * the provider did report is 0. That is not a manufactured day: the row itself was reported.
 */
const int64 = z
  .union([z.string().regex(/^\d{1,19}$/), z.number()])
  .transform((value) => Number(value))
  .default(0);

const campaignBatchesSchema = z.array(
  z.object({
    results: z
      .array(
        z.object({
          campaign: z.object({
            id: z.string(),
            name: z.string().default(''),
            status: z.string().default('UNSPECIFIED'),
            advertisingChannelType: z.string().default('UNSPECIFIED'),
          }),
        }),
      )
      .default([]),
  }),
);

const dayBatchesSchema = z.array(
  z.object({
    results: z
      .array(
        z.object({
          campaign: z.object({ id: z.string() }),
          segments: z.object({ date: z.string() }),
          metrics: z
            .object({
              impressions: int64,
              clicks: int64,
              costMicros: int64,
              conversions: z.number().default(0),
            })
            .default({ impressions: 0, clicks: 0, costMicros: 0, conversions: 0 }),
        }),
      )
      .default([]),
  }),
);

/**
 * One SearchStream call, read to its end under a size cap. The body is read incrementally so an
 * oversized answer is refused at the cap rather than held whole, and a body cut short does not
 * parse as the JSON array it should be: a stream that did not finish is an error, never a result.
 */
async function searchStream(
  accessToken: string,
  customerId: string,
  query: string,
  maxChars: number,
  loginCustomerId?: string,
): Promise<unknown> {
  const response = await fetch(
    `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(loginCustomerId ? { 'login-customer-id': loginCustomerId } : {}),
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(ADS_REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let text = '';
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        await reader.cancel();
        throw new Error('response too large');
      }
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (text.length > maxChars) throw new Error('response too large');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('the stream ended before it was complete');
  }
}

export function createGoogleAdsProvider(credentials: AdsOAuthCredentials): AdsProvider {
  return {
    accessToken: async (refreshToken) => {
      const oauth = new google.auth.OAuth2(
        credentials.clientId,
        credentials.clientSecret,
        credentials.redirectUri,
      );
      oauth.setCredentials({ refresh_token: refreshToken });
      const { token } = await oauth.getAccessToken();
      if (!token) throw new Error('Google returned no access token');
      return token;
    },
    listAccessibleCustomers: fetchAccessibleCustomers,
    readAccount: async (accessToken, customerId, options) => {
      const body = await searchStream(
        accessToken,
        customerId,
        CUSTOMER_QUERY,
        MAX_CUSTOMER_RESPONSE_CHARS,
        options?.loginCustomerId,
      );
      const rows = customerBatchesSchema.parse(body).flatMap((batch) => batch.results);
      if (rows.length !== 1) throw new Error('expected exactly one customer row');
      const customer = rows[0]!.customer;
      // The answer must be about the account that was approved, not whichever one Google chose.
      if (customer.id.replace(/-/g, '') !== customerId) throw new Error('customer ID mismatch');
      return adsAccountSnapshotSchema.parse({
        customerId,
        descriptiveName: customer.descriptiveName,
        currencyCode: customer.currencyCode,
        timeZone: customer.timeZone,
        manager: customer.manager,
        status: customer.status,
      });
    },
    readCampaigns: async (accessToken, customerId, options) => {
      const body = await searchStream(
        accessToken,
        customerId,
        CAMPAIGN_QUERY,
        ADS_SYNC_LIMITS.responseChars,
        options?.loginCustomerId,
      );
      const rows = campaignBatchesSchema.parse(body).flatMap((batch) => batch.results);
      if (rows.length > ADS_SYNC_LIMITS.campaignsPerAccount) throw new Error('too many campaigns');
      return rows.map(({ campaign }) =>
        adsCampaignSnapshotSchema.parse({
          customerId,
          campaignId: campaign.id,
          name: campaign.name,
          status: campaign.status,
          channelType: campaign.advertisingChannelType,
        }),
      );
    },
    readCampaignDays: async (accessToken, customerId, window, options) => {
      const body = await searchStream(
        accessToken,
        customerId,
        metricsQuery(window.startDate, window.endDate),
        ADS_SYNC_LIMITS.responseChars,
        options?.loginCustomerId,
      );
      const rows = dayBatchesSchema.parse(body).flatMap((batch) => batch.results);
      if (rows.length > ADS_SYNC_LIMITS.dayRowsPerAccount) throw new Error('too many daily rows');
      return rows.map((row) =>
        adsCampaignDaySchema.parse({
          customerId,
          campaignId: row.campaign.id,
          date: row.segments.date,
          impressions: row.metrics.impressions,
          clicks: row.metrics.clicks,
          costMicros: row.metrics.costMicros,
          conversions: row.metrics.conversions,
        }),
      );
    },
  };
}
