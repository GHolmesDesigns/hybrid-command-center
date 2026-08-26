/**
 * Scrub credential-shaped strings from MCP tool results before they leave the process.
 *
 * Walks JSON-like values; never invents structure. Used on every coordination tool result so a
 * handoff message that somehow still carried a scrubbed token cannot be echoed back raw.
 */
import { redactSecrets } from '../integration-log.ts';

export function redactToolResult<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(child);
    }
    return out;
  }
  return value;
}
