/**
 * What the probe is allowed to write down.
 *
 * The probe's output is evidence a person reads and then commits part of, so the safe default is
 * that nothing external is quoted. `describeShape` and `pickScalars` are the two ways a response
 * reaches the report: the first records *which fields came back and of what type* and the second
 * copies a named handful of values a claim actually turns on. Neither has a path that copies a
 * whole response, so there is no raw body to accidentally commit.
 *
 * `redactSecrets` here is deliberately a second, smaller copy of `server/integration-log.ts`'s
 * function rather than an import of it: that module reaches SQLite, and a script that runs before
 * anything is configured must not open a database to scrub a string. The shapes it removes are the
 * ones a probe sees — a bearer header, a `pb_live_` key, a signed upload URL's query, a JWT.
 */

/** Long enough for a provider's own sentence, short enough that no payload fits. */
const TEXT_MAX = 300;

const CREDENTIAL_WORD =
  '(?:access_?token|refresh_?token|id_?token|client_?secret|api[-_]?key|auth(?:orization)?|token|secret|password|credential|private_?key|signature|x-goog-signature|x-amz-signature)';

const REDACTIONS: [RegExp, string | ((match: string) => string)][] = [
  // `Bearer pb_live_…`, however the header was capitalized.
  [/\bbearer\s+[\w.\-+/=]+/gi, 'Bearer [redacted]'],
  // Post Bridge's own key shape, which appears without a naming key in a provider error.
  [/\bpb_(?:live|test)_[\w-]+/gi, '[redacted]'],
  // `api_key=…`, `"signature": "…"` — quoted or bare. The key is kept and only its value
  // replaced, so the sentence still says which credential it was about.
  [new RegExp(`(\\b${CREDENTIAL_WORD}"?\\s*[:=]\\s*"?)[^\\s"',;)}\\]]+`, 'gi'), '$1[redacted]'],
  // A JWT, which carries its claims in the open to anyone who base64-decodes it.
  [/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, '[redacted]'],
  // Any absolute URL that still has a query string on it after the rules above — a signed upload
  // URL is exactly this shape and its signature is the query.
  [/\bhttps?:\/\/[^\s"'<>]*\?[^\s"'<>]*/gi, (match) => `${match.split('?')[0]}?[redacted]`],
];

/**
 * Removes anything credential-shaped from free text, and truncates what is left.
 *
 * Blunt on purpose: it would rather redact a harmless word next to a colon than let a key reach a
 * file someone commits.
 */
export function redactSecrets(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of REDACTIONS)
    scrubbed =
      typeof replacement === 'string'
        ? scrubbed.replace(pattern, replacement)
        : scrubbed.replace(pattern, replacement);
  scrubbed = scrubbed.trim();
  return scrubbed.length > TEXT_MAX ? `${scrubbed.slice(0, TEXT_MAX - 1)}…` : scrubbed;
}

/**
 * A URL as the log is allowed to hold it: origin and path, and the fact that there was a query
 * rather than the query itself.
 *
 * The signed `PUT` URL is the reason this exists. Its authority *is* its query string, so a log
 * line carrying one is a credential in a file, and the path alone is all the evidence a reader
 * needs to know which call was made. An unparseable string is reported as unparseable rather than
 * passed through, because the one thing worse than no URL is half of a signed one.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[unparseable url]';
  }
  const credentials = parsed.username || parsed.password ? '[credentials]@' : '';
  const query = parsed.search ? '?[redacted]' : '';
  return `${parsed.protocol}//${credentials}${parsed.host}${parsed.pathname}${query}`;
}

/**
 * A response's structure with none of its content: which keys came back, and of what type.
 *
 * This is how questions 2, 4, and 5 are answered. "Does the row still carry `post_result_id`" is a
 * question about field names, and answering it by pasting the row in would put a caption from
 * somebody's real post into the evidence. Depth is bounded because a nested provider object is a
 * place a long string could hide, and a list is described by its first element and its length —
 * a hundred rows of the same shape says nothing a hundred times.
 */
export function describeShape(value: unknown, depth = 2): string {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return value.length === 0
      ? 'array(0)'
      : `array(${value.length}) of ${depth <= 0 ? '…' : describeShape(value[0], depth - 1)}`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    if (depth <= 0) return `{${entries.map(([key]) => key).join(', ')}}`;
    return `{${entries.map(([key, item]) => `${key}: ${describeShape(item, depth - 1)}`).join(', ')}}`;
  }
  return typeof value;
}

/**
 * The named values a claim turns on, and nothing beside them.
 *
 * An allowlist rather than a denylist: `match_confidence` and `status` are asked for by name, so
 * adding a field to the evidence is a deliberate edit here rather than a response growing a key.
 * Only scalars are copied — an object under an allowed key is described, not copied — and every
 * string still goes through `redactSecrets`, because an allowed field can still come back holding
 * something it should not.
 */
export function pickScalars(
  value: unknown,
  keys: readonly string[],
): Record<string, string | number | boolean | null> {
  const picked: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return picked;
  const row = value as Record<string, unknown>;
  for (const key of keys) {
    if (!(key in row)) continue;
    const item = row[key];
    if (item === null) picked[key] = null;
    else if (typeof item === 'string') picked[key] = redactSecrets(item);
    else if (typeof item === 'number' || typeof item === 'boolean') picked[key] = item;
    else picked[key] = describeShape(item, 1);
  }
  return picked;
}

/** The response headers the probe records by name. Question 7 is the whole reason for the list. */
export const RECORDED_HEADERS = [
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
] as const;

/**
 * The recorded headers that were present, lower-cased, with credential-shaped values scrubbed.
 *
 * An allowlist again. A response's headers are where a `Set-Cookie` or a signed redirect
 * `Location` lives, and neither is evidence for anything this probe asks.
 */
export function recordedHeaders(headers: Record<string, string>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const kept: Record<string, string> = {};
  for (const name of RECORDED_HEADERS)
    if (lower[name] !== undefined) kept[name] = redactSecrets(lower[name]);
  return kept;
}

/**
 * The provider's own words about a refusal, and nothing else from the body.
 *
 * A `400` explaining that two accounts on one platform may not carry the same content is the single
 * most valuable thing this probe can come back with, so the message is kept — scrubbed, joined where
 * the framework returned a list of them, and bounded. Everything else in an error body stays out.
 */
export function providerMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const row = body as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['message', 'error', 'detail', 'errors']) {
    const value = row[key];
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value))
      parts.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return redactSecrets(parts.join('; '));
}
