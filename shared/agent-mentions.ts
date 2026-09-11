import { AGENT_LABEL_PATTERN } from './agent-coordination.ts';

export type ParsedAgentMention = {
  label: string;
  known: boolean;
  start: number;
  end: number;
};

const labelChar = /[a-zA-Z0-9._-]/;

/** Token-bound `@label` mentions; unknown labels are returned with `known: false`. */
export function parseAgentMentions(
  body: string,
  registeredLabels: ReadonlySet<string> | readonly string[],
): ParsedAgentMention[] {
  const directory = new Map<string, string>();
  for (const label of registeredLabels) directory.set(label.toLowerCase(), label);

  const results: ParsedAgentMention[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < body.length) {
    if (body[index] === '@' && (index === 0 || /\s/.test(body[index - 1]!))) {
      const start = index;
      index += 1;
      let raw = '';
      while (index < body.length && labelChar.test(body[index]!)) {
        raw += body[index];
        index += 1;
      }
      if (AGENT_LABEL_PATTERN.test(raw)) {
        const canonical = directory.get(raw.toLowerCase()) ?? raw;
        const key = canonical.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            label: canonical,
            known: directory.has(key),
            start,
            end: index,
          });
        }
      }
      continue;
    }
    index += 1;
  }
  return results;
}

export function knownAgentMentionLabels(
  body: string,
  registeredLabels: ReadonlySet<string> | readonly string[],
): string[] {
  return parseAgentMentions(body, registeredLabels)
    .filter((mention) => mention.known)
    .map((mention) => mention.label);
}
