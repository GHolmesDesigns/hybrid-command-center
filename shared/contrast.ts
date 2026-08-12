/**
 * WCAG 2.1 contrast maths, shared by the server (which refuses branding it cannot read)
 * and the client (which explains the refusal before the request is made). Both sides run
 * the same function so a combination the form calls readable can never be one the API
 * rejects, and vice versa.
 */

/** Normal-size body text. Every sidebar string is small, so this is the bar used throughout. */
export const AA_TEXT_CONTRAST = 4.5;

const HEX = /^#[0-9a-f]{6}$/;

/** Lowercased `#rrggbb`, expanding `#rgb`, or `null` when the value is not a hex colour. */
export function normalizeHex(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const expanded = /^#[0-9a-f]{3}$/.test(trimmed)
    ? `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`
    : trimmed;
  return HEX.test(expanded) ? expanded : null;
}

type Rgb = [number, number, number];

/** Channel bytes of an already-normalized hex colour. */
function channels(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

/** WCAG relative luminance. Throws on anything `normalizeHex()` would have rejected. */
export function relativeLuminance(hex: string): number {
  const normalized = normalizeHex(hex);
  if (!normalized) throw new Error(`Expected a hex colour, received "${hex}"`);
  const [r, g, b] = channels(normalized).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** True when `foreground` on `background` is legible at normal text sizes. */
export const meetsAaText = (foreground: string, background: string) =>
  contrastRatio(foreground, background) >= AA_TEXT_CONTRAST;

/** Ratios are compared at one decimal place everywhere they are shown or asserted. */
export const roundRatio = (ratio: number) => Math.round(ratio * 10) / 10;

/** Linear channel blend: `amount` of 0 returns `from`, 1 returns `to`. */
export function mixHex(from: string, to: string, amount: number): string {
  const a = normalizeHex(from),
    b = normalizeHex(to);
  if (!a || !b) throw new Error(`Expected two hex colours, received "${from}" and "${to}"`);
  const [ar, ag, ab] = channels(a),
    [br, bg, bb] = channels(b);
  const t = Math.min(1, Math.max(0, amount));
  return toHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/**
 * A quieter version of `foreground` for secondary labels: the most washed-out blend
 * toward `background` that still clears AA, so visual hierarchy is bought out of whatever
 * contrast headroom the chosen pair actually has instead of being assumed. A pair sitting
 * exactly on 4.5:1 gets no fade at all rather than an unreadable one.
 */
export function softestReadable(foreground: string, background: string, limit = 0.4): string {
  for (let amount = Math.round(limit * 20) / 20; amount > 0; amount -= 0.05) {
    const candidate = mixHex(foreground, background, amount);
    if (meetsAaText(candidate, background)) return candidate;
  }
  return normalizeHex(foreground) ?? foreground;
}
