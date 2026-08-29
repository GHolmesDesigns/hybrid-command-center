/**
 * Bounded process-lifetime registry for streamable HTTP MCP sessions (C133 / #383).
 *
 * Assigns cryptographically random `Mcp-Session-Id` values at initialize, reuses the underlying
 * `McpSession` across POSTs, buffers SSE events for reconnect, and prunes idle/abandoned entries
 * so a forgotten laptop cannot leak forever. Rate limits still come from
 * `McpWriteLimiterRegistry` per request — this registry only holds protocol session state.
 */
import crypto from 'node:crypto';
import {
  MCP_HTTP_SESSION_MAX,
  MCP_HTTP_SESSION_TTL_MS,
  MCP_SSE_EVENT_BUFFER,
} from '../../shared/mcp-transport.ts';
import { createMcpSession, type McpSession } from './session.ts';

export type McpSseEvent = {
  id: string;
  message: unknown;
};

export type McpHttpSessionRecord = {
  id: string;
  mcp: McpSession;
  /** Credential that opened the session — later requests must match. */
  credentialKey: string;
  protocolVersion: string;
  createdAt: number;
  touchedAt: number;
  /** Ring buffer of outbound SSE messages for Last-Event-ID replay. */
  eventBuffer: McpSseEvent[];
  nextEventSeq: number;
  /** Live GET SSE listeners for this session. */
  streamListeners: Set<(event: McpSseEvent) => void>;
};

export class McpHttpSessionRegistry {
  private readonly sessions = new Map<string, McpHttpSessionRecord>();

  create(options: {
    credentialKey: string;
    protocolVersion: string;
    nowMs: number;
    agentLabel?: string | null;
  }): McpHttpSessionRecord {
    this.prune(options.nowMs);
    const id = crypto.randomBytes(24).toString('base64url');
    const record: McpHttpSessionRecord = {
      id,
      mcp: createMcpSession({ agentLabel: options.agentLabel ?? null }),
      credentialKey: options.credentialKey,
      protocolVersion: options.protocolVersion,
      createdAt: options.nowMs,
      touchedAt: options.nowMs,
      eventBuffer: [],
      nextEventSeq: 1,
      streamListeners: new Set(),
    };
    this.sessions.set(id, record);
    this.enforceMax();
    return record;
  }

  get(id: string, nowMs: number): McpHttpSessionRecord | null {
    this.prune(nowMs);
    const record = this.sessions.get(id);
    if (!record) return null;
    record.touchedAt = nowMs;
    // Re-insert so Map iteration stays oldest-touched-first for prune.
    this.sessions.delete(id);
    this.sessions.set(id, record);
    return record;
  }

  delete(id: string): boolean {
    const record = this.sessions.get(id);
    if (!record) return false;
    record.streamListeners.clear();
    this.sessions.delete(id);
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Push a JSON-RPC message onto the session's GET stream (and buffer for reconnect). */
  publish(record: McpHttpSessionRecord, message: unknown): McpSseEvent {
    const event: McpSseEvent = {
      id: String(record.nextEventSeq++),
      message,
    };
    record.eventBuffer.push(event);
    while (record.eventBuffer.length > MCP_SSE_EVENT_BUFFER) {
      record.eventBuffer.shift();
    }
    for (const listener of record.streamListeners) {
      try {
        listener(event);
      } catch {
        // Drop a broken listener; the next GET will re-attach.
      }
    }
    return event;
  }

  eventsAfter(record: McpHttpSessionRecord, lastEventId: string | null): McpSseEvent[] {
    if (!lastEventId) return [];
    const after = Number(lastEventId);
    if (!Number.isFinite(after)) return [];
    return record.eventBuffer.filter((event) => Number(event.id) > after);
  }

  /** Deliver a resource-updated tip to every session subscribed to that URI. */
  notifyResourceUpdated(uri: string): void {
    for (const record of this.sessions.values()) {
      if (!record.mcp.subscriptions.has(uri)) continue;
      this.publish(record, {
        jsonrpc: '2.0',
        method: 'notifications/resources/updated',
        params: { uri },
      });
    }
  }

  prune(nowMs: number): void {
    const floor = nowMs - MCP_HTTP_SESSION_TTL_MS;
    for (const [id, record] of this.sessions) {
      if (record.touchedAt >= floor) break;
      record.streamListeners.clear();
      this.sessions.delete(id);
    }
  }

  private enforceMax(): void {
    while (this.sessions.size > MCP_HTTP_SESSION_MAX) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
}
