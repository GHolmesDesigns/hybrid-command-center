import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { handleMcpJsonRpc } from './stdio.ts';
import { createMcpSession } from './session.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('handleMcpJsonRpc', () => {
  it('lists coordination tools and refuses a write without agent_label', async () => {
    const session = createMcpSession();
    const replies: unknown[] = [];
    const write = (message: unknown) => {
      replies.push(message);
    };

    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, write, db);
    const listed = replies[0] as { result: { tools: Array<{ name: string }> } };
    expect(listed.result.tools.some((tool) => tool.name === 'coordination_post_handoff')).toBe(
      true,
    );

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

  it('initializes with _meta.agent_label and reads the inbox resource', async () => {
    const session = createMcpSession();
    const replies: unknown[] = [];
    const write = (message: unknown) => {
      replies.push(message);
    };

    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { _meta: { agent_label: 'cursor' }, clientInfo: { name: 'test', version: '0' } },
      },
      write,
      db,
    );
    expect(session.agentLabel).toBe('cursor');

    await handleMcpJsonRpc(session, { jsonrpc: '2.0', id: 2, method: 'resources/list' }, write, db);
    await handleMcpJsonRpc(
      session,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'resources/read',
        params: { uri: 'hcc://coordination/inbox?state=open' },
      },
      write,
      db,
    );
    const read = replies[2] as {
      result: { contents: Array<{ text: string }> };
    };
    const body = JSON.parse(read.result.contents[0]!.text) as { handoffs: unknown[] };
    expect(Array.isArray(body.handoffs)).toBe(true);
  });
});
