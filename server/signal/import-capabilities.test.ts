import { describe, expect, it } from 'vitest';
import { evaluateImportCapabilities } from './import-capabilities.ts';
import { urlPostMedia } from '../../shared/signal-media.ts';

const LONG_BLUESKY = 'x'.repeat(301);
const LONG_LINKEDIN = 'y'.repeat(3001);

describe('Signal import capability verdicts', () => {
  it('reports a hard Bluesky caption over-limit as durable and would-refuse, without blocking import shape', () => {
    const { summary, verdicts } = evaluateImportCapabilities(
      [
        {
          key: 'POST-BSKY',
          row: 2,
          text: LONG_BLUESKY,
          channels: ['bsky'],
          format: 'TEXT',
          media: [],
          variants: [],
        },
      ],
      [],
    );
    expect(summary.postsEvaluated).toBe(1);
    expect(summary.postsClean).toBe(0);
    expect(summary.postsWithWarnings).toBe(1);
    expect(summary.durableCount).toBeGreaterThanOrEqual(1);
    const caption = verdicts.find((v) => /limits captions to 300/.test(v.message));
    expect(caption).toMatchObject({
      durability: 'DURABLE',
      publishWouldRefuse: true,
      channel: 'bsky',
    });
    const account = verdicts.find((v) => /no connected account/.test(v.message));
    expect(account).toMatchObject({ durability: 'MOMENTARY', publishWouldRefuse: true });
  });

  it('warns on LinkedIn over-limit without treating it as a publish refusal', () => {
    const { verdicts } = evaluateImportCapabilities(
      [
        {
          key: 'POST-LI',
          row: 3,
          text: LONG_LINKEDIN,
          channels: ['li'],
          format: 'TEXT',
          media: [],
          variants: [],
        },
      ],
      [{ id: 1, platform: 'linkedin', handle: '@li', name: 'LinkedIn' }],
    );
    const caption = verdicts.find((v) => /limits captions to 3000/.test(v.message));
    expect(caption).toMatchObject({
      durability: 'DURABLE',
      publishWouldRefuse: false,
    });
    expect(verdicts.some((v) => /no connected account/.test(v.message))).toBe(false);
  });

  it('reports media required and absent, and media count outside the shape bounds', () => {
    const { verdicts: missing } = evaluateImportCapabilities(
      [
        {
          key: 'POST-IG',
          row: 4,
          text: 'Reel without media',
          channels: ['ig'],
          format: 'REEL',
          media: [],
          variants: [],
        },
      ],
      [{ id: 2, platform: 'instagram', handle: '@ig', name: 'Instagram' }],
    );
    expect(missing.some((v) => /requires exactly one video/.test(v.message))).toBe(true);

    const five = Array.from({ length: 5 }, (_, i) => ({
      url: `https://example.com/${i}.jpg`,
      media: urlPostMedia(`https://example.com/${i}.jpg`),
    }));
    const { verdicts: tooMany } = evaluateImportCapabilities(
      [
        {
          key: 'POST-X',
          row: 5,
          text: 'Too many images for X',
          channels: ['x'],
          format: 'IMAGE',
          media: five,
          variants: [],
        },
      ],
      [{ id: 3, platform: 'twitter', handle: '@x', name: 'X' }],
    );
    expect(tooMany.some((v) => /accepts at most 4 media/.test(v.message))).toBe(true);
  });

  it('marks blog as durable unreachable and a missing account as momentary', () => {
    const { summary, verdicts } = evaluateImportCapabilities(
      [
        {
          key: 'POST-BLOG',
          row: 6,
          text: 'Blog only',
          channels: ['blog'],
          format: 'BLOG_POST',
          media: [],
          variants: [],
        },
        {
          key: 'POST-TT',
          row: 7,
          text: 'TikTok needs an account',
          channels: ['tt'],
          format: 'VIDEO',
          media: [
            {
              url: 'https://example.com/clip.mp4',
              media: urlPostMedia('https://example.com/clip.mp4'),
            },
          ],
          variants: [],
        },
      ],
      [],
    );
    expect(summary.postsEvaluated).toBe(2);
    expect(summary.postsWithWarnings).toBe(2);
    expect(summary.postsClean).toBe(0);
    expect(verdicts.find((v) => v.channel === 'blog')).toMatchObject({
      durability: 'DURABLE',
      publishWouldRefuse: false,
      message: expect.stringMatching(/not available from this provider/),
    });
    expect(verdicts.find((v) => v.channel === 'tt' && v.durability === 'MOMENTARY')).toMatchObject({
      message: expect.stringMatching(/no connected account/),
      publishWouldRefuse: true,
    });
    expect(summary.durableCount + summary.momentaryCount).toBe(verdicts.length);
  });

  it('counts a clean channelled post when content and accounts are fine', () => {
    const { summary, verdicts } = evaluateImportCapabilities(
      [
        {
          key: 'POST-OK',
          row: 8,
          text: 'Short caption',
          channels: ['x'],
          format: 'TEXT',
          media: [],
          variants: [],
        },
        {
          key: 'POST-NONE',
          row: 9,
          text: 'No channels yet',
          channels: [],
          format: 'TEXT',
          media: [],
          variants: [],
        },
      ],
      [{ id: 4, platform: 'twitter', handle: '@x', name: 'X' }],
    );
    expect(summary.postsEvaluated).toBe(1);
    expect(summary.postsClean).toBe(1);
    expect(summary.postsWithWarnings).toBe(0);
    expect(verdicts).toEqual([]);
  });
});
