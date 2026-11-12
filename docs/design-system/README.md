# G.Holmes Designs design system

The brand system for G.Holmes Designs: tokens, type, logos, the CMYK registration motif and 21 React components. It was built from the G.Holmes Designs brand guide (Edition 01, 2026) and mirrors the published design system on claude.ai.

This folder is reference material. Nothing in `client/`, `server/` or `shared/` imports it, and it does not change the app's own branding: the sidebar defaults still come from `shared/branding.ts`.

## In this folder

| Path | What |
| --- | --- |
| `tokens.json` | The source of truth: colors for the light and dark themes, type styles, spacing, radii and shadow, each with a usage note. |
| `tokens.css` | Those tokens as CSS custom properties, type-style classes and `@font-face` rules. Generated from `tokens.json`. |
| `fonts/` | Outfit, Work Sans and DM Mono as `.woff2` (Latin subset), with their SIL Open Font License notices. |
| `assets/logos/` | Primary and reverse logos, light and dark icons, as transparent PNGs. |
| `assets/motif/` | The registration circles, in register and misregistered, as SVG. |
| `components/` | `bundle.js` (React components on `window.GHolmes`), `bundle.css`, `index.d.ts` (props), and a `README.md` of usage rules plus a `preview.html` per component. |
| `gallery.html` | Every component rendered, with a light and dark toggle. Open it in a browser; it loads React 18.3.1 from jsDelivr. |

## Using it

Load the tokens, then the component stylesheet, then React 18 and the bundle, and set a theme on a root element:

```html
<html data-theme="light">
  <link rel="stylesheet" href="docs/design-system/tokens.css" />
  <link rel="stylesheet" href="docs/design-system/components/bundle.css" />
  <script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
  <script src="docs/design-system/components/bundle.js"></script>
</html>
```

`data-theme="dark"` works on the page or on any single section. Tokens and the `Logo` component follow the nearest theme.

The `components/<Name>/preview.html` files are written for the design-system viewer, which supplies the stylesheets and scripts. On their own they render blank, so use `gallery.html` to see the components.

To change the system, edit the published design system and re-export it here, so the two copies stay the same. `tokens.json` is the one to edit for any value.

---

G.Holmes Designs is a strategic graphic design studio that creates polished visual systems for small businesses, entrepreneurs and organizations. Everything built on this system serves one promise:

> Design that makes your business look established, not amateur.

Treat design as a business tool, never as decoration. When a choice is uncertain, take the more refined, structured, timeless and client-ready direction.

## Content fundamentals

**Audience.** Write for small business owners, entrepreneurs and local organizations who are practical, busy and reputation-conscious, and who don't have an in-house creative team.

**Voice.** Confident but not arrogant. Creative but disciplined. Professional but approachable. Lead with authority and keep hedging to a minimum. Never stack modals ("might potentially help").

**Person.** Address the reader as "you" and hold it for the whole piece. The studio is "we".

**Plain benefits.** Say what the customer gets in practical language. Keep copy easy to scan.

| Avoid | Use |
| --- | --- |
| We bring your vision to life | We help your business look credible from the first impression. |
| Stunning designs that wow | We turn scattered visuals into a professional, consistent brand presence. |
| Next-level branding | Design that makes your business look established, not amateur. |

**Names.** Write **G.Holmes Designs** with no space after the period. Use the four official service names everywhere, exactly: Brand Identity Systems, Event & Experiential Design, Editorial & Layout Design, Web & Digital Design.

**Casing.** Use title case for headlines, section titles and button labels ("Start a Project"). Use sentence case for body copy. DM Mono labels are always uppercase.

**Emoji.** Use none in captions or copy.

**Social.** End every G.Holmes Designs post with #ThinkVisually. Keep links clean, with no UTM or tracking parameters. Report with platform-native analytics only. On LinkedIn, excerpt articles and keep the full text on gholmesdesigns.com.

## Visual foundations

### Color

Apply color in this ratio: 60% `paper-white` and light space, 25% `near-black` and charcoal structure, 10% gray support tones, 5% CMYK accent.

- Set headlines in `ink` and body copy in `text`, on `surface` or `surface-muted`.
- Set labels and captions in `text-muted`.
- Use `process-cyan`, `process-magenta` and `process-yellow` with restraint, as lines, dividers, dots, icons, hover details and selective callouts. They are intentional, never decorative, and never compete in one frame.
- Reserve `action` for the one primary button in a view.
- Use cyan text on `paper-white` only for one highlighted headline word at `heading-1` or larger, or for decorative section numbers. Use yellow text only on `near-black` or `charcoal`.
- CMYK values are print-optimized approximations of the screen colors. Confirm against a press proof for production work.

### Dark mode

Use `near-black` or `charcoal` grounds with white type and restrained CMYK accents, and let the reverse logo carry the system. Apply `data-theme="dark"` to a page or to any single section; tokens and logos follow the nearest theme.

### Type

- **Outfit** for headlines: Bold 700, tight tracking, benefit-led and direct. Regular 400 only in `subhead`.
- **Work Sans** for body: Regular at 1.6 line height with a generous measure, roughly 60 to 75 characters. Bold and Italic are for emphasis.
- **DM Mono** for technical voice: section labels, spec callouts and numbers. Regular only, uppercase and widely spaced for labels.

Use one highlighted phrase per headline at most. Keep the type styles' print sizes for PDFs and proposals; `hero`, `body-lg` and `body` are the screen additions.

For PDFs that need brand typefaces, render HTML through Playwright/Chromium. Form fields built with ReportLab fall back to Helvetica.

### Layout

Keep composition clean, structured and high-contrast. Generous white space is the main signal of confidence. Page margins are `space-page` on letter documents and `space-4` on phones. Cards pad at `space-card` and sit `space-5` apart. Sections open with `SectionHeader`.

### Borders, radii and shadow

Use 1px `line` hairlines, not shadows, to separate content. Corners are small: `radius-md` for cards, panels, buttons and inputs, and `radius-lg` for icon tiles. The system is flat. Use `shadow-mockup` only under stationery and social mock-ups. Gradients are not part of the system.

### States

Primary and secondary buttons invert to `ink` on hover. Every interactive element takes a solid 2px `focus-ring`, offset 2px. Errors use a written message plus a heavier border, never color alone.

### Motion

Keep interface motion short and functional: color transitions of about 120ms. Nothing moves for decoration.

### Imagery

Imagery reinforces professional creative production. It is clean, structured, high-contrast and presentation-ready, with polished editorial composition, professional lighting and restrained CMYK accents.

**Use:** design studio environments and clean workstations; print, layout and production details; Pantone books, paper textures and print samples; portfolio work in realistic mock-ups; small business owners in polished environments.

**Avoid:** generic, cluttered or staged stock; oversaturated backgrounds; paint splatter; too many competing colors; overly corporate or impersonal imagery such as handshakes; busy compositions that weaken the logo; abstract blobs; excessive gradients; trendy 3D characters; cartoon mascots; neon palettes; fake or unreadable text; inaccurate logos; decoration with no strategic message.

**The TL;DR poster exception.** TL;DR poster graphics are deliberately bold comic-book pop art: heavy outlines, halftones, saturated color and dense composition. This intentional contrast with the clean line-art infographics is on brand. The restraint rules above don't apply to them.

## Logo and marks

The mark combines a lightbulb (ideas and strategy), a fountain-pen nib (craft and precision), a CMYK arc (print roots and systems discipline) and a horizontal wordmark.

- Use `Logo` or the files in Logos. Never redraw, recolor, stretch, rotate or add effects.
- Use the primary logo on `paper-white` or `light-neutral`, and the reverse logo only on black, charcoal or deep dark grounds.
- Keep clear space on all sides equal to the height of the bulb icon.
- Minimum width: 120px on screen, 1.5 in / 38 mm in print.
- Preserve the full horizontal composition for professional use. Use `IconMark` for favicons, profile images, watermarks and section markers.

## Graphic devices

- **Accent line** (`AccentLine`): the short C, M, Y, K line from the logo. Use it for section dividers, page breaks, portfolio category labels and web micro-details.
- **Dot accents** (`Dots`): the same four colors for lists and labels.
- **Registration circles** (`RegistrationMark`): three overlapping CMYK circles, used as the header mark on playbooks and a through-line inside deliverables. In misregistered form they are the conceptual basis for campaign imagery. They support the logo and never replace it on identity touchpoints.

## Iconography

The system has no icon font or set. Draw icons as clean vector SVG: flat or single-color, with strong simple geometry, rounded corners and a consistent stroke weight. Don't use emoji or glyphs as icons. Whiteboard and infographic illustrations are clean line art on bright white, with high contrast and minimal clutter.

## Deliverable formats

- **HTML playbooks** for anything multi-section: one self-contained file with `PlaybookNav` as a fixed sidebar with scroll-spy, `CopyBlock` on every post title and caption, brand typefaces, the CMYK palette and the registration mark as the visual system.
- **Blog posts** as markdown.
- **Video schema**: write `duration` in ISO 8601 period notation, such as `PT1M7S`.

## Components

React components on the `GHolmes` global, grouped as they appear in `gallery.html`. Each one's rules are in `components/<Name>/README.md` and its props in `components/index.d.ts`.

- **Brand:** `Logo`, `IconMark`, `AccentLine`, `Dots`, `RegistrationMark`
- **Text:** `Label`, `Highlight`, `SectionHeader`
- **Actions and forms:** `Button`, `Input`
- **Containers:** `Card`, `Callout`, `RuledList`, `DoDont`
- **Playbook:** `CopyBlock`, `PlaybookNav`
- **Application:** `Hero`, `BrandBand`, `BusinessCard`, `Letterhead`, `SocialCard`

`Input`, `CopyBlock` and `PlaybookNav` go beyond the brand guide's own inventory, for project inquiry forms and the studio's HTML playbook format.
