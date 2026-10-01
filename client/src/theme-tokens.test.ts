import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../shared/contrast';
import { tagAccent } from './components/ui-shared';

const css = readFileSync(resolve(process.cwd(), 'client/src/styles.css'), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf(":root[data-theme='dark'] {"));
const darkTheme = css.slice(css.indexOf(":root[data-theme='dark'] {"), css.indexOf('\n* {'));
const rules = css.slice(css.indexOf('\n* {'));
const lightDefinitions = new Map(
  [...root.matchAll(/^\s*(--(?:theme|state)-[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [
    name,
    value,
  ]),
);
const darkDefinitions = new Map(
  [...darkTheme.matchAll(/^\s*(--(?:theme|state)-[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [
    name,
    value,
  ]),
);

describe('presentation theme tokens', () => {
  it('keeps every consumed presentation colour in the light inventory', () => {
    const used = [...rules.matchAll(/var\((--(?:theme|state)-[\w-]+)/g)].map(([, name]) => name);
    expect(used.length).toBeGreaterThan(200);
    for (const name of used) expect(lightDefinitions.has(name), name).toBe(true);
    expect(rules).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it('preserves the shared light surfaces, readable text, focus ring and warning wash', () => {
    expect(lightDefinitions.get('--theme-canvas')).toBe('#f4f3ef');
    expect(lightDefinitions.get('--theme-surface-panel')).toBe('#fff');
    expect(lightDefinitions.get('--theme-text-primary')).toBe('#202522');
    expect(lightDefinitions.get('--theme-text-muted')).toBe('#6e746f');
    expect(lightDefinitions.get('--theme-border-default')).toBe('#dedfd9');
    expect(lightDefinitions.get('--theme-focus-ring')).toBe('rgba(49, 95, 121, 0.25)');
    expect(lightDefinitions.get('--theme-warning-surface')).toBe('#fff3df');
    expect(contrastRatio('#202522', '#f4f3ef')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#8d601c', '#fff3df')).toBeGreaterThanOrEqual(4.5);
    expect(rules).toContain('outline: 3px solid var(--theme-focus-ring)');
  });

  it('defines every semantic token in dark mode and preserves AA text pairs', () => {
    expect(darkTheme).toContain('color-scheme: dark');
    for (const name of lightDefinitions.keys()) expect(darkDefinitions.has(name), name).toBe(true);

    const pairs: Array<[string, string]> = [
      ['--theme-text-primary', '--theme-canvas'],
      ['--theme-text-primary', '--theme-surface-panel'],
      ['--theme-text-muted', '--theme-canvas'],
      ['--theme-text-muted', '--theme-surface-panel'],
      ['--theme-accent-link', '--theme-surface-panel'],
      ['--theme-chip-ink', '--theme-surface-panel'],
      ['--theme-chip-muted-ink', '--theme-neutral-badge-surface'],
      ['--theme-danger-ink', '--theme-danger-surface'],
      ['--theme-error-ink', '--theme-error-surface'],
      ['--theme-warning-ink', '--theme-warning-surface'],
      ['--theme-warning-ink', '--theme-thought-surface'],
      ['--theme-thought-ink', '--theme-thought-surface'],
      ['--theme-success-ink', '--theme-success-surface'],
      ['--theme-attention-ink', '--theme-attention-surface'],
      ['--theme-partial-ink', '--theme-partial-badge'],
      ['--theme-info-ink', '--theme-info-surface'],
      ['--state-priority-high-ink', '--state-priority-high-surface'],
      ['--state-channel-neutral-ink', '--state-channel-neutral-surface'],
      ['--state-watch-ink', '--state-watch-surface'],
      ['--state-delivered-ink', '--state-delivered-surface'],
      ['--state-operator-avatar-ink', '--state-operator-avatar-surface'],
      ['--state-available-avatar-ink', '--state-available-avatar-surface'],
      ['--state-busy-avatar-ink', '--state-busy-avatar-surface'],
      ['--state-away-avatar-ink', '--state-away-avatar-surface'],
      ['--state-unknown-avatar-ink', '--state-unknown-avatar-surface'],
    ];
    for (const [ink, surface] of pairs) {
      const inkValue = darkDefinitions.get(ink);
      const surfaceValue = darkDefinitions.get(surface);
      expect(inkValue, ink).toMatch(/^#[\da-f]{3,8}$/i);
      expect(surfaceValue, surface).toMatch(/^#[\da-f]{3,8}$/i);
      expect(
        contrastRatio(inkValue!, surfaceValue!),
        `${ink} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(darkTheme).toContain('--theme-canvas: #151a18');
    expect(darkDefinitions.get('--theme-kanban-column')).toBe('#252d29');
    expect(darkDefinitions.get('--theme-row-subtle')).toBe('#1d2421');
    expect(rules).toContain(":root[data-theme='dark'] .tag-chip");
    expect(readFileSync(resolve(process.cwd(), 'client/index.html'), 'utf8')).toContain(
      '<script src="/theme-bootstrap.js"></script>',
    );
  });

  it('keeps runtime branding and contrast-measured status palettes independent', () => {
    expect(root).toContain('--sidebar-bg: #18201d');
    expect(root).toContain('--sidebar-focus: #ffffff');
    expect(rules).toContain('background: var(--status-wash)');
    expect(rules).toContain(
      'background: var(--channel-surface, var(--state-channel-neutral-surface))',
    );
    expect(rules).toContain('color: var(--status-ink)');
    expect(rules).toContain('color: var(--theme-chip-ink)');
    expect(contrastRatio('#3f4a46', '#fff')).toBeGreaterThanOrEqual(4.5);
    // Tags and categories share a decorative dot. Their text uses the readable chip ink.
    expect(tagAccent({ name: 'Campaign', color: '#123456' })).toBe('#123456');
    expect(tagAccent({ name: 'Campaign' })).toBe(tagAccent({ name: 'campaign' }));
  });
});
