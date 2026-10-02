/**
 * What the app may ask Google Ads, read-only by construction: there is no method here that
 * creates, updates, or removes anything at the provider, and adding one means a new module beside
 * this file rather than a method on it.
 *
 * `readAccount` is the one call that names an account, and the service in `accounts.ts` calls it
 * only after a person approved that exact customer ID. Listing accounts names none.
 */
import type { AdsAccountSnapshot } from '../../shared/ads.ts';

export interface AdsProvider {
  /** Exchanges the stored refresh token for a short-lived access token. Never persisted. */
  accessToken(refreshToken: string): Promise<string>;
  /** Customer IDs the grant reaches directly. Not a manager hierarchy, and not read permission. */
  listAccessibleCustomers(accessToken: string): Promise<string[]>;
  /** Metadata for exactly one approved account. */
  readAccount(
    accessToken: string,
    customerId: string,
    options?: { loginCustomerId?: string },
  ): Promise<AdsAccountSnapshot>;
}
