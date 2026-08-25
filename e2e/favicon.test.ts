import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Bundled tab icon (C98 / #297).
 *
 * Source assertions only: the production path is Vite copying `client/public/` into
 * `dist/client/`, which `npm run build` already exercises. A Settings logo URL must never appear
 * here — the favicon is a repository asset, not user content.
 */

const root = resolve(import.meta.dirname, '..');
const indexHtml = resolve(root, 'client/index.html');
const favicon = resolve(root, 'client/public/favicon.svg');

describe('bundled favicon', () => {
  it('declares the icon in client/index.html with the local SVG path and type', () => {
    const html = readFileSync(indexHtml, 'utf8');
    expect(html).toMatch(/<link\s+rel="icon"\s+href="\/favicon\.svg"\s+type="image\/svg\+xml"\s*\/>/);
    expect(html).not.toMatch(/https?:\/\/\S*favicon/i);
  });

  it('keeps the asset in client/public as a self-contained SVG', () => {
    expect(existsSync(favicon)).toBe(true);
    const svg = readFileSync(favicon, 'utf8');
    expect(svg).toMatch(/<svg[\s>]/);
    expect(svg).toContain('#18201d');
    expect(svg).toContain('#d7c5a2');
    // The SVG namespace is not a fetch. Refuse remote asset references and the Settings logo field.
    expect(svg).not.toMatch(/\b(href|xlink:href|src)=["']https?:\/\//i);
    expect(svg).not.toContain('logoUrl');
  });
});
