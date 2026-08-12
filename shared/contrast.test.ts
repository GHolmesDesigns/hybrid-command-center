import { describe, expect, it } from 'vitest';
import {
  AA_TEXT_CONTRAST,
  contrastRatio,
  meetsAaText,
  mixHex,
  normalizeHex,
  relativeLuminance,
  softestReadable,
} from './contrast.ts';

describe('hex parsing', () => {
  it('accepts the shapes a colour input and a typed value produce', () => {
    expect(normalizeHex('#18201D')).toBe('#18201d');
    expect(normalizeHex('  #FFF  ')).toBe('#ffffff');
  });

  it('rejects anything that is not a hex colour', () => {
    for (const value of ['', '#12', '#1234', 'rebeccapurple', 'rgb(0,0,0)', '#gggggg'])
      expect(normalizeHex(value)).toBeNull();
  });
});

describe('contrast ratio', () => {
  // The two endpoints of the WCAG scale, which pin the formula in place.
  it('spans 1:1 for identical colours and 21:1 for black on white', () => {
    expect(contrastRatio('#4a7c59', '#4a7c59')).toBeCloseTo(1, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('does not depend on which colour is named first', () => {
    expect(contrastRatio('#d7c5a2', '#18201d')).toBeCloseTo(contrastRatio('#18201d', '#d7c5a2'), 9);
  });

  it('agrees with the published luminance of a mid grey', () => {
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2159, 3);
  });

  it('holds #767676 on white at the sRGB accessibility threshold', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(AA_TEXT_CONTRAST);
  });
});

describe('derived colours', () => {
  it('blends between two colours', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('clamps a blend outside 0–1 rather than producing an impossible channel', () => {
    expect(mixHex('#000000', '#ffffff', 4)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', -2)).toBe('#000000');
  });

  it('fades secondary text only as far as AA allows, on any legal pair', () => {
    // Every pair here already clears AA, which is the only state the sidebar can be saved
    // in. What matters is that the quieter colour derived from it still clears AA too.
    const pairs = [
      ['#ffffff', '#18201d'],
      ['#18201d', '#f4f3ef'],
      ['#767676', '#ffffff'],
      ['#ffffff', '#315f79'],
      ['#000000', '#ffffff'],
    ];
    for (const [foreground, background] of pairs) {
      const muted = softestReadable(foreground, background);
      expect(meetsAaText(muted, background)).toBe(true);
    }
  });

  it('gives a pair with no headroom no fade at all', () => {
    // #767676 on white sits within a hair of 4.5:1, so any wash toward white breaks it.
    expect(softestReadable('#767676', '#ffffff')).toBe('#767676');
    // A high-contrast pair has room to spare, so its secondary text is visibly quieter.
    expect(softestReadable('#ffffff', '#18201d')).not.toBe('#ffffff');
  });
});
