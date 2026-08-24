import { describe, expect, it } from 'vitest';
import { UnavailableBufferReadProvider } from './read-provider.ts';

describe('UnavailableBufferReadProvider', () => {
  it('refuses every read with the configured reason', async () => {
    const provider = new UnavailableBufferReadProvider('custom reason');
    expect(provider.available).toBe(false);
    await expect(provider.account()).rejects.toThrow('custom reason');
    await expect(provider.channels('org-1')).rejects.toThrow('custom reason');
    await expect(provider.listPosts('org-1', null)).rejects.toThrow('custom reason');
  });

  it('defaults the refusal message when none is given', async () => {
    const provider = new UnavailableBufferReadProvider();
    await expect(provider.account()).rejects.toThrow(/BUFFER_API_KEY/);
  });
});
