import { describe, expect, it } from 'vitest';
import {
  samePlatformDuplicateGroups,
  samePlatformPolicyRefusal,
  type SamePlatformEntry,
} from './publish-same-platform.ts';

/**
 * The same-platform rule as fixtures, which is what C77's acceptance criterion asks for.
 *
 * The rule exists because C73 recorded question 1 as *verified with policy constraint*: the API
 * accepted identical-platform content without complaint, and the vendor's support material
 * restricts it anyway. Every case here is therefore about this app refusing something the provider
 * would happily have taken.
 */

const entry = (
  accountId: number,
  handle: string,
  caption: string,
  mediaUrls: string[] = [],
): SamePlatformEntry => ({ accountId, handle, caption, mediaUrls });

const A = 'https://example.com/a.png';
const B = 'https://example.com/b.png';

describe('which accounts were given the same thing', () => {
  it('finds nothing when every account has its own caption', () => {
    expect(
      samePlatformDuplicateGroups([
        entry(1, 'one', 'A word for this page'),
        entry(2, 'two', 'Something else entirely'),
      ]),
    ).toEqual([]);
  });

  it('groups two accounts given the same caption and media', () => {
    const groups = samePlatformDuplicateGroups([
      entry(1, 'one', 'Same words', [A]),
      entry(2, 'two', 'Same words', [A]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((item) => item.accountId)).toEqual([1, 2]);
  });

  it('treats surrounding whitespace as the same caption, because a reader would', () => {
    expect(
      samePlatformDuplicateGroups([entry(1, 'one', 'Same words'), entry(2, 'two', ' Same words ')]),
    ).toHaveLength(1);
  });

  it('separates accounts whose media differs even where the caption matches', () => {
    expect(
      samePlatformDuplicateGroups([
        entry(1, 'one', 'Same words', [A]),
        entry(2, 'two', 'Same words', [B]),
      ]),
    ).toEqual([]);
  });

  it('keeps media order significant: a different order is a different post', () => {
    expect(
      samePlatformDuplicateGroups([
        entry(1, 'one', 'Same words', [A, B]),
        entry(2, 'two', 'Same words', [B, A]),
      ]),
    ).toEqual([]);
  });

  it('reports the larger collision first when three accounts collide two ways', () => {
    const groups = samePlatformDuplicateGroups([
      entry(1, 'one', 'Shared'),
      entry(2, 'two', 'Shared'),
      entry(3, 'three', 'Shared'),
      entry(4, 'four', 'Also shared'),
      entry(5, 'five', 'Also shared'),
    ]);
    expect(groups.map((group) => group.length)).toEqual([3, 2]);
  });
});

describe('the refusal it produces', () => {
  it('says nothing at all when the accounts are distinct', () => {
    expect(
      samePlatformPolicyRefusal('Facebook', [
        entry(1, 'one', 'A word for this page'),
        entry(2, 'two', 'Something else entirely'),
      ]),
    ).toBeUndefined();
  });

  it('names the accounts that collided rather than the platform alone', () => {
    const refusal = samePlatformPolicyRefusal('Facebook', [
      entry(85300, 'gholmesdesigns', 'Same words'),
      entry(85301, 'wildeyephoto', 'Same words'),
    ]);
    expect(refusal).toContain('gholmesdesigns and wildeyephoto');
    expect(refusal).toContain('Facebook');
  });

  it('falls back to the account id where a handle is missing', () => {
    expect(samePlatformPolicyRefusal('Facebook', [entry(1, '', 'x'), entry(2, '', 'x')])).toContain(
      '1 and 2',
    );
  });

  it('says the provider will not refuse it, because that is why this rule exists', () => {
    const refusal = samePlatformPolicyRefusal('Facebook', [
      entry(1, 'one', 'Same'),
      entry(2, 'two', 'Same'),
    ]);
    expect(refusal).toMatch(/will not refuse it for you/);
  });

  it('offers the two honest fixes and no others', () => {
    const refusal =
      samePlatformPolicyRefusal('Facebook', [entry(1, 'one', 'Same'), entry(2, 'two', 'Same')]) ??
      '';
    expect(refusal).toMatch(/Write each account its own content/);
    expect(refusal).toMatch(/send to one of them/);
  });

  it('never suggests a filename or metadata trick as a way around it', () => {
    const refusal =
      samePlatformPolicyRefusal('Facebook', [entry(1, 'one', 'Same'), entry(2, 'two', 'Same')]) ??
      '';
    // The restriction is about what reaches two audiences, not about how the request is shaped.
    // A workaround that satisfies a string comparison satisfies nothing else, and the card puts
    // recommending one explicitly out of scope.
    for (const trick of [
      /filename/i,
      /file name/i,
      /rename/i,
      /metadata/i,
      /punctuation/i,
      /emoji/i,
    ])
      expect(refusal).not.toMatch(trick);
  });
});
