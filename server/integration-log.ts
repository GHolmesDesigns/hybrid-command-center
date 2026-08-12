/**
 * The write and read helpers behind the integration activity log (`integration_events`).
 *
 * Three properties are the point of this module:
 *
 * - **Append-only.** The only statements here are one `INSERT` and the retention `DELETE`.
 *   Nothing updates a row, and no caller — route, service, or script — is given a way to.
 * - **Bounded.** Every write prunes to the newest `INTEGRATION_EVENT_LIMIT` rows, and one row
 *   lists at most `INTEGRATION_EVENT_ENTITY_LIMIT` records, so neither the table nor a single
 *   row grows without a limit. The true count survives the cap in `entity_count`.
 * - **No credentials.** A caller passes structured fields, never a dump of a request or a
 *   provider response, and the one free-text field an external failure reaches — `error` — is
 *   scrubbed and truncated by `redactSecrets` on the way in.
 *
 * Both statements run in the caller's transaction when there is one, which is how an import
 * receipt and the event that explains it land together or not at all.
 */
import crypto from 'node:crypto';
import type { Db } from './db.ts';
import {
  INTEGRATION_EVENT_ENTITY_LIMIT,
  INTEGRATION_EVENT_LIMIT,
  type IntegrationEntity,
  type IntegrationEvent,
  type IntegrationOperation,
  type IntegrationOutcome,
  type IntegrationSource,
} from '../shared/integration-log.ts';

/** What a caller records. `entities` may be longer than the row keeps; the count stays true. */
export interface IntegrationEventInput {
  source: IntegrationSource;
  operation: IntegrationOperation;
  outcome: IntegrationOutcome;
  summary: string;
  entities?: readonly IntegrationEntity[];
  correlationId?: string;
  error?: string;
}

/** Long enough for a stack-free provider message, short enough that no payload fits. */
const ERROR_MAX = 500;

/**
 * Words that name a credential in the message formats these integrations produce — OAuth
 * query strings, `.env` echoes, and provider error bodies.
 */
const CREDENTIAL_WORD =
  '(?:access_?token|refresh_?token|id_?token|client_?secret|api[-_]?key|auth(?:orization)?|token|secret|password|passwd|credential|private_?key|signature)';

const REDACTIONS: [RegExp, string][] = [
  // `Bearer ya29...`, however the header was capitalized.
  [/\bbearer\s+[\w.\-+/=]+/gi, 'Bearer [redacted]'],
  // `access_token=...`, `"client_secret": "..."`, `password: ...` — quoted or bare. The key is
  // kept and only its value replaced, so the message still says which credential it was about.
  [new RegExp(`(\\b${CREDENTIAL_WORD}"?\\s*[:=]\\s*"?)[^\\s"',;)}\\]]+`, 'gi'), '$1[redacted]'],
  // Google's own token shapes, which appear in provider errors without a naming key.
  [/\bya29\.[\w.\-+/=]+/g, '[redacted]'],
  [/\b1\/\/[\w.\-+/=]{10,}/g, '[redacted]'],
  // A JWT, which carries its claims in the open to anyone who base64-decodes it.
  [/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, '[redacted]'],
];

/**
 * Removes anything credential-shaped from free text, and truncates what is left.
 *
 * Deliberately blunt: it would rather redact a harmless word next to a colon than let a token
 * reach a table this app treats as readable. `error` is the only field it guards, because it
 * is the only one an external system's own words reach.
 */
export function redactSecrets(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of REDACTIONS)
    scrubbed = scrubbed.replace(pattern, replacement);
  scrubbed = scrubbed.trim();
  return scrubbed.length > ERROR_MAX ? `${scrubbed.slice(0, ERROR_MAX - 1)}…` : scrubbed;
}

interface EventRow {
  id: string;
  source: string;
  operation: string;
  outcome: string;
  summary: string;
  entities: string;
  entity_count: number;
  correlation_id: string | null;
  error: string | null;
  created_at: string;
}

/**
 * Records one thing an integration did, and prunes the log to its retention bound.
 *
 * Returns the event as it was stored, entity cap included, so a caller reporting back to the
 * browser reports what the log actually holds rather than what it hoped to write.
 */
export function recordIntegrationEvent(db: Db, input: IntegrationEventInput): IntegrationEvent {
  const all = input.entities ?? [];
  const event: IntegrationEvent = {
    id: crypto.randomUUID(),
    source: input.source,
    operation: input.operation,
    outcome: input.outcome,
    summary: input.summary,
    entities: all.slice(0, INTEGRATION_EVENT_ENTITY_LIMIT),
    entityCount: all.length,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.error ? { error: redactSecrets(input.error) } : {}),
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO integration_events(id,source,operation,outcome,summary,entities,entity_count,correlation_id,error,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    event.id,
    event.source,
    event.operation,
    event.outcome,
    event.summary,
    JSON.stringify(event.entities),
    event.entityCount,
    event.correlationId ?? null,
    event.error ?? null,
    event.createdAt,
  );
  // Retention: keep the newest rows, drop the rest. Deleting the oldest is the whole policy,
  // and it is the only `DELETE` this module has — nothing else removes or rewrites a row.
  db.prepare(
    `DELETE FROM integration_events WHERE id NOT IN (
       SELECT id FROM integration_events ${NEWEST_FIRST} LIMIT ?
     )`,
  ).run(INTEGRATION_EVENT_LIMIT);
  return event;
}

/**
 * Newest first, insertion order breaking the tie.
 *
 * A timestamp is not enough on its own: a sync writing several events in a loop stamps them
 * inside the same millisecond, and then "the newest" would be decided by a random UUID — so
 * retention could drop the row it just wrote. SQLite's implicit `rowid` is the insertion order,
 * and it keeps rising here because retention only ever deletes the lowest ones.
 */
const NEWEST_FIRST = 'ORDER BY created_at DESC, rowid DESC';

/** Newest first. Filters narrow the log; they never change what it holds. */
export function listIntegrationEvents(
  db: Db,
  options: { source?: IntegrationSource; correlationId?: string; limit?: number } = {},
): IntegrationEvent[] {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (options.source) {
    where.push('source = ?');
    values.push(options.source);
  }
  if (options.correlationId) {
    where.push('correlation_id = ?');
    values.push(options.correlationId);
  }
  values.push(Math.min(options.limit ?? INTEGRATION_EVENT_LIMIT, INTEGRATION_EVENT_LIMIT));
  return (
    db
      .prepare(
        `SELECT * FROM integration_events
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ${NEWEST_FIRST} LIMIT ?`,
      )
      .all(...values) as unknown as EventRow[]
  ).map(toEvent);
}

function toEvent(row: EventRow): IntegrationEvent {
  return {
    id: row.id,
    source: row.source as IntegrationSource,
    operation: row.operation as IntegrationOperation,
    outcome: row.outcome as IntegrationOutcome,
    summary: row.summary,
    entities: safeEntities(row.entities),
    entityCount: row.entity_count,
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
}

/** An event whose entity list cannot be read is still an event: the rest is columns. */
function safeEntities(raw: string): IntegrationEntity[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as IntegrationEntity[]) : [];
  } catch {
    return [];
  }
}
