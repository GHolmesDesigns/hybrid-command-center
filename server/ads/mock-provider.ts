import type { AdsAccountSnapshot } from '../../shared/ads.ts';
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
  /** Customer IDs the grant reaches directly. */
  accessible: string[] = ['1234567890'];
  /** Provider metadata by customer ID; an ID with no entry is one the provider cannot read. */
  accounts = new Map<string, AdsAccountSnapshot>();
  accessTokenError?: string;
  listError?: string;
  readError?: string;

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

  async readAccount(_accessToken: string, customerId: string) {
    this.readCalls.push(customerId);
    if (this.readError) throw new Error(this.readError);
    const account = this.accounts.get(customerId);
    if (!account) throw new Error('HTTP 403');
    return { ...account };
  }
}
