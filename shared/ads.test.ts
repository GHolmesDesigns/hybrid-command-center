import { describe, expect, it } from 'vitest';
import {
  ADS_CAMPAIGN_NAME_MAX,
  adsAccountLocalSettingsSchema,
  adsAccountSnapshotSchema,
  adsCampaignDaySchema,
  adsCampaignSnapshotSchema,
  isAllowedAdsRedirectUri,
} from './ads.ts';
import { isAllowedGoogleRedirectUri } from './drive-oauth.ts';

describe('Ads redirect URI', () => {
  it('accepts only its own callback path, so a Drive callback cannot stand in for it', () => {
    expect(isAllowedAdsRedirectUri('http://localhost:8787/api/ads/oauth/callback')).toBe(true);
    expect(isAllowedAdsRedirectUri('https://hcc.example.com/api/ads/oauth/callback')).toBe(true);
    expect(isAllowedAdsRedirectUri('http://localhost:8787/api/drive/oauth/callback')).toBe(false);
    expect(isAllowedGoogleRedirectUri('http://localhost:8787/api/ads/oauth/callback')).toBe(false);
  });

  it.each([
    'http://example.com/api/ads/oauth/callback',
    'https://hcc.example.com/api/ads/oauth/callback?next=/x',
    'https://hcc.example.com/api/ads/oauth/callback#frag',
    'https://user:pw@hcc.example.com/api/ads/oauth/callback',
  ])('refuses %s', (value) => {
    expect(isAllowedAdsRedirectUri(value)).toBe(false);
  });
});

describe('Ads input schemas', () => {
  const day = {
    customerId: '123-456-7890',
    campaignId: '987654321',
    date: '2026-09-30',
    impressions: 10,
    clicks: 2,
    costMicros: 1_500_000,
    conversions: 0.5,
  };

  it('keeps fractional conversions, provider micros, and a dash-free customer ID', () => {
    expect(adsCampaignDaySchema.parse(day)).toEqual({ ...day, customerId: '1234567890' });
  });

  it('refuses a day that does not exist and a negative or fractional count', () => {
    expect(adsCampaignDaySchema.safeParse({ ...day, date: '2026-02-30' }).success).toBe(false);
    expect(adsCampaignDaySchema.safeParse({ ...day, clicks: -1 }).success).toBe(false);
    expect(adsCampaignDaySchema.safeParse({ ...day, impressions: 1.5 }).success).toBe(false);
  });

  it('keeps only a bounded excerpt of a campaign name', () => {
    const parsed = adsCampaignSnapshotSchema.parse({
      customerId: '1234567890',
      campaignId: '1',
      name: 'x'.repeat(ADS_CAMPAIGN_NAME_MAX * 3),
      status: 'ENABLED',
      channelType: 'SEARCH',
    });
    expect(parsed.name).toHaveLength(ADS_CAMPAIGN_NAME_MAX);
    expect(parsed.name.endsWith('…')).toBe(true);
  });

  it('accepts a channel type Google adds later but not free text', () => {
    const base = { customerId: '1234567890', campaignId: '1', name: 'n', status: 'PAUSED' };
    expect(adsCampaignSnapshotSchema.safeParse({ ...base, channelType: 'NEW_KIND' }).success).toBe(
      true,
    );
    expect(
      adsCampaignSnapshotSchema.safeParse({ ...base, channelType: 'Search ads' }).success,
    ).toBe(false);
  });

  it('refuses an account whose currency or customer ID is malformed', () => {
    const account = {
      customerId: '1234567890',
      descriptiveName: 'Agency',
      currencyCode: 'USD',
      timeZone: 'America/New_York',
      manager: false,
      status: 'ENABLED',
    };
    expect(adsAccountSnapshotSchema.safeParse(account).success).toBe(true);
    expect(adsAccountSnapshotSchema.safeParse({ ...account, currencyCode: 'usd' }).success).toBe(
      false,
    );
    expect(adsAccountSnapshotSchema.safeParse({ ...account, customerId: '12' }).success).toBe(
      false,
    );
  });

  it('models Unassigned as a null client, not a missing one', () => {
    expect(
      adsAccountLocalSettingsSchema.parse({
        customerId: '1234567890',
        approved: false,
        clientId: null,
      }),
    ).toEqual({ customerId: '1234567890', approved: false, clientId: null });
    expect(
      adsAccountLocalSettingsSchema.safeParse({ customerId: '1234567890', approved: true }).success,
    ).toBe(false);
  });
});
