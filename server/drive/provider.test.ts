import { describe, expect, it } from 'vitest';
import { DisconnectedDriveProvider } from './provider.ts';

describe('DisconnectedDriveProvider', () => {
  const provider = new DisconnectedDriveProvider();

  it('is not connected', () => {
    expect(provider.connected).toBe(false);
  });

  it('refuses every method rather than answering with an empty shape', async () => {
    await expect(provider.ensureFolder()).rejects.toThrow(
      'Google Drive is not connected. Complete setup in Settings.',
    );
    await expect(provider.getFolder()).rejects.toThrow('Google Drive is not connected.');
    await expect(provider.listFiles()).rejects.toThrow('Google Drive is not connected.');
  });
});
