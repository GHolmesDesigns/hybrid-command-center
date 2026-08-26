/**
 * MCP resource adapter for the coordination inbox (C111).
 *
 * `hcc://coordination/inbox?state=open` is a snapshot of active work: OPEN and CLAIMED handoffs.
 * Agents poll; there is no push subscription in v1.
 */
import type { Db } from '../db.ts';
import { listHandoffs } from '../agent-coordination/service.ts';
import { COORDINATION_INBOX_URI } from '../../shared/mcp-agent-events.ts';
import { redactToolResult } from './redact.ts';

export const COORDINATION_RESOURCE_DEFINITIONS = [
  {
    uri: COORDINATION_INBOX_URI,
    name: 'Coordination inbox',
    description: 'Open and claimed agent handoffs (active inbox).',
    mimeType: 'application/json',
  },
] as const;

export function readCoordinationResource(
  db: Db,
  uri: string,
): {
  uri: string;
  mimeType: string;
  text: string;
} {
  const normalized = uri.trim();
  if (normalized !== COORDINATION_INBOX_URI && !isOpenInboxUri(normalized)) {
    throw new Error(`Unknown coordination resource: ${uri}`);
  }
  const open = listHandoffs(db, { state: 'OPEN' });
  const claimed = listHandoffs(db, { state: 'CLAIMED' });
  const payload = redactToolResult({
    state: 'open',
    handoffs: [...open, ...claimed].sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
    }),
  });
  return {
    uri: COORDINATION_INBOX_URI,
    mimeType: 'application/json',
    text: JSON.stringify(payload),
  };
}

function isOpenInboxUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return (
      parsed.protocol === 'hcc:' &&
      parsed.hostname === 'coordination' &&
      parsed.pathname === '/inbox' &&
      (parsed.searchParams.get('state') === 'open' || parsed.searchParams.get('state') === null)
    );
  } catch {
    return false;
  }
}
