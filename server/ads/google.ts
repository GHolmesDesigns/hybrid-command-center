/**
 * The real Google Ads provider. Reads only: one token refresh, the account list, and one
 * single-row customer query per approved account. It sends no developer-token header
 * (`docs/google-ads-api-surface.md`) and a `login-customer-id` only when one is configured.
 */
import { google } from 'googleapis';
import { z } from 'zod';
import { ADS_API_VERSION, adsAccountSnapshotSchema } from '../../shared/ads.ts';
import { fetchAccessibleCustomers, type AdsOAuthCredentials } from './oauth.ts';
import type { AdsProvider } from './provider.ts';

const ADS_REQUEST_TIMEOUT_MS = 30_000;
/** One customer row is a few hundred bytes; anything near this is not the answer asked for. */
const MAX_RESPONSE_CHARS = 100_000;

const CUSTOMER_QUERY =
  'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1';

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
      const response = await fetch(
        `https://googleads.googleapis.com/${ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(options?.loginCustomerId ? { 'login-customer-id': options.loginCustomerId } : {}),
          },
          body: JSON.stringify({ query: CUSTOMER_QUERY }),
          signal: AbortSignal.timeout(ADS_REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > MAX_RESPONSE_CHARS) throw new Error('response too large');
      const rows = customerBatchesSchema.parse(JSON.parse(text)).flatMap((batch) => batch.results);
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
  };
}
