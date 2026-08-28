import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import {
  createMcpAgentCredential,
  listMcpAgentCredentials,
  McpAgentLabelTakenError,
  renameMcpAgentRegistration,
  resolveMcpAgentCredential,
  revokeMcpAgentCredential,
} from './mcp-agent-credentials.ts';
import { hashMcpBearerToken } from './mcp-bearers.ts';

const SECRET = 'session-secret-at-least-thirty-two-chars!!';

describe('scoped MCP agent credentials', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });
  afterEach(() => db.close());

  const issue = (label: string, now = 1_000) =>
    createMcpAgentCredential(db, {
      label,
      scopes: ['coordination:read', 'coordination:write'],
      expiresAt: new Date(now + 60_000).toISOString(),
      sessionSecret: SECRET,
      now,
    });

  it('stores only a token hash and resolves the server-bound label and scopes', () => {
    const issued = issue('cursor-planning');
    const stored = db.prepare('SELECT token_hash FROM agent_credentials').get() as {
      token_hash: string;
    };
    expect(stored.token_hash).toBe(hashMcpBearerToken(issued.rawToken, SECRET));
    expect(stored.token_hash).not.toBe(issued.rawToken);

    expect(
      resolveMcpAgentCredential(db, {
        rawToken: issued.rawToken,
        sessionSecret: SECRET,
        origin: '203.0.113.8',
        now: 2_000,
      }),
    ).toMatchObject({ agentLabel: 'cursor-planning', scopes: issued.credential.scopes });
    expect(listMcpAgentCredentials(db, 2_001)[0]).toMatchObject({
      label: 'cursor-planning',
      lastUsedAt: new Date(2_000).toISOString(),
      lastOrigin: '203.0.113.8',
    });
  });

  it('expires and revokes credentials independently', () => {
    const first = issue('cursor', 1_000);
    const second = issue('codex', 1_000);
    expect(revokeMcpAgentCredential(db, first.credential.id, 2_000)).toBe(true);
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: first.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 2_001,
      }),
    ).toBeNull();
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: second.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 2_001,
      }),
    ).not.toBeNull();
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: second.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 61_000,
      }),
    ).toBeNull();
  });

  it('refuses an already-expired issue and unknown token shapes', () => {
    expect(() =>
      createMcpAgentCredential(db, {
        label: 'expired-at-issue',
        scopes: ['coordination:read'],
        expiresAt: new Date(1_000).toISOString(),
        sessionSecret: SECRET,
        now: 1_000,
      }),
    ).toThrow('future');
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: 'wrong-prefix',
        sessionSecret: SECRET,
        origin: null,
        now: 1_000,
      }),
    ).toBeNull();
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: 'hcc_mcp_unknown',
        sessionSecret: SECRET,
        origin: null,
        now: 1_000,
      }),
    ).toBeNull();
  });

  it('edits the display label without changing the immutable agent id', () => {
    const issued = issue('cursor');
    expect(renameMcpAgentRegistration(db, issued.credential.agentId, 'cursor-review')).toBe(true);
    expect(listMcpAgentCredentials(db, 2_000)[0]).toMatchObject({
      agentId: issued.credential.agentId,
      label: 'cursor-review',
    });
  });

  it('reuses a registration after revoke so the same label can be issued again', () => {
    const first = issue('claude-desktop', 1_000);
    expect(revokeMcpAgentCredential(db, first.credential.id, 2_000)).toBe(true);
    const second = issue('claude-desktop', 3_000);
    expect(second.credential.agentId).toBe(first.credential.agentId);
    expect(second.credential.id).not.toBe(first.credential.id);
    expect(listMcpAgentCredentials(db, 3_001)).toEqual([
      expect.objectContaining({ id: second.credential.id, label: 'claude-desktop' }),
    ]);
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: second.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 3_001,
      }),
    ).toMatchObject({ agentLabel: 'claude-desktop', agentId: first.credential.agentId });
  });

  it('refuses a second active credential for the same label', () => {
    issue('codex-desktop', 1_000);
    expect(() => issue('CODEX-DESKTOP', 2_000)).toThrow(McpAgentLabelTakenError);
  });
});
