/**
 * What the app may ask Google Ads, read-only by construction: there is no method here that
 * creates, updates, or removes anything at the provider, and adding one means a new module beside
 * this file rather than a method on it.
 *
 * `readAccount`, `readCampaigns`, and `readCampaignDays` name an account, and the services call
 * them only for an ID a person approved. Listing accounts names none.
 */
import type {
  AdsAccountSnapshot,
  AdsCampaignDay,
  AdsCampaignSnapshot,
  AdsSyncWindow,
} from '../../shared/ads.ts';

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
  /** Every campaign the account lists, with no metrics: one with no activity still appears. */
  readCampaigns(
    accessToken: string,
    customerId: string,
    options?: { loginCustomerId?: string },
  ): Promise<AdsCampaignSnapshot[]>;
  /**
   * Daily figures for one account over a finite range. A date with no reported row is absent.
   * An implementation throws rather than return a stream it could not read to the end.
   */
  readCampaignDays(
    accessToken: string,
    customerId: string,
    window: AdsSyncWindow,
    options?: { loginCustomerId?: string },
  ): Promise<AdsCampaignDay[]>;
}
