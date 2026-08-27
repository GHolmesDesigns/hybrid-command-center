/** Default sidebar branding. Override at runtime via Settings, or edit these defaults in code. */
import {
  AA_TEXT_CONTRAST,
  contrastRatio,
  mixHex,
  normalizeHex,
  roundRatio,
  softestReadable,
} from './contrast.ts';

export const APP_VERSION = '5.4.2';

export interface Branding {
  mark: string;
  title: string;
  subtitle: string;
  tagline: string;
  /** Sidebar surface colour, as `#rrggbb`. */
  background: string;
  /** Sidebar text colour, as `#rrggbb`. */
  foreground: string;
  /** Mark tile, active-page marker, and version number, as `#rrggbb`. */
  accent: string;
  /** `https://` image used in place of the text mark, or `''` for no logo. */
  logoUrl: string;
  /** Required whenever `logoUrl` is set; ignored and stored empty when it is not. */
  logoAlt: string;
}

export const DEFAULT_BRANDING: Branding = {
  mark: 'HC',
  title: 'Hybrid',
  subtitle: 'Command Center',
  tagline: 'Private to this device',
  background: '#18201d',
  foreground: '#ffffff',
  accent: '#d7c5a2',
  logoUrl: '',
  logoAlt: '',
};

export const BRANDING_SETTING_KEY = 'branding';

/** Only `https:` logos are accepted; see the storage decision in `README.md`. */
export const LOGO_URL_PATTERN = /^https:\/\/\S+$/;
export const LOGO_URL_MAX = 500;

export const BRANDING_COLOR_FIELDS = ['background', 'foreground', 'accent'] as const;
export type BrandingColorField = (typeof BRANDING_COLOR_FIELDS)[number];

export type BrandingIssue = { field: keyof Branding; message: string };

/**
 * The colour pairs that have to stay legible, and why each one is text rather than
 * decoration. Both are held to the normal-text bar because every string they colour is
 * small: the nav labels, and the version number the accent paints in the sidebar foot.
 */
const CONTRAST_RULES: {
  field: BrandingColorField;
  against: BrandingColorField;
  label: string;
}[] = [
  { field: 'foreground', against: 'background', label: 'Sidebar text on the sidebar background' },
  { field: 'accent', against: 'background', label: 'Accent on the sidebar background' },
];

/** Live contrast readings for the Settings form, in the order the rules are listed. */
export function brandingContrastReadings(branding: Branding) {
  return CONTRAST_RULES.map((rule) => {
    const foreground = normalizeHex(branding[rule.field]),
      background = normalizeHex(branding[rule.against]);
    const ratio = foreground && background ? roundRatio(contrastRatio(foreground, background)) : 0;
    return { ...rule, ratio, passes: ratio >= AA_TEXT_CONTRAST };
  });
}

/**
 * Every reason this branding would be refused, shared by the API's validator and the form
 * that would otherwise let a user submit an unreadable sidebar. An empty array means the
 * values are safe to store.
 */
export function brandingIssues(branding: Branding): BrandingIssue[] {
  const issues: BrandingIssue[] = [];
  for (const field of BRANDING_COLOR_FIELDS)
    if (!normalizeHex(branding[field]))
      issues.push({
        field,
        message: `Expected a hex colour such as #18201d, received "${branding[field]}"`,
      });
  if (issues.length) return issues;
  for (const reading of brandingContrastReadings(branding))
    if (!reading.passes)
      issues.push({
        field: reading.field,
        message: `${reading.label} is ${reading.ratio}:1. WCAG AA needs ${AA_TEXT_CONTRAST}:1.`,
      });
  if (branding.logoUrl && !LOGO_URL_PATTERN.test(branding.logoUrl))
    issues.push({ field: 'logoUrl', message: 'A logo address must start with https://' });
  if (branding.logoUrl && !branding.logoAlt.trim())
    issues.push({ field: 'logoAlt', message: 'Describe the logo so it has alt text.' });
  return issues;
}

/**
 * The CSS custom properties the sidebar is painted with. Only three colours are chosen;
 * the rest are derived so no combination of user choices can produce unreadable secondary
 * text, an invisible focus ring, or a mark nobody can read:
 *
 * - `mark-ink` is the background colour itself, which `brandingIssues()` has already held
 *   to 4.5:1 against the accent it sits on.
 * - `muted` is the faintest blend toward the background that still clears AA.
 * - `focus` is the full-strength foreground, so the ring clears AA on every allowed
 *   background and comfortably clears the 3:1 that non-text UI needs.
 *
 * Hover fills and hairlines are the only genuinely decorative values here, and they stay
 * near the background so text keeps the contrast it was validated with.
 */
export function sidebarPalette(branding: Branding): Record<string, string> {
  const background = normalizeHex(branding.background) ?? DEFAULT_BRANDING.background,
    foreground = normalizeHex(branding.foreground) ?? DEFAULT_BRANDING.foreground,
    accent = normalizeHex(branding.accent) ?? DEFAULT_BRANDING.accent;
  return {
    '--sidebar-bg': background,
    '--sidebar-fg': foreground,
    '--sidebar-accent': accent,
    '--sidebar-mark-ink': background,
    '--sidebar-muted': softestReadable(foreground, background),
    '--sidebar-surface': mixHex(background, foreground, 0.1),
    '--sidebar-line': mixHex(background, foreground, 0.22),
    '--sidebar-focus': foreground,
  };
}
