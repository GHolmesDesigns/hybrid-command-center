import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../shared/contrast';
import { tagAccent } from './components/ui-shared';

const css = readFileSync(resolve(process.cwd(), 'client/src/styles.css'), 'utf8');
const root = css.slice(css.indexOf(':root {'), css.indexOf('\n* {'));
const rules = css.slice(css.indexOf('\n* {'));
const definitions = new Map(
  [...root.matchAll(/^\s*(--(?:theme|state)-[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [
    name,
    value,
  ]),
);

describe('light-theme presentation tokens', () => {
  it('keeps every consumed presentation colour in the light inventory', () => {
    const used = [...rules.matchAll(/var\((--(?:theme|state)-[\w-]+)/g)].map(([, name]) => name);
    expect(used.length).toBeGreaterThan(200);
    for (const name of used) expect(definitions.has(name), name).toBe(true);
    expect(rules).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it('preserves the shared light surfaces, readable text, focus ring and warning wash', () => {
    expect(definitions.get('--theme-canvas')).toBe('#f4f3ef');
    expect(definitions.get('--theme-surface-panel')).toBe('#fff');
    expect(definitions.get('--theme-text-primary')).toBe('#202522');
    expect(definitions.get('--theme-text-muted')).toBe('#6e746f');
    expect(definitions.get('--theme-border-default')).toBe('#dedfd9');
    expect(definitions.get('--theme-focus-ring')).toBe('rgba(49, 95, 121, 0.25)');
    expect(definitions.get('--theme-warning-surface')).toBe('#fff3df');
    expect(contrastRatio('#202522', '#f4f3ef')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#8d601c', '#fff3df')).toBeGreaterThanOrEqual(4.5);
    expect(rules).toContain('outline: 3px solid var(--theme-focus-ring)');
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
