import { describe, expect, it } from 'vitest';
import {
  SIGNAL_CHANNEL_INITIAL,
  SIGNAL_CHANNEL_LABEL,
  SIGNAL_CHANNEL_NEUTRAL,
  SIGNAL_CHANNEL_TREATMENT,
  SIGNAL_CHANNELS,
  isSignalChannel,
  signalChannelPresentation,
  signalTextHasLink,
} from './signal.ts';
import { contrastRatio, meetsAaText, mixHex, normalizeHex } from './contrast.ts';

describe('Signal link detection', () => {
  it.each([
    ['a bare domain', 'Visit gholmesdesigns.com for the full story.'],
    ['a bare domain with a path', 'Read foo.io/path next.'],
    ['a www address', 'See www.example.com/campaign.'],
    ['an http URL', 'See http://example.test/campaign.'],
    ['an https URL', 'See https://example.test/campaign.'],
  ])('detects %s', (_case, text) => {
    expect(signalTextHasLink(text)).toBe(true);
  });

  it.each([
    ['e.g.', 'Use a familiar example, e.g. a client brief.'],
    ['i.e.', 'Keep the scope exact, i.e. warning only.'],
    ['3.5 percent', 'Engagement rose by 3.5 percent.'],
    ['a decimal number', 'The average is 12.75 today.'],
  ])('ignores %s', (_case, text) => {
    expect(signalTextHasLink(text)).toBe(false);
  });
});

/**
 * The chip treatments. Every number below is measured with `shared/contrast.ts` — the same
 * functions the branding form and the API refuse an unreadable palette with — rather than with a
 * second set of thresholds kept beside the colours they judge.
 */
describe('Signal channel treatments', () => {
  /** The two backgrounds a chip is ever laid on: a planner tile and the tile under the cursor. */
  const PAPER = { paper: '#ffffff', hover: '#f7f8f5' };
  /** The eight and the neutral, since an unrecognised value is held to the same bar as a known one. */
  const EVERY = [
    ...SIGNAL_CHANNELS.map((channel) => [channel, SIGNAL_CHANNEL_TREATMENT[channel]] as const),
    ['(neutral)', SIGNAL_CHANNEL_NEUTRAL] as const,
  ];

  it('gives every channel a surface, a border, and a text colour', () => {
    for (const [name, { surface, border, text }] of EVERY)
      for (const [token, value] of Object.entries({ surface, border, text }))
        expect([name, token, normalizeHex(value)]).toEqual([name, token, value]);
  });

  it('clears AA for small text on every fill', () => {
    for (const [name, { text, surface }] of EVERY)
      expect([name, meetsAaText(text, surface)]).toEqual([name, true]);
  });

  it('draws an outline that separates the chip from its fill and from the page', () => {
    // 3:1 is WCAG's bar for a boundary that is not text. The outline has two neighbours — the
    // fill it encloses and the paper it sits on — and it has to hold against both, or the chip
    // loses its edge on one side.
    for (const [name, { border, surface }] of EVERY)
      for (const [where, background] of Object.entries({ fill: surface, ...PAPER }))
        expect([name, where, contrastRatio(border, background) >= 3]).toEqual([name, where, true]);
  });

  it('derives the outline from the pair rather than choosing a third colour', () => {
    // One rule for all nine, so a channel added later cannot arrive with a hand-picked edge that
    // was never measured.
    for (const [name, { border, text, surface }] of EVERY)
      expect([name, border]).toEqual([name, mixHex(text, surface, 0.22)]);
  });

  it('keeps the eight apart from each other and the neutral apart from all of them', () => {
    const fills = EVERY.map(([, treatment]) => treatment.surface);
    expect(new Set(fills).size).toBe(EVERY.length);
    const inks = EVERY.map(([, treatment]) => treatment.text);
    expect(new Set(inks).size).toBe(EVERY.length);

    // The neutral is the only greyscale entry: no channel of it stands out, while every real
    // channel carries a hue. That is what makes an unrecognised value read as unrecognised.
    const spread = (hex: string) => {
      const bytes = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
      return Math.max(...bytes) - Math.min(...bytes);
    };
    expect(spread(SIGNAL_CHANNEL_NEUTRAL.text)).toBeLessThan(12);
    for (const channel of SIGNAL_CHANNELS)
      expect([channel, spread(SIGNAL_CHANNEL_TREATMENT[channel].text) > 12]).toEqual([
        channel,
        true,
      ]);
  });
});

describe('Signal channel presentation', () => {
  it('carries the label and the initial the maps already hold', () => {
    for (const channel of SIGNAL_CHANNELS)
      expect(signalChannelPresentation(channel)).toEqual({
        label: SIGNAL_CHANNEL_LABEL[channel],
        initial: SIGNAL_CHANNEL_INITIAL[channel],
        ...SIGNAL_CHANNEL_TREATMENT[channel],
      });
  });

  it('never repeats an initial, so the eight survive greyscale', () => {
    const initials = SIGNAL_CHANNELS.map((channel) => SIGNAL_CHANNEL_INITIAL[channel]);
    expect(new Set(initials).size).toBe(SIGNAL_CHANNELS.length);
    expect(initials.every((initial) => initial.length > 0)).toBe(true);
  });

  it('falls back to the neutral for a value that is not a channel', () => {
    // The value itself stays the label: a chip reading `mastodon` says what it is, where a bare
    // grey swatch would only say that something is wrong.
    expect(signalChannelPresentation('mastodon')).toEqual({
      label: 'mastodon',
      initial: 'MA',
      ...SIGNAL_CHANNEL_NEUTRAL,
    });
    expect(signalChannelPresentation('  ')).toEqual({
      label: 'Unknown channel',
      initial: 'UN',
      ...SIGNAL_CHANNEL_NEUTRAL,
    });
    expect(isSignalChannel('mastodon')).toBe(false);
    expect(SIGNAL_CHANNELS.every(isSignalChannel)).toBe(true);
  });
});
