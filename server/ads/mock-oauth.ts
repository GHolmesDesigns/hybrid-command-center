import { ADS_OAUTH_SCOPE } from '../../shared/ads.ts';
import type { AdsGrant, AdsOAuthClient } from './oauth.ts';

/**
 * The Ads authorization server every automated test connects against. It stands in for Google's
 * consent, token exchange, and account list, and remembers what it was sent so a test can assert
 * the exchange was bound to the request that started it rather than take the route's word.
 *
 * `consentUrl` lets the browser spec turn "Google's consent screen" into a redirect straight back
 * to the callback, so no live Google call exists anywhere in the flow.
 */
export class MockAdsOAuthClient implements AdsOAuthClient {
  authorizations: { state: string; challenge: string }[] = [];
  exchanges: { code: string; verifier: string }[] = [];
  listCalls: string[] = [];
  /** Thrown by `exchange` when set. */
  exchangeError?: string;
  /** Thrown by `listAccessibleCustomers` when set. */
  listError?: string;
  grant: AdsGrant = {
    accessToken: 'mock-ads-access-token',
    refreshToken: 'mock-ads-refresh-token',
    scope: ADS_OAUTH_SCOPE,
  };
  accessible: string[] = ['1234567890'];
  /** Where an authorization URL points; the default is a Google-shaped host that is never fetched. */
  consentUrl = (input: { state: string; challenge: string }) => {
    const query = new URLSearchParams({
      state: input.state,
      code_challenge: input.challenge,
      code_challenge_method: 'S256',
      scope: ADS_OAUTH_SCOPE,
    });
    return `https://accounts.test/ads-authorize?${query.toString()}`;
  };

  authorizationUrl(input: { state: string; challenge: string }) {
    this.authorizations.push(input);
    return this.consentUrl(input);
  }

  async exchange(input: { code: string; verifier: string }) {
    this.exchanges.push(input);
    if (this.exchangeError) throw new Error(this.exchangeError);
    return this.grant;
  }

  async listAccessibleCustomers(accessToken: string) {
    this.listCalls.push(accessToken);
    if (this.listError) throw new Error(this.listError);
    return this.accessible;
  }
}
