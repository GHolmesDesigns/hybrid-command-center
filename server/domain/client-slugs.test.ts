import { describe, expect, it } from 'vitest';
import { buildClientSlug, slugify } from './client-slugs.ts';

/**
 * `clients.slug` is UNIQUE and is what Drive folder naming reads, so what these two
 * functions do to a name is a stored consequence, not a display detail. `app.test.ts`
 * checks when a slug is regenerated; this checks what it is made of.
 */

describe('slugify', () => {
  it('lowercases and joins words with a hyphen', () => {
    expect(slugify('Acme Studio')).toBe('acme-studio');
  });

  it('collapses any run of separators into a single hyphen', () => {
    expect(slugify('Acme   ---   Studio')).toBe('acme-studio');
    expect(slugify('Acme & Co')).toBe('acme-co');
  });

  it('drops leading and trailing separators rather than leaving bare hyphens', () => {
    expect(slugify('  Acme Studio  ')).toBe('acme-studio');
    expect(slugify('...Acme Studio!')).toBe('acme-studio');
  });

  it('keeps digits, which carry meaning in a studio name', () => {
    expect(slugify('Studio 54')).toBe('studio-54');
  });

  it('replaces characters outside a–z0–9, accented letters included', () => {
    // Not transliteration: 'é' is a separator here, so 'Café' becomes 'caf'. Worth knowing
    // before a client is named in a language this reduces to very little.
    expect(slugify('Café Noir')).toBe('caf-noir');
    expect(slugify('東京 Design')).toBe('design');
  });

  it('returns an empty string when a name has nothing to keep', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('   ')).toBe('');
  });
});

describe('buildClientSlug', () => {
  it('appends the first six characters of the client id', () => {
    expect(buildClientSlug('Acme Studio', 'a1b2c3d4-5e6f-7890-abcd-ef0123456789')).toBe(
      'acme-studio-a1b2c3',
    );
  });

  it('separates two clients that share a name', () => {
    const first = buildClientSlug('Acme Studio', 'aaaaaa11-0000-0000-0000-000000000000');
    const second = buildClientSlug('Acme Studio', 'bbbbbb22-0000-0000-0000-000000000000');
    expect(first).not.toBe(second);
    expect([first, second]).toEqual(['acme-studio-aaaaaa', 'acme-studio-bbbbbb']);
  });

  it('still produces an identifying value when the name slugifies to nothing', () => {
    // The row would otherwise be storable but nameless; the id half keeps it unique.
    expect(buildClientSlug('!!!', 'abcdef01-0000-0000-0000-000000000000')).toBe('-abcdef');
  });

  it('uses a short id whole rather than padding it', () => {
    expect(buildClientSlug('Acme Studio', 'ab')).toBe('acme-studio-ab');
  });
});
