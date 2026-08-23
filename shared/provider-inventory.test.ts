import { describe, expect, it } from 'vitest';
import {
  PROVIDER_INVENTORY_CAPTION_MAX,
  PROVIDER_INVENTORY_PAGE_MAX,
  PROVIDER_INVENTORY_PAGE_SIZE,
  PROVIDER_INVENTORY_ROW_MAX,
  providerInventoryCaptionExcerpt,
  providerInventoryFingerprint,
  providerInventoryNextPage,
  providerInventoryOrphans,
  providerInventoryPostName,
  type ProviderInventoryPost,
} from './provider-inventory.ts';

/**
 * The inventory rules, against fixtures rather than a provider.
 *
 * Data in, data out: no database, no network, no clock. Which is the point of the module — the
 * pagination contract and the orphan rule decide whether a refresh replaces a whole generation, so
 * they are worth proving at the level where a case is three lines of literal.
 */

const post = (overrides: Partial<ProviderInventoryPost> = {}): ProviderInventoryPost => ({
  providerPostId: 'remote-1',
  state: 'SCHEDULED',
  scheduledInstant: '2026-08-20T13:00:00.000Z',
  captionExcerpt: 'A post somebody else scheduled',
  accountIds: [11],
  ...overrides,
});

describe('the bounds', () => {
  it('bounds a walk by pages and by rows, and derives one from the other', () => {
    expect(PROVIDER_INVENTORY_PAGE_SIZE).toBeGreaterThan(0);
    expect(PROVIDER_INVENTORY_PAGE_MAX).toBeGreaterThan(1);
    expect(PROVIDER_INVENTORY_ROW_MAX).toBe(
      PROVIDER_INVENTORY_PAGE_SIZE * PROVIDER_INVENTORY_PAGE_MAX,
    );
  });
});

describe('a caption excerpt', () => {
  it('collapses a multi-line caption to one line', () => {
    expect(providerInventoryCaptionExcerpt('  Two\n\nlines   here \t')).toBe('Two lines here');
  });

  it('never exceeds the bound, ellipsis included', () => {
    const excerpt = providerInventoryCaptionExcerpt('x'.repeat(PROVIDER_INVENTORY_CAPTION_MAX * 2));
    expect(excerpt).toHaveLength(PROVIDER_INVENTORY_CAPTION_MAX);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('leaves a caption exactly at the bound alone', () => {
    const exact = 'y'.repeat(PROVIDER_INVENTORY_CAPTION_MAX);
    expect(providerInventoryCaptionExcerpt(exact)).toBe(exact);
  });

  it('answers an empty caption with an empty excerpt rather than inventing words', () => {
    expect(providerInventoryCaptionExcerpt('   ')).toBe('');
  });
});

describe('the pagination contract', () => {
  it('treats null, absent, and false as the last page', () => {
    expect(providerInventoryNextPage({ next: null })).toEqual({ done: true });
    expect(providerInventoryNextPage({ total: 3, offset: 0, limit: 100 })).toEqual({ done: true });
    expect(providerInventoryNextPage({ next: false })).toEqual({ done: true });
  });

  it('follows a number, and an offset lifted out of a URL', () => {
    expect(providerInventoryNextPage({ next: 100 })).toEqual({ offset: 100 });
    expect(
      providerInventoryNextPage({ next: 'https://api.example/v1/posts?limit=100&offset=200' }),
    ).toEqual({ offset: 200 });
    expect(providerInventoryNextPage({ next: 'offset=300' })).toEqual({ offset: 300 });
  });

  it('refuses a string that carries no offset rather than guessing a cursor parameter', () => {
    expect(providerInventoryNextPage({ next: 'eyJvIjoxfQ' })).toEqual({ unknown: 'NEXT_STRING' });
  });

  it('refuses a shape nobody has verified, and a number that cannot be an offset', () => {
    expect(providerInventoryNextPage({ next: { cursor: 'x' } })).toEqual({ unknown: 'NEXT' });
    expect(providerInventoryNextPage({ next: -1 })).toEqual({ unknown: 'NEXT' });
    expect(providerInventoryNextPage({ next: 1.5 })).toEqual({ unknown: 'NEXT' });
  });

  it('refuses a response with no envelope, which has said nothing about completeness', () => {
    expect(providerInventoryNextPage(undefined)).toEqual({ unknown: 'META' });
    expect(providerInventoryNextPage('meta')).toEqual({ unknown: 'META' });
    expect(providerInventoryNextPage(null)).toEqual({ unknown: 'META' });
  });
});

describe('which listed posts are orphans', () => {
  it('keeps the ids no publication claims, by id and never by caption', () => {
    const posts = [
      post({ providerPostId: 'ours' }),
      post({ providerPostId: 'theirs', captionExcerpt: 'A post somebody else scheduled' }),
    ];
    expect(providerInventoryOrphans(posts, ['ours']).map((row) => row.providerPostId)).toEqual([
      'theirs',
    ]);
  });

  it('claims nothing when no publication has a provider id yet', () => {
    expect(providerInventoryOrphans([post()], [])).toHaveLength(1);
  });

  it('has nothing to say about an inventory nobody has read', () => {
    expect(providerInventoryOrphans([], ['ours'])).toEqual([]);
  });
});

describe('the fingerprint an acknowledgement is taken against', () => {
  it('covers every id together with its state, in a stable order', () => {
    const one = providerInventoryFingerprint([
      post({ providerPostId: 'b', state: 'SCHEDULED' }),
      post({ providerPostId: 'a', state: 'DRAFT' }),
    ]);
    const other = providerInventoryFingerprint([
      post({ providerPostId: 'a', state: 'DRAFT' }),
      post({ providerPostId: 'b', state: 'SCHEDULED' }),
    ]);
    expect(one).toBe(other);
    expect(one).toBe('post-bridge:a:DRAFT|post-bridge:b:SCHEDULED');
  });

  it('changes when an orphan is published, and when another one appears', () => {
    const base = providerInventoryFingerprint([post({ providerPostId: 'a' })]);
    expect(
      providerInventoryFingerprint([post({ providerPostId: 'a', state: 'PUBLISHED' })]),
    ).not.toBe(base);
    expect(
      providerInventoryFingerprint([post({ providerPostId: 'a' }), post({ providerPostId: 'b' })]),
    ).not.toBe(base);
  });
});

describe('naming a listed post', () => {
  it('uses the excerpt where there is one', () => {
    expect(providerInventoryPostName(post({ captionExcerpt: 'Launch week teaser' }))).toBe(
      'Launch week teaser',
    );
  });

  it('falls back to the state and the id for a post with no words at all', () => {
    expect(
      providerInventoryPostName(
        post({ captionExcerpt: '', state: 'DRAFT', providerPostId: 'remote-9' }),
      ),
    ).toBe('Held as a draft · remote-9');
  });
});
