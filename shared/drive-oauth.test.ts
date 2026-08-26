import { describe, expect, it } from 'vitest';
import { DRIVE_OAUTH_SCOPE, isAllowedGoogleRedirectUri } from './drive-oauth.ts';

describe('Drive OAuth redirect URI', () => {
  it('accepts localhost and loopback http callbacks on the fixed path', () => {
    expect(isAllowedGoogleRedirectUri('http://localhost:8787/api/drive/oauth/callback')).toBe(true);
    expect(isAllowedGoogleRedirectUri('http://127.0.0.1:8787/api/drive/oauth/callback')).toBe(true);
  });

  it('accepts https production callbacks on the fixed path', () => {
    expect(isAllowedGoogleRedirectUri('https://command.example.com/api/drive/oauth/callback')).toBe(
      true,
    );
  });

  it('refuses open-redirect shapes', () => {
    expect(isAllowedGoogleRedirectUri('https://evil.example/api/drive/oauth/callback/../x')).toBe(
      false,
    );
    expect(
      isAllowedGoogleRedirectUri('http://localhost:8787/api/drive/oauth/callback?next=https://x'),
    ).toBe(false);
    expect(
      isAllowedGoogleRedirectUri('http://localhost:8787/api/drive/oauth/callback#fragment'),
    ).toBe(false);
    expect(isAllowedGoogleRedirectUri('http://example.com/api/drive/oauth/callback')).toBe(false);
    expect(isAllowedGoogleRedirectUri('https://example.com/elsewhere')).toBe(false);
    expect(isAllowedGoogleRedirectUri('not-a-url')).toBe(false);
    expect(
      isAllowedGoogleRedirectUri('http://user:pass@localhost:8787/api/drive/oauth/callback'),
    ).toBe(false);
    expect(isAllowedGoogleRedirectUri('ftp://localhost/api/drive/oauth/callback')).toBe(false);
  });

  it('names the drive.file scope', () => {
    expect(DRIVE_OAUTH_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });
});
