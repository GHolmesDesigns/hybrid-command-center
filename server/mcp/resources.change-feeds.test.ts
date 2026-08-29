import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { postHandoff } from '../agent-coordination/service.ts';
import { createTask, createProject } from '../workspace/writes.ts';
import { MCP_CHANGE_FEED_EXPIRED_MESSAGE } from '../../shared/mcp-change-feeds.ts';
import { MCP_AGENT_SCOPES } from '../../shared/mcp-agent-registry.ts';
import { readMcpResource, MCP_RESOURCE_DEFINITIONS } from './resources.ts';

const databases: Db[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
});

const openDb = (): Db => {
  const db = createDb(':memory:');
  databases.push(db);
  return db;
};

describe('change-feed resources', () => {
  it('lists both change-feed resources', () => {
    const uris = MCP_RESOURCE_DEFINITIONS.map((r) => r.uri);
    expect(uris).toContain('hcc://coordination/changes');
    expect(uris).toContain('hcc://workspace/changes');
  });

  it('returns a tip cursor, then the handoff posted after it', () => {
    const db = openDb();
    const tipBody = readMcpResource(db, 'hcc://coordination/changes', {
      grantedScopes: ['coordination:read'],
    });
    const tip = JSON.parse(tipBody.text) as {
      status: string;
      cursor: string;
      changes: unknown[];
    };
    expect(tip).toMatchObject({ status: 'ok', changes: [] });

    const handoff = postHandoff(db, {
      fromAgentLabel: 'cursor',
      toAgentLabel: 'claude',
      subjectType: 'freeform',
      message: 'Feed me.',
    });

    const pageBody = readMcpResource(
      db,
      `hcc://coordination/changes?after=${encodeURIComponent(tip.cursor)}`,
      { grantedScopes: ['coordination:read'] },
    );
    const page = JSON.parse(pageBody.text) as {
      status: string;
      changes: Array<{ kind: string; entityId: string | null }>;
    };
    expect(page).toMatchObject({
      status: 'ok',
      changes: [{ kind: 'handoff.posted', entityId: handoff.id }],
    });
  });

  it('refuses coordination feed without coordination:read', () => {
    const db = openDb();
    expect(() =>
      readMcpResource(db, 'hcc://coordination/changes', {
        grantedScopes: ['workspace:read'],
      }),
    ).toThrow(/coordination:read/);
  });

  it('refuses workspace feed without workspace:read', () => {
    const db = openDb();
    expect(() =>
      readMcpResource(db, 'hcc://workspace/changes', {
        grantedScopes: ['coordination:read'],
      }),
    ).toThrow(/workspace:read/);
  });

  it('returns workspace task changes after a tip cursor', () => {
    const db = openDb();
    db.prepare(
      `INSERT INTO clients(id,name,slug,status,created_at,updated_at)
       VALUES('11111111-1111-4111-8111-111111111111','Client','client','ACTIVE','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
    ).run();
    const project = createProject(db, {
      clientId: '11111111-1111-4111-8111-111111111111',
      name: 'Proj',
    });
    const tip = JSON.parse(
      readMcpResource(db, 'hcc://workspace/changes', { grantedScopes: MCP_AGENT_SCOPES }).text,
    ) as { cursor: string };
    const task = createTask(db, {
      projectId: project.id,
      title: 'Do it',
    });
    const page = JSON.parse(
      readMcpResource(db, `hcc://workspace/changes?after=${encodeURIComponent(tip.cursor)}`, {
        grantedScopes: ['workspace:read'],
      }).text,
    ) as { status: string; changes: Array<{ kind: string; entityId: string | null }> };
    expect(page.status).toBe('ok');
    expect(page.changes.some((c) => c.kind === 'task.created' && c.entityId === task.id)).toBe(
      true,
    );
  });

  it('surfaces cursor_expired through the resource body', () => {
    const db = openDb();
    const stale = readMcpResource(db, 'hcc://coordination/changes?after=hcc_cf_not-a-real-cursor', {
      grantedScopes: ['coordination:read'],
    });
    expect(JSON.parse(stale.text)).toEqual({
      status: 'cursor_expired',
      feed: 'coordination',
      message: MCP_CHANGE_FEED_EXPIRED_MESSAGE,
    });
  });
});
