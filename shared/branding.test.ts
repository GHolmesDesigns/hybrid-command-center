import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BRANDING,
  brandingContrastReadings,
  brandingIssues,
  clientBrandingIssues,
  resolveClientBranding,
  sidebarPalette,
  type Branding,
} from './branding.ts';
import { AA_TEXT_CONTRAST, contrastRatio, meetsAaText } from './contrast.ts';

const brand = (overrides: Partial<Branding> = {}): Branding => ({
  ...DEFAULT_BRANDING,
  ...overrides,
});

describe('branding validation', () => {
  it('accepts the shipped defaults', () => {
    expect(brandingIssues(DEFAULT_BRANDING)).toEqual([]);
    expect(brandingContrastReadings(DEFAULT_BRANDING).every((r) => r.passes)).toBe(true);
  });

  it('refuses text that cannot be read on its own background', () => {
    const issues = brandingIssues(brand({ background: '#18201d', foreground: '#2a3330' }));
    expect(issues.map((issue) => issue.field)).toEqual(['foreground']);
    expect(issues[0].message).toContain(`${AA_TEXT_CONTRAST}:1`);
  });

  it('refuses an accent that fails against the background it is drawn on', () => {
    // The accent paints the version number, which is text, so it is held to the text bar.
    expect(brandingIssues(brand({ accent: '#2b3a34' })).map((i) => i.field)).toEqual(['accent']);
  });

  it('reports every failing pair at once rather than stopping at the first', () => {
    const issues = brandingIssues(
      brand({ background: '#ffffff', foreground: '#f2f2f2', accent: '#fafafa' }),
    );
    expect(issues.map((issue) => issue.field)).toEqual(['foreground', 'accent']);
  });

  it('refuses a colour that is not a hex value, without also guessing at its contrast', () => {
    const issues = brandingIssues(brand({ accent: 'goldenrod' }));
    expect(issues).toEqual([
      { field: 'accent', message: 'Expected a hex colour such as #18201d, received "goldenrod"' },
    ]);
  });

  it('requires alt text for a logo, and an address that can actually load', () => {
    expect(brandingIssues(brand({ logoUrl: 'https://cdn.example/logo.svg' }))).toEqual([
      { field: 'logoAlt', message: 'Describe the logo so it has alt text.' },
    ]);
    expect(
      brandingIssues(brand({ logoUrl: 'http://cdn.example/logo.svg', logoAlt: 'Studio logo' })),
    ).toEqual([{ field: 'logoUrl', message: 'A logo address must start with https://' }]);
    expect(
      brandingIssues(brand({ logoUrl: 'https://cdn.example/logo.svg', logoAlt: 'Studio logo' })),
    ).toEqual([]);
  });

  it('asks for no alt text when there is no logo to describe', () => {
    expect(brandingIssues(brand({ logoUrl: '', logoAlt: '' }))).toEqual([]);
  });
});

describe('client branding validation', () => {
  it('accepts a readable two-colour HTTPS client palette', () => {
    expect(
      clientBrandingIssues({
        logoUrl: 'https://cdn.example/logo.svg',
        colorOne: '#18201d',
        colorTwo: '#ffffff',
      }),
    ).toEqual([]);
  });

  it('refuses non-HTTPS logos and unreadable palettes', () => {
    expect(
      clientBrandingIssues({
        logoUrl: 'http://cdn.example/logo.svg',
        colorOne: '#ffffff',
        colorTwo: '#eeeeee',
      }),
    ).toEqual([
      { field: 'colorTwo', message: expect.stringContaining('WCAG AA') },
      { field: 'logoUrl', message: 'A logo address must start with https://' },
    ]);
  });

  it('refuses an incomplete client palette', () => {
    expect(clientBrandingIssues({ logoUrl: '', colorOne: '#18201d', colorTwo: '' })).toEqual([
      {
        field: 'colorTwo',
        message: 'Expected a hex colour such as #ffffff, received ""',
      },
    ]);
    expect(clientBrandingIssues({ logoUrl: '', colorOne: '', colorTwo: '#ffffff' })).toEqual([
      {
        field: 'colorOne',
        message: 'Expected a hex colour such as #18201d, received ""',
      },
    ]);
  });

  it('uses global branding when a client has no palette', () => {
    expect(resolveClientBranding()).toEqual(DEFAULT_BRANDING);
    expect(resolveClientBranding({ logoUrl: '', colorOne: '', colorTwo: '' })).toEqual(
      DEFAULT_BRANDING,
    );
  });

  it('maps a valid client palette onto the shared branding shape', () => {
    expect(
      resolveClientBranding({
        logoUrl: 'https://cdn.example/logo.svg',
        colorOne: '#FFFFFF',
        colorTwo: '#18201D',
      }),
    ).toMatchObject({
      background: '#ffffff',
      foreground: '#18201d',
      logoUrl: 'https://cdn.example/logo.svg',
    });
  });
});

describe('sidebar palette', () => {
  /** Colours a user might plausibly pick, all of which pass validation. */
  const allowed = [
    DEFAULT_BRANDING,
    brand({ background: '#ffffff', foreground: '#202522', accent: '#315f79' }),
    brand({ background: '#f4f3ef', foreground: '#000000', accent: '#8e322c' }),
    brand({ background: '#2b0f3a', foreground: '#ffe9ff', accent: '#f0c419' }),
  ];

  it('leaves nothing unreadable on any branding the API would store', () => {
    for (const branding of allowed) {
      expect(brandingIssues(branding)).toEqual([]);
      const palette = sidebarPalette(branding);
      const background = palette['--sidebar-bg'];
      // Body text, secondary labels, and the mark's own lettering.
      expect(meetsAaText(palette['--sidebar-fg'], background)).toBe(true);
      expect(meetsAaText(palette['--sidebar-muted'], background)).toBe(true);
      expect(meetsAaText(palette['--sidebar-mark-ink'], palette['--sidebar-accent'])).toBe(true);
      // Nav labels keep their contrast on the hover and active fill, not only on the plain
      // background, and the focus ring clears the 3:1 that non-text UI is held to.
      expect(meetsAaText(palette['--sidebar-fg'], palette['--sidebar-surface'])).toBe(true);
      expect(contrastRatio(palette['--sidebar-focus'], background)).toBeGreaterThanOrEqual(3);
    }
  });

  it('falls back to a readable default rather than emitting a colour it cannot parse', () => {
    expect(sidebarPalette(brand({ accent: 'not-a-colour' }))['--sidebar-accent']).toBe(
      DEFAULT_BRANDING.accent,
    );
  });
});
