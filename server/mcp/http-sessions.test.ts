import { describe, expect, it } from 'vitest';
import { MCP_HTTP_SESSION_MAX, MCP_HTTP_SESSION_TTL_MS } from '../../shared/mcp-transport.ts';
import { McpHttpSessionRegistry } from './http-sessions.ts';

describe('McpHttpSessionRegistry', () => {
  it('creates, reuses, and deletes sessions bound to a credential', () => {
    const registry = new McpHttpSessionRegistry();
    const record = registry.create({
      credentialKey: 'cred-a',
      protocolVersion: '2024-11-05',
      nowMs: 1_000,
      agentLabel: 'cursor',
    });
    expect(registry.get(record.id, 1_100)?.mcp.agentLabel).toBe('cursor');
    expect(registry.get(record.id, 1_200)?.credentialKey).toBe('cred-a');
    expect(registry.delete(record.id)).toBe(true);
    expect(registry.get(record.id, 1_300)).toBeNull();
    expect(registry.delete('missing')).toBe(false);
  });

  it('prunes idle sessions and enforces the max bound', () => {
    const registry = new McpHttpSessionRegistry();
    const first = registry.create({
      credentialKey: 'a',
      protocolVersion: '2024-11-05',
      nowMs: 0,
    });
    registry.create({
      credentialKey: 'b',
      protocolVersion: '2024-11-05',
      nowMs: 10,
    });
    expect(registry.get(first.id, MCP_HTTP_SESSION_TTL_MS + 1)).toBeNull();
    expect(registry.size).toBe(1);

    for (let i = 0; i < MCP_HTTP_SESSION_MAX + 3; i += 1) {
      registry.create({
        credentialKey: `fill-${i}`,
        protocolVersion: '2024-11-05',
        nowMs: 1_000 + i,
      });
    }
    expect(registry.size).toBeLessThanOrEqual(MCP_HTTP_SESSION_MAX);
  });

  it('buffers SSE events for Last-Event-ID reconnect and fans out resource tips', () => {
    const registry = new McpHttpSessionRegistry();
    const record = registry.create({
      credentialKey: 'a',
      protocolVersion: '2024-11-05',
      nowMs: 0,
    });
    record.mcp.subscriptions.add('hcc://coordination/inbox?state=open');
    const seen: unknown[] = [];
    record.streamListeners.add((event) => seen.push(event.message));
    record.streamListeners.add(() => {
      throw new Error('listener boom');
    });
    registry.publish(record, { jsonrpc: '2.0', method: 'notifications/progress', params: {} });
    registry.notifyResourceUpdated('hcc://coordination/inbox?state=open');
    registry.notifyResourceUpdated('hcc://unused');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(registry.eventsAfter(record, null)).toEqual([]);
    expect(registry.eventsAfter(record, 'not-a-number')).toEqual([]);
    const replay = registry.eventsAfter(record, '1');
    expect(replay.length).toBeGreaterThanOrEqual(1);
    expect(replay[0]?.message).toMatchObject({
      method: 'notifications/resources/updated',
    });
  });
});
