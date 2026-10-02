import type {
  AdsAccountSnapshot,
  AdsCampaignDay,
  AdsCampaignSnapshot,
  AdsSyncWindow,
} from '../../shared/ads.ts';
import type { AdsProvider } from './provider.ts';

/**
 * The Ads provider every automated test and the browser suite uses. It records each call so a test
 * can assert that no account was read before it was approved, rather than take the service's word.
 */
export class MockAdsProvider implements AdsProvider {
  accessTokenCalls: string[] = [];
  listCalls: string[] = [];
  /** Every customer ID `readAccount` was asked about, in order. */
  readCalls: string[] = [];
  /** Every customer ID `readCampaigns` was asked about, in order. */
  campaignCalls: string[] = [];
  /** Every customer ID and window `readCampaignDays` was asked about, in order. */
  dayCalls: { customerId: string; window: AdsSyncWindow }[] = [];
  /** The login-customer-id each read was given, so a test can see whether one was sent. */
  loginCustomerIds: (string | undefined)[] = [];
  /** Customer IDs the grant reaches directly. */
  accessible: string[] = ['1234567890'];
  /** Provider metadata by customer ID; an ID with no entry is one the provider cannot read. */
  accounts = new Map<string, AdsAccountSnapshot>();
  /** Campaign metadata by customer ID; an ID with no entry has no campaigns. */
  campaigns = new Map<string, AdsCampaignSnapshot[]>();
  /** Daily figures by customer ID, returned as given: a test decides what is reported. */
  days = new Map<string, AdsCampaignDay[]>();
  accessTokenError?: string;
  listError?: string;
  readError?: string;
  /** Fails the campaign query for these accounts. */
  campaignError = new Map<string, string>();
  /** Fails the metrics query for these accounts, the way a stream cut off after earlier chunks does. */
  dayError = new Map<string, string>();

  constructor() {
    this.accounts.set('1234567890', {
      customerId: '1234567890',
      descriptiveName: 'Agency account',
      currencyCode: 'USD',
      timeZone: 'America/New_York',
      manager: false,
      status: 'ENABLED',
    });
  }

  async accessToken(refreshToken: string) {
    this.accessTokenCalls.push(refreshToken);
    if (this.accessTokenError) throw new Error(this.accessTokenError);
    return 'mock-ads-access-token';
  }

  async listAccessibleCustomers() {
    this.listCalls.push('list');
    if (this.listError) throw new Error(this.listError);
    return [...this.accessible];
  }

  async readAccount(
    _accessToken: string,
    customerId: string,
    options?: { loginCustomerId?: string },
  ) {
    this.readCalls.push(customerId);
    this.loginCustomerIds.push(options?.loginCustomerId);
    if (this.readError) throw new Error(this.readError);
    const account = this.accounts.get(customerId);
    if (!account) throw new Error('HTTP 403');
    return { ...account };
  }

  async readCampaigns(
    _accessToken: string,
    customerId: string,
    options?: { loginCustomerId?: string },
  ) {
    this.campaignCalls.push(customerId);
    this.loginCustomerIds.push(options?.loginCustomerId);
    const failure = this.campaignError.get(customerId);
    if (failure) throw new Error(failure);
    return (this.campaigns.get(customerId) ?? []).map((campaign) => ({ ...campaign }));
  }

  async readCampaignDays(
    _accessToken: string,
    customerId: string,
    window: AdsSyncWindow,
    options?: { loginCustomerId?: string },
  ) {
    this.dayCalls.push({ customerId, window: { ...window } });
    this.loginCustomerIds.push(options?.loginCustomerId);
    const failure = this.dayError.get(customerId);
    if (failure) throw new Error(failure);
    return (this.days.get(customerId) ?? []).map((day) => ({ ...day }));
  }
}
