/**
 * Google Ads: the shapes, vocabulary, and input rules the server and the browser both read.
 *
 * Ads is its own module with its own OAuth grant. Nothing here has a database in it, and nothing
 * here is shared with Drive or Signal beyond the redirect-shape rule.
 *
 * Only what the provider reports is modelled. Cost stays in the provider's integer micros because
 * currency differs by account and summing across currencies means nothing. A date is the account's
 * own local calendar date as Google reports it, never an instant. Impressions, clicks, and cost
 * micros are documented 64-bit integers and conversions is a documented double that can be
 * fractional (`docs/google-ads-api-surface.md`); those are field definitions, not observed populated
 * responses, and the storage follows them rather than assuming conversions are a count.
 */
import { z } from 'zod';
import { isAllowedOAuthRedirectUri } from './drive-oauth.ts';

/** The one scope the Ads API method set needs; no narrower read-only scope is documented. */
export const ADS_OAUTH_SCOPE = 'https://www.googleapis.com/auth/adwords';

export const ADS_REDIRECT_PATH = '/api/ads/oauth/callback';

/** Same shape rule as Drive's callback, on Ads' own path. */
export const isAllowedAdsRedirectUri = (value: string): boolean =>
  isAllowedOAuthRedirectUri(value, ADS_REDIRECT_PATH);

/** Free text from the provider is kept as a bounded excerpt, never whole. */
export const ADS_ACCOUNT_NAME_MAX = 200;
export const ADS_CAMPAIGN_NAME_MAX = 200;

export const ADS_CONNECTION_STATUSES = ['DISCONNECTED', 'CONNECTED', 'ERROR'] as const;
export type AdsConnectionStatus = (typeof ADS_CONNECTION_STATUSES)[number];

/** A refresh is read-then-one-write, so it lands or it does not; `PARTIAL` does not arise. */
export const ADS_SYNC_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;
export type AdsSyncOutcome = (typeof ADS_SYNC_OUTCOMES)[number];

/** Google's `CustomerStatus` and `CampaignStatus` enum names, including its two catch-alls. */
export const ADS_ACCOUNT_STATUSES = [
  'UNSPECIFIED',
  'UNKNOWN',
  'ENABLED',
  'CANCELED',
  'SUSPENDED',
  'CLOSED',
] as const;
export type AdsAccountStatus = (typeof ADS_ACCOUNT_STATUSES)[number];

export const ADS_CAMPAIGN_STATUSES = [
  'UNSPECIFIED',
  'UNKNOWN',
  'ENABLED',
  'PAUSED',
  'REMOVED',
] as const;
export type AdsCampaignStatus = (typeof ADS_CAMPAIGN_STATUSES)[number];

/** Strips the dashes Google's console shows (`123-456-7890`) before the 10-digit rule applies. */
export const normalizeAdsCustomerId = (value: string): string => value.trim().replace(/-/g, '');

export const adsCustomerIdSchema = z
  .string()
  .transform(normalizeAdsCustomerId)
  .pipe(z.string().regex(/^\d{10}$/, 'must be a 10-digit Google Ads customer ID'));

/** A campaign ID is a 64-bit integer; it is kept as the digits Google sent, never a number. */
export const adsCampaignIdSchema = z
  .string()
  .regex(/^\d{1,20}$/, 'must be a Google Ads campaign ID, digits only');

/** An account-local calendar date: `YYYY-MM-DD`, and a date that exists. */
export const adsDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'must be a real calendar date');

const boundedText = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1))
    .transform((value) => (value.length > max ? `${value.slice(0, max - 1)}…` : value));

/** Enum names Google adds over time are checked by shape, not by an allow-list this build lags. */
const providerEnumName = z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/, 'must be an enum name');

const nonNegativeSafeInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The provider's own account fields. A refresh replaces these and never touches local choices. */
export const adsAccountSnapshotSchema = z.object({
  customerId: adsCustomerIdSchema,
  descriptiveName: boundedText(ADS_ACCOUNT_NAME_MAX),
  currencyCode: z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 currency code'),
  timeZone: z.string().min(1).max(64),
  manager: z.boolean(),
  status: z.enum(ADS_ACCOUNT_STATUSES),
});
export type AdsAccountSnapshot = z.infer<typeof adsAccountSnapshotSchema>;

export const adsCampaignSnapshotSchema = z.object({
  customerId: adsCustomerIdSchema,
  campaignId: adsCampaignIdSchema,
  name: boundedText(ADS_CAMPAIGN_NAME_MAX),
  status: z.enum(ADS_CAMPAIGN_STATUSES),
  channelType: providerEnumName,
});
export type AdsCampaignSnapshot = z.infer<typeof adsCampaignSnapshotSchema>;

/**
 * One reported day for one campaign. A date the provider omitted has no row at all: that is "no
 * reported row", not a measured zero, and nothing synthesizes one.
 */
export const adsCampaignDaySchema = z.object({
  customerId: adsCustomerIdSchema,
  campaignId: adsCampaignIdSchema,
  date: adsDateSchema,
  impressions: nonNegativeSafeInt,
  clicks: nonNegativeSafeInt,
  costMicros: nonNegativeSafeInt,
  /** Fractional by definition; never rounded to a count. */
  conversions: z.number().finite().nonnegative(),
});
export type AdsCampaignDay = z.infer<typeof adsCampaignDaySchema>;

/**
 * What a person decides about an account, held apart from what the provider reports so a refresh
 * cannot overwrite it. `clientId: null` is **Unassigned**, a group and never a hidden account.
 */
export const adsAccountLocalSettingsSchema = z.object({
  customerId: adsCustomerIdSchema,
  approved: z.boolean(),
  clientId: z.string().min(1).nullable(),
});
export type AdsAccountLocalSettings = z.infer<typeof adsAccountLocalSettingsSchema>;

/** The Ads API version this build speaks; a connect makes exactly one call against it. */
export const ADS_API_VERSION = 'v25';

/** Where a person revokes the grant at Google; disconnecting here removes only the local copy. */
export const ADS_GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/**
 * Why a connect attempt did not complete. Fixed codes only: the browser maps each to its own
 * words, and nothing a provider said — a body, a message, a token — travels with one.
 */
export const ADS_CONNECT_FAILURES = [
  'denied',
  'missing_code',
  'exchange_failed',
  'no_refresh_token',
  'scope_mismatch',
  'account_list_failed',
  'encryption_unavailable',
] as const;
export type AdsConnectFailure = (typeof ADS_CONNECT_FAILURES)[number];

export const ADS_CONNECT_FAILURE_MESSAGE: Record<AdsConnectFailure, string> = {
  denied: 'Google did not grant access, so nothing changed.',
  missing_code: 'Google returned without an authorization code, so nothing changed.',
  exchange_failed: 'Google refused the authorization code, so nothing changed.',
  no_refresh_token:
    'Google did not issue a refresh token. Remove this app under Google Account permissions and connect again.',
  scope_mismatch: 'Google did not grant the Google Ads scope, so nothing changed.',
  account_list_failed:
    'Google Ads did not list any directly accessible accounts, so the connection was not saved.',
  encryption_unavailable:
    'The Google Ads encryption key is missing or unusable, so the connection was not saved.',
};

export const isAdsConnectFailure = (value: unknown): value is AdsConnectFailure =>
  typeof value === 'string' && (ADS_CONNECT_FAILURES as readonly string[]).includes(value);

/**
 * What the browser may know about the Ads connection. There is no token, no ciphertext, and no
 * client secret in it: `problem` is the one place the server explains a state it cannot use.
 */
export const adsConnectionStatusSchema = z.object({
  configured: z.boolean(),
  /** Names of the required variables still blank; never their values. */
  missing: z.array(z.string()),
  status: z.enum(ADS_CONNECTION_STATUSES),
  connectedAt: z.string().nullable(),
  scope: z.string().nullable(),
  viaManager: z.boolean(),
  problem: z.string().nullable(),
});
export type AdsConnectionState = z.infer<typeof adsConnectionStatusSchema>;

/**
 * Account selection and client mapping (C257).
 *
 * Three separate facts about an ad account, held apart so none can stand in for another:
 * *discoverable* (the grant reached it directly), *approved* (a person said this exact ID may be
 * read), and *mapped* (a person tied it to a client). Listing authorizes nothing, approval is what
 * lets the server read metadata for that one ID, and a mapping never changes either.
 */

/** Why an account cannot be a performance target, or null when it can. Read from provider metadata. */
export function adsTargetIssue(
  snapshot: { manager: boolean; status: string } | null,
): 'MANAGER' | 'NOT_ENABLED' | null {
  if (!snapshot) return null;
  if (snapshot.manager) return 'MANAGER';
  return snapshot.status === 'ENABLED' ? null : 'NOT_ENABLED';
}

export const ADS_TARGET_ISSUE_MESSAGE = {
  MANAGER:
    'A manager account holds other accounts and is not a serving account, so it is never a performance target.',
  NOT_ENABLED:
    'Only an enabled serving account can be a performance target; this one is cancelled, suspended, or closed.',
} as const;

/** Why a kept snapshot is no longer being refreshed. Reads stop; nothing is deleted. */
export type AdsStaleReason = 'DISCONNECTED' | 'ACCESS_LOST';

export const ADS_STALE_MESSAGE: Record<AdsStaleReason, string> = {
  DISCONNECTED:
    'Google Ads is not connected, so this is the last snapshot and it is not being refreshed.',
  ACCESS_LOST:
    'The connected Google account no longer reaches this account, so this is the last snapshot and it is not being refreshed.',
};

export interface AdsAccountClientRef {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

/** One row on the Ads accounts list. Provider fields are null until an approval read them. */
export interface AdsAccountView {
  customerId: string;
  /** The grant reached it directly the last time accounts were listed. */
  discovered: boolean;
  approved: boolean;
  approvedAt: string | null;
  /** What the provider reported, kept from the last read. Null before any approval attempt. */
  snapshot: {
    descriptiveName: string;
    currencyCode: string;
    timeZone: string;
    manager: boolean;
    status: string;
    snapshotAt: string;
  } | null;
  /** Set when the kept snapshot is not being refreshed. Only an approved account can be stale. */
  stale: AdsStaleReason | null;
  /** Null is **Unassigned**: shown as a group of its own, never hidden. */
  client: AdsAccountClientRef | null;
  /** Why this account cannot be approved, from its last metadata read. */
  targetIssue: 'MANAGER' | 'NOT_ENABLED' | null;
}

export interface AdsAccountsState {
  connectionStatus: AdsConnectionStatus;
  /** When accounts were last listed, or null when they never were. */
  discoveredAt: string | null;
  accounts: AdsAccountView[];
}

/**
 * Approving an account makes the exact ID typed here readable. The ID is sent back in the body as
 * well as in the path, so a request can only approve what its sender named twice.
 */
export const adsApprovalInputSchema = z.object({ confirmCustomerId: adsCustomerIdSchema });

export const adsMappingInputSchema = z.object({ clientId: z.string().min(1).max(200).nullable() });
export const adsMappingCommitSchema = adsMappingInputSchema.extend({
  planHash: z.string().length(64),
});

export type AdsMappingAction = 'ASSIGN' | 'REASSIGN' | 'UNASSIGN';

/** What a mapping change would do, with both ends named so the confirmation is about real records. */
export interface AdsMappingPlan {
  customerId: string;
  accountName: string;
  action: AdsMappingAction;
  from: AdsAccountClientRef | null;
  to: AdsAccountClientRef | null;
}
export interface AdsMappingPreview extends AdsMappingPlan {
  planHash: string;
}

/** The way Google's console shows a customer ID: `123-456-7890`. Display only; never sent back. */
export const formatAdsCustomerId = (customerId: string): string =>
  customerId.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');

/**
 * The performance snapshot (C258).
 *
 * A refresh reads the latest {@link ADS_SYNC_WINDOW_DAYS} account-local calendar dates, today
 * included, for every approved serving account, and replaces the provider-owned campaign and day
 * rows in one transaction or not at all. The bounds below are the budget `docs/google-ads-api-surface.md`
 * estimated, fixed here because an unbounded stream is how a refresh would spend a day's allowance.
 */
export const ADS_SYNC_WINDOW_DAYS = 90;

export const ADS_SYNC_LIMITS = {
  /** Accounts one refresh may read. Past this the refresh is refused before any call. */
  accounts: 25,
  /** Customer metadata, campaign metadata, then daily metrics: three Ads calls per account. */
  requestsPerAccount: 3,
  campaignsPerAccount: 5_000,
  dayRowsPerAccount: 100_000,
  /** Raw characters of one stream's response; a larger answer is refused, never truncated. */
  responseChars: 25_000_000,
} as const;

/** Every Ads call a refresh may make, token exchange excluded: the hard ceiling the wrapper enforces. */
export const ADS_SYNC_MAX_REQUESTS = ADS_SYNC_LIMITS.accounts * ADS_SYNC_LIMITS.requestsPerAccount;

export interface AdsSyncWindow {
  /** First account-local date, inclusive. */
  startDate: string;
  /** Today in the account's own time zone, inclusive. */
  endDate: string;
}

/**
 * The finite range one account is read for: its latest 90 local calendar dates including today.
 * The date is the one the account's own clock shows at `now`, because Google segments by that
 * calendar and a UTC date would drop or repeat a day for an account east or west of it.
 */
export function adsSyncWindow(now: Date, timeZone: string): AdsSyncWindow {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  const endDate = `${part('year')}-${part('month')}-${part('day')}`;
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) throw new Error('the account time zone is not usable');
  const start = new Date(end.getTime() - (ADS_SYNC_WINDOW_DAYS - 1) * 86_400_000);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

/** What the last refresh attempt did. A failure never changes the figures; it only says so. */
export interface AdsLastSync {
  at: string | null;
  outcome: AdsSyncOutcome | null;
  error: string | null;
}

export interface AdsCampaignDayView {
  date: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions: number;
}

export interface AdsCampaignView {
  campaignId: string;
  name: string;
  status: string;
  channelType: string;
  /** Only days the provider reported, oldest first. An absent date is not a measured zero. */
  days: AdsCampaignDayView[];
}

/** One account's stored snapshot. Currency and time zone stay here, beside the figures they govern. */
export interface AdsPerformanceAccount {
  customerId: string;
  descriptiveName: string;
  currencyCode: string;
  timeZone: string;
  approved: boolean;
  client: AdsAccountClientRef | null;
  stale: AdsStaleReason | null;
  /** The generation these figures came from, or null before the first refresh read this account. */
  syncedAt: string | null;
  window: AdsSyncWindow | null;
  campaigns: AdsCampaignView[];
}

export interface AdsPerformanceState {
  connectionStatus: AdsConnectionStatus;
  lastSync: AdsLastSync;
  /** True when the last attempt failed, so the figures below are the previous generation. */
  lastAttemptFailed: boolean;
  accounts: AdsPerformanceAccount[];
}

export interface AdsSyncResult {
  syncedAt: string;
  accounts: number;
  campaigns: number;
  days: number;
  /** Approved accounts the grant no longer reaches: left as they were and stale. */
  skipped: number;
}
