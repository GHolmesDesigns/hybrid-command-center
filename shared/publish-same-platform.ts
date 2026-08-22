/**
 * The same-platform content rule, as a preflight refusal rather than something the provider decides.
 *
 * C73's live probe (`docs/post-bridge-api-surface.md` §14, question 1) recorded this claim as
 * **verified with policy constraint**, and the two halves of that state matter separately:
 *
 * - *Verified* — `POST /v1/posts` accepted materially different captions for two accounts on one
 *   platform and raised no duplicate-content refusal of its own.
 * - *Policy constraint* — the vendor's support material restricts same-platform content anyway. An
 *   API that accepts a request is not a platform that permits the post, and the account that pays
 *   for the difference is the user's, not this app's.
 *
 * So the refusal lives here, before anything is sent, rather than being left to a provider that
 * demonstrably will not raise it.
 *
 * **What this module deliberately does not do.** The card names "identical or insufficiently
 * distinct" content, and only the first of those is objectively decidable from what is recorded:
 * the vendor's threshold for *insufficiently distinct* is not in §14, and inventing a similarity
 * ratio would be this app making up a rule and attributing it to the provider. Identical is what is
 * enforced; the rest is a warning the person can act on with their own judgement. Capture the
 * support page's wording into §14 and this module tightens without anything else moving.
 *
 * It also never suggests working around the rule by changing a filename, a caption's punctuation,
 * or any other metadata. The restriction is about what reaches two audiences, not about how the
 * request is shaped, and a workaround that satisfies a string comparison satisfies nothing else.
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

const nameFor = (entry: SamePlatformEntry) => entry.handle || String(entry.accountId);

/**
 * Groups of accounts that were given byte-identical content, largest group first.
 *
 * Exported so a preview can highlight the accounts rather than only print the sentence, and so the
 * grouping is testable without going through a whole plan.
 */
export function samePlatformDuplicateGroups(
  entries: readonly SamePlatformEntry[],
): SamePlatformEntry[][] {
  const byContent = new Map<string, SamePlatformEntry[]>();
  for (const entry of entries) {
    const key = contentKey(entry);
    byContent.set(key, [...(byContent.get(key) ?? []), entry]);
  }
  return [...byContent.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => b.length - a.length);
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
  const described = groups
    .map((group) => group.map((entry) => nameFor(entry)).join(' and '))
    .join('; ');
  return (
    `${platformLabel} was given the same caption and media for ${described}. ` +
    `Post Bridge's own guidance restricts sending identical content to more than one account on a platform, ` +
    `and the live probe confirmed the API will not refuse it for you — so this app refuses it here rather than ` +
    `letting the platform decide after it has posted. Write each account its own content, or send to one of them.`
  );
}
