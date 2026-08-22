/**
 * The same-platform content rule: this app's own judgement, applied before anything is sent.
 *
 * **Whose rule this is.** C73's live probe (`docs/post-bridge-api-surface.md` §14, question 1) put
 * the question to the live API and recorded the answer: `POST /v1/posts` accepted materially
 * different captions for two accounts on one platform, and it raised no duplicate-content refusal
 * of its own. The provider imposes nothing here. So the refusal below is **this app's judgement**,
 * not a rule anybody else wrote down:
 *
 * - Two of the user's own pages on one platform, given the same words, is the shape of thing those
 *   platforms suppress and their audiences read as spam. The account that pays for it is the
 *   user's, and a refusal they can clear by writing two captions costs them a minute.
 * - It is stated as this app's call because that is what it is. An earlier version of this module,
 *   and of §14, said the vendor's support material restricted same-platform content. **No such
 *   wording was ever recorded** — no URL, no quote, in §13's sources or anywhere else — so the
 *   sentence asserted a vendor policy this repository cannot show. Saying "we think this is a bad
 *   idea" is honest; attributing it to Post Bridge was not.
 * - If a vendor rule does turn up, its wording and URL go in §14 and §13 and this module can quote
 *   it. Until then it speaks for itself.
 *
 * **What it refuses, and what it only remarks on.** Byte-identical caption *and* media is refused:
 * that is objectively decidable and nobody selects it on purpose. Anything less than identical is
 * not refused — `samePlatformNearDuplicateWarning` remarks on the near cases and a person decides,
 * because "different enough" is a judgement about two audiences and this app has no threshold for
 * it that would not be invented. There is deliberately no similarity ratio anywhere in this file.
 *
 * **Caption and media are compared together**, in both halves of the rule. Two accounts given the
 * same words with different pictures are not a collision: the difference is real and deliberate.
 *
 * Neither half ever suggests working around the rule by changing a filename, a caption's
 * punctuation, or any other metadata. The concern is what reaches two audiences, not how the
 * request is shaped, and an edit that satisfies a string comparison satisfies nothing else.
 */

/** One account's resolved content, as the rule compares it. */
export interface SamePlatformEntry {
  accountId: number;
  handle: string;
  caption: string;
  mediaUrls: readonly string[];
}

/** What two accounts on one platform were given, and whether it is the same thing. */
const contentKey = (entry: SamePlatformEntry) =>
  JSON.stringify([entry.caption.trim(), [...entry.mediaUrls]]);

/**
 * The wording alone, with everything a reader would not call a difference set aside.
 *
 * Case, spacing, punctuation, and emoji collapse; letters and digits survive. This is a
 * **categorical** test and not a measurement: two captions either say the same words or they do
 * not, and the answer is explainable in one sentence to the person who sees the warning. A
 * similarity ratio would be this app inventing a threshold and then hiding it inside a number.
 */
const wordingKey = (caption: string) =>
  caption
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const nearKey = (entry: SamePlatformEntry) =>
  JSON.stringify([wordingKey(entry.caption), [...entry.mediaUrls]]);

const nameFor = (entry: SamePlatformEntry) => entry.handle || String(entry.accountId);

const groupBy = (
  entries: readonly SamePlatformEntry[],
  key: (entry: SamePlatformEntry) => string,
): SamePlatformEntry[][] => {
  const groups = new Map<string, SamePlatformEntry[]>();
  for (const entry of entries) {
    const value = key(entry);
    groups.set(value, [...(groups.get(value) ?? []), entry]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length);
};

const namesOf = (groups: SamePlatformEntry[][]) =>
  groups.map((group) => group.map((entry) => nameFor(entry)).join(' and ')).join('; ');

/**
 * Groups of accounts that were given byte-identical content, largest group first.
 *
 * Exported so a preview can highlight the accounts rather than only print the sentence, and so the
 * grouping is testable without going through a whole plan.
 */
export function samePlatformDuplicateGroups(
  entries: readonly SamePlatformEntry[],
): SamePlatformEntry[][] {
  return groupBy(entries, contentKey);
}

/**
 * Groups of accounts whose content says the same thing without being identical, largest first.
 *
 * Three conditions, each of which keeps the warning meaningful:
 *
 * - The group must hold **more than one distinct exact content**, so a pair the refusal already
 *   names is not also warned about. A group of three where two are identical and the third differs
 *   only cosmetically is reported, and names all three, because all three are in fact that close.
 * - The shared wording must not be **empty**. Two captions made entirely of punctuation both
 *   reduce to nothing, and "these say the same words" would be a claim about no words at all.
 * - Media must match exactly, as in the refusal.
 */
export function samePlatformNearDuplicateGroups(
  entries: readonly SamePlatformEntry[],
): SamePlatformEntry[][] {
  return groupBy(entries, nearKey).filter(
    (group) =>
      wordingKey(group[0]?.caption ?? '') !== '' &&
      new Set(group.map((entry) => contentKey(entry))).size > 1,
  );
}

/**
 * The refusal for one platform's selected accounts, or nothing where they are all distinct.
 *
 * One sentence per duplicated group, naming the accounts, because a person fixing this needs to
 * know which of their pages collided rather than that "Facebook" did.
 */
export function samePlatformPolicyRefusal(
  platformLabel: string,
  entries: readonly SamePlatformEntry[],
): string | undefined {
  const groups = samePlatformDuplicateGroups(entries);
  if (!groups.length) return undefined;
  return (
    `${platformLabel} was given the same caption and media for ${namesOf(groups)}. ` +
    `Sending one platform's audiences the same post twice is what this app will not do for you: ` +
    `the live API accepts it without complaint, so nothing downstream will refuse it for you, and ` +
    `the accounts it reflects on are yours. Write each account its own content, or send to one of them.`
  );
}

/**
 * The remark for accounts that were given the same words in a different shape, or nothing.
 *
 * A warning and not a refusal, which is the whole point: the preview shows it, the confirm button
 * stays live, and the person who knows what these two audiences overlap on decides. It says which
 * accounts and why they read as close, and it asks — because the honest answer might be yes.
 */
export function samePlatformNearDuplicateWarning(
  platformLabel: string,
  entries: readonly SamePlatformEntry[],
): string | undefined {
  const groups = samePlatformNearDuplicateGroups(entries);
  if (!groups.length) return undefined;
  return (
    `${platformLabel} is about to send ${namesOf(groups)} the same words in a slightly different ` +
    `shape — the captions match once capitalization, spacing, punctuation, and emoji are set aside, ` +
    `and the media is the same. These are very close: is that deliberate? Nothing is blocked, and ` +
    `nothing needs changing if two audiences that barely overlap should hear the same thing. This ` +
    `app refuses only content that is identical and leaves "different enough" to you, because it is ` +
    `a judgement about who reads both pages rather than something a rule can measure.`
  );
}
