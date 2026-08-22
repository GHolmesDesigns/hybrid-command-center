import { describe, expect, it } from 'vitest';
import {
  samePlatformDuplicateGroups,
  samePlatformNearDuplicateGroups,
  samePlatformNearDuplicateWarning,
  samePlatformPolicyRefusal,
  type SamePlatformEntry,
} from './publish-same-platform.ts';

/**
 * The same-platform rule as fixtures, which is what C77's acceptance criterion asks for.
 *
 * The rule exists because C73 recorded question 1 as *verified*: the API accepts same-platform
 * content of any kind and states no restriction at all. Every case here is therefore about this app
 * making its own call about something the provider would happily have taken — refusing what is
 * identical, remarking on what only reads that way, and saying which of those it is doing.
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

  it('says nothing downstream will refuse it, because that is why this rule exists', () => {
    const refusal = samePlatformPolicyRefusal('Facebook', [
      entry(1, 'one', 'Same'),
      entry(2, 'two', 'Same'),
    ]);
    expect(refusal).toMatch(/nothing downstream will refuse it for you/);
  });

  it('owns the rule instead of attributing it to the provider', () => {
    const refusal =
      samePlatformPolicyRefusal('Facebook', [entry(1, 'one', 'Same'), entry(2, 'two', 'Same')]) ??
      '';
    // The reason this is asserted rather than left to review: the sentence it replaced said the
    // vendor's own guidance restricted same-platform content, and no such wording is recorded
    // anywhere in this repository (`docs/post-bridge-api-surface.md` §14, correction of 22 August).
    // A rule this app decided on is allowed; quoting a policy nobody can produce is not.
    expect(refusal).toMatch(/this app will not do for you/);
    for (const attribution of [
      /post bridge/i,
      /vendor/i,
      /their guidance/i,
      /provider's (own )?guidance/i,
      /support page/i,
      /support material/i,
      /policy/i,
    ])
      expect(refusal).not.toMatch(attribution);
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

describe('which accounts were given the same words in a different shape', () => {
  it('groups captions that differ only in capitalization and punctuation', () => {
    const groups = samePlatformNearDuplicateGroups([
      entry(1, 'one', 'Booking August now!'),
      entry(2, 'two', 'booking august now'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((item) => item.accountId)).toEqual([1, 2]);
  });

  it('groups captions that differ only by an emoji or extra spacing', () => {
    expect(
      samePlatformNearDuplicateGroups([
        entry(1, 'one', 'Booking August now 🎉'),
        entry(2, 'two', 'Booking  August  now'),
      ]),
    ).toHaveLength(1);
  });

  it('leaves an identical pair alone, because the refusal already names it', () => {
    // Otherwise one collision is reported twice, once as a refusal and once as a remark, and the
    // person reads them as two separate problems.
    expect(
      samePlatformNearDuplicateGroups([
        entry(1, 'one', 'Same words'),
        entry(2, 'two', 'Same words'),
      ]),
    ).toEqual([]);
  });

  it('reports all three when two are identical and a third is only cosmetically different', () => {
    const groups = samePlatformNearDuplicateGroups([
      entry(1, 'one', 'Same words'),
      entry(2, 'two', 'Same words'),
      entry(3, 'three', 'same words!'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.map((item) => item.accountId)).toEqual([1, 2, 3]);
  });

  it('finds nothing between captions that actually say different things', () => {
    expect(
      samePlatformNearDuplicateGroups([
        entry(1, 'one', 'Booking August now'),
        entry(2, 'two', 'Two slots left in September'),
      ]),
    ).toEqual([]);
  });

  it('separates accounts whose media differs, exactly as the refusal does', () => {
    expect(
      samePlatformNearDuplicateGroups([
        entry(1, 'one', 'Booking August now!', [A]),
        entry(2, 'two', 'booking august now', [B]),
      ]),
    ).toEqual([]);
  });

  it('says nothing about captions that are only punctuation, because that is no wording at all', () => {
    expect(
      samePlatformNearDuplicateGroups([entry(1, 'one', '!!!'), entry(2, 'two', '???')]),
    ).toEqual([]);
  });
});

describe('the warning it produces', () => {
  const warning = (first: string, second: string) =>
    samePlatformNearDuplicateWarning('Facebook', [
      entry(85300, 'gholmesdesigns', first),
      entry(85301, 'wildeyephoto', second),
    ]) ?? '';

  it('says nothing when the two captions genuinely differ', () => {
    expect(
      samePlatformNearDuplicateWarning('Facebook', [
        entry(1, 'one', 'A word for this page'),
        entry(2, 'two', 'Something else entirely'),
      ]),
    ).toBeUndefined();
  });

  it('names the accounts and asks whether it was deliberate', () => {
    const text = warning('Booking August now!', 'booking august now');
    expect(text).toContain('gholmesdesigns and wildeyephoto');
    expect(text).toContain('Facebook');
    expect(text).toMatch(/is that deliberate\?/i);
  });

  it('says plainly that nothing is blocked, because nothing is', () => {
    expect(warning('Booking August now!', 'booking august now')).toMatch(/nothing is blocked/i);
  });

  it('leaves the judgement with the person rather than claiming a threshold', () => {
    const text = warning('Booking August now!', 'booking august now');
    expect(text).toMatch(/leaves "different enough" to you/);
    // No number, no percentage, no ratio: there is no honest source for one.
    expect(text).not.toMatch(/\d/);
  });

  it('never suggests a cosmetic edit as a way to satisfy it', () => {
    const text = warning('Booking August now!', 'booking august now');
    // It names capitalization and punctuation as what it *disregarded*, which is the opposite of
    // recommending them — so what is asserted here is that it asks for nothing to be changed.
    for (const trick of [/filename/i, /file name/i, /rename/i, /metadata/i, /just (add|change)/i])
      expect(text).not.toMatch(trick);
    expect(text).toMatch(/nothing needs changing/i);
  });
});
