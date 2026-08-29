import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { handleMcpJsonRpc } from './stdio.ts';
import { createMcpSession } from './session.ts';
import { postHandoff } from '../agent-coordination/service.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

const capture = () => {
  const replies: unknown[] = [];
  return {
    replies,
    write: (message: unknown) => {
      replies.push(message);
    },
  };
};

describe('handleMcpJsonRpc', () => {
  it('lists coordination tools and refuses a write without agent_label', async () => {
    const session = createMcpSession();
    const { replies, write } = capture();

    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, write, db);
    const listed = replies[0] as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.some((tool) => tool.name === 'coordination_post_handoff')).toBe(
      true,
    );
    expect(listed.result.tools.some((tool) => tool.name === 'system_capabilities')).toBe(true);

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: 'Nope.' },
        },
      },
      write,
      db,
    );
    const called = replies[1] as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(called.result.isError).toBe(true);
    expect(called.result.content[0]?.text).toMatch(/agent_label/);
  });

  it('initializes from clientInfo.name when _meta.agent_label is absent', async () => {
    const session = createMcpSession();
    const { replies, write } = capture();
    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'cursor', version: '0' } },
      },
      write,
      db,
    );
    expect(session.agentLabel).toBe('cursor');
    expect(replies[0]).toMatchObject({ result: { capabilities: { prompts: {} } } });
  });

  it('lists and gets prompts over the shared JSON-RPC handler', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const { replies, write } = capture();
    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 1, method: 'prompts/list' }, write, db);
    const listed = replies[0] as { result: { prompts: Array<{ name: string }> } };
    expect(listed.result.prompts.map((prompt) => prompt.name)).toContain('verify_before_complete');

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'prompts/get',
        params: { name: 'verify_before_complete', arguments: { handoffId: 'handoff-1' } },
      },
      write,
      db,
    );
    expect(replies[1]).toMatchObject({
      result: { messages: [{ role: 'user', content: { type: 'text' } }] },
    });

    await handleMcpJsonRpc(
      session,
      { jsonrpc: '2.0', id: 3, method: 'prompts/get', params: {} },
      write,
      db,
    );
    await handleMcpJsonRpc(
      session,
      { jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'missing' } },
      write,
      db,
    );
    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'prompts/get',
        params: { name: 'start_claimed_work', arguments: {} },
      },
      write,
      db,
    );
    expect(replies[2]).toMatchObject({ error: { code: -32602 } });
    expect(replies[3]).toMatchObject({ error: { code: -32602 } });
    expect(replies[4]).toMatchObject({
      error: { code: -32602, message: expect.stringMatching(/handoffId/) },
    });
  });

  it('covers ping, notifications, missing method, and unknown method', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const { replies, write } = capture();

    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 1, method: 'ping' }, write, db);
    expect(replies[0]).toMatchObject({ result: {} });

    await handleMcpJsonRpc(
      session,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      write,
      db,
    );
    await handleMcpJsonRpc(session, { jsonrpc: '2.0', method: 'initialized' }, write, db);
    expect(replies).toHaveLength(1);

    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 2 }, write, db);
    expect(replies[1]).toMatchObject({
      error: { code: -32600 },
    });

    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 3, method: 'nope' }, write, db);
    expect(replies[2]).toMatchObject({
      error: { code: -32601 },
    });
  });

  it('validates tools/call and resources/read arguments and returns success payloads', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const { replies, write } = capture();

    await handleMcpJsonRpc(
      session,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
      write,
      db,
    );
    expect(replies[0]).toMatchObject({ error: { code: -32602 } });

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'coordination_post_handoff',
          arguments: { subjectType: 'freeform', message: 'From stdio.' },
        },
      },
      write,
      db,
    );
    const posted = replies[1] as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(posted.result.isError).toBe(false);
    expect(JSON.parse(posted.result.content[0]!.text)).toMatchObject({ state: 'OPEN' });

    await handleMcpJsonRpc(
      session,
      { jsonrpc: '2.0', id: 3, method: 'resources/read', params: {} },
      write,
      db,
    );
    expect(replies[2]).toMatchObject({ error: { code: -32602 } });

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'resources/read',
        params: { uri: 'hcc://coordination/inbox?state=open' },
      },
      write,
      db,
    );
    const inbox = replies[3] as { result: { contents: Array<{ text: string }> } };
    expect(JSON.parse(inbox.result.contents[0]!.text).handoffs).toHaveLength(1);

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'resources/read',
        params: { uri: 'hcc://coordination/other' },
      },
      write,
      db,
    );
    expect(replies[4]).toMatchObject({ error: { code: -32603 } });
  });

  it('returns workspace context from resources/read and system_capabilities', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const { replies, write } = capture();

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'hcc://workspace/context?sections=tools,approvalBoundaries' },
      },
      write,
      db,
      { grantedScopes: ['coordination:read'] },
    );
    const resource = replies[0] as { result: { contents: Array<{ text: string }> } };
    const fromResource = JSON.parse(resource.result.contents[0]!.text);
    expect(fromResource.grantedScopes).toEqual(['coordination:read']);
    expect(fromResource.tools?.length).toBeGreaterThan(0);
    expect(fromResource.approvalBoundaries?.length).toBeGreaterThan(0);

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'system_capabilities', arguments: { sections: ['workspace'] } },
      },
      write,
      db,
    );
    const tool = replies[1] as { result: { content: Array<{ text: string }> } };
    const fromTool = JSON.parse(tool.result.content[0]!.text);
    expect(fromTool.workspace).toBeDefined();
    expect(fromTool.capabilityVersion).toMatch(/^mcp-[0-9a-f]{8}$/);
  });

  it('refuses initialize when agent_label is invalid', async () => {
    const session = createMcpSession();
    const { replies, write } = capture();
    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { _meta: { agent_label: 'bad label!' } },
      },
      write,
      db,
    );
    expect(replies[0]).toMatchObject({ error: { code: -32602 } });
  });

  it('ignores notifications that have no id', async () => {
    const session = createMcpSession();
    const { replies, write } = capture();
    await handleMcpJsonRpc(session, { jsonrpc: '2.0' }, write, db);
    expect(replies).toHaveLength(0);
  });
});

describe('resources and rate limiter branches', () => {
  it('accepts alternate open-inbox URIs and refuses unknown ones', async () => {
    const { readCoordinationResource } = await import('./resources.ts');
    postHandoff(db, {
      fromAgentLabel: 'cursor',
      subjectType: 'freeform',
      message: 'A',
    });
    postHandoff(db, {
      fromAgentLabel: 'cursor',
      subjectType: 'freeform',
      message: 'B',
    });
    const withoutQuery = readCoordinationResource(db, 'hcc://coordination/inbox');
    expect(JSON.parse(withoutQuery.text).handoffs.length).toBe(2);
    expect(() => readCoordinationResource(db, 'not a uri :::')).toThrow(/Unknown/);
    expect(() => readCoordinationResource(db, 'hcc://coordination/inbox?state=claimed')).toThrow(
      /Unknown/,
    );
  });
});

describe('handleMcpJsonRpc subscriptions and cancellation', () => {
  it('subscribes, unsubscribes, and ignores unknown cancel ids', async () => {
    const session = createMcpSession({ agentLabel: 'cursor' });
    const replies: unknown[] = [];
    const write = (message: unknown) => replies.push(message);

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/subscribe',
        params: { uri: 'hcc://coordination/inbox?state=open' },
      },
      write,
      db,
    );
    expect(session.subscriptions.size).toBe(1);

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/subscribe',
        params: { uri: 'hcc://nope' },
      },
      write,
      db,
    );
    expect(replies[1]).toMatchObject({ error: { code: -32602 } });

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/unsubscribe',
        params: { uri: 'hcc://coordination/inbox?state=open' },
      },
      write,
      db,
    );
    expect(session.subscriptions.size).toBe(0);

    await handleMcpJsonRpc(
      session,
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'missing' } },
      write,
      db,
    );
  });
});
