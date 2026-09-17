import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import {
  createAssistantMcpAgentCredential,
  createMcpAgentCredential,
  listMcpAgentCredentials,
  McpAgentLabelTakenError,
  renameMcpAgentRegistration,
  ReservedAssistantLabelError,
  resolveMcpAgentCredential,
  revokeMcpAgentCredential,
  rotateMcpAgentCredential,
} from './mcp-agent-credentials.ts';
import { mcpToolAvailable, MCP_TOOL_REGISTRY } from '../mcp/registry.ts';
import type { McpAgentScope } from '../../shared/mcp-agent-registry.ts';
import { migrateMcpCredentialWorkspaceWriteScopes } from '../db.ts';
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

  it('debounces repeated touches but touches again after thirty seconds', () => {
    const issued = issue('burst-test', 1_000);
    const changes = () =>
      (
        db.prepare('SELECT total_changes() AS count').get() as {
          count: number;
        }
      ).count;

    resolveMcpAgentCredential(db, {
      rawToken: issued.rawToken,
      sessionSecret: SECRET,
      origin: '203.0.113.8',
      now: 2_000,
    });
    const afterFirstTouch = changes();
    resolveMcpAgentCredential(db, {
      rawToken: issued.rawToken,
      sessionSecret: SECRET,
      origin: '203.0.113.8',
      now: 31_999,
    });
    expect(changes()).toBe(afterFirstTouch);

    resolveMcpAgentCredential(db, {
      rawToken: issued.rawToken,
      sessionSecret: SECRET,
      origin: '203.0.113.8',
      now: 32_000,
    });
    expect(changes()).toBe(afterFirstTouch + 2);
  });

  it('updates the diagnostic origin even inside the debounce window', () => {
    const issued = issue('origin-test', 1_000);
    resolveMcpAgentCredential(db, {
      rawToken: issued.rawToken,
      sessionSecret: SECRET,
      origin: '203.0.113.8',
      now: 2_000,
    });
    const before = db
      .prepare(
        `SELECT r.last_used_at, r.last_origin
         FROM agent_registrations r JOIN agent_credentials c ON c.agent_id=r.id
         WHERE c.id=?`,
      )
      .get(issued.credential.id) as { last_used_at: string; last_origin: string };

    resolveMcpAgentCredential(db, {
      rawToken: issued.rawToken,
      sessionSecret: SECRET,
      origin: '198.51.100.4',
      now: 2_001,
    });
    expect(
      db
        .prepare(
          `SELECT r.last_used_at, r.last_origin
           FROM agent_registrations r JOIN agent_credentials c ON c.agent_id=r.id
           WHERE c.id=?`,
        )
        .get(issued.credential.id),
    ).toEqual({
      last_used_at: new Date(2_001).toISOString(),
      last_origin: '198.51.100.4',
    });
    expect(before.last_used_at).not.toBe(new Date(2_001).toISOString());
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

  it('atomically rotates and retires only the selected credential', () => {
    const first = issue('cursor', 1_000);
    const other = issue('claude', 1_000);
    const rotated = rotateMcpAgentCredential(db, {
      credentialId: first.credential.id,
      scopes: first.credential.scopes,
      expiresAt: new Date(70_000).toISOString(),
      sessionSecret: SECRET,
      now: 2_000,
    });
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
        rawToken: rotated.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 2_001,
      }),
    ).toMatchObject({ agentLabel: 'cursor' });
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: other.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 2_001,
      }),
    ).not.toBeNull();
  });

  it('refuses the reserved command-ai label for ordinary agent credentials', () => {
    for (const label of ['command-ai', ' Command-AI ']) {
      expect(() => issue(label)).toThrow(ReservedAssistantLabelError);
    }
  });

  it('issues the assistant credential on the reserved label', () => {
    const issued = createAssistantMcpAgentCredential(db, {
      scopes: ['workspace:read', 'workspace:write'],
      expiresAt: new Date(60_000).toISOString(),
      sessionSecret: SECRET,
      now: 1_000,
    });
    expect(issued.credential.label).toBe('command-ai');
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: issued.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 2_000,
      }),
    ).toMatchObject({ agentLabel: 'command-ai' });
  });

  it('refuses renaming a registration to the reserved assistant label', () => {
    const issued = issue('cursor');
    expect(() => renameMcpAgentRegistration(db, issued.credential.agentId, 'command-ai')).toThrow(
      ReservedAssistantLabelError,
    );
  });

  it('keeps an identical tool-access matrix after migrating workspace:write credentials', () => {
    const toolMatrix = (scopes: readonly McpAgentScope[]) =>
      MCP_TOOL_REGISTRY.filter((tool) => mcpToolAvailable(tool, scopes))
        .map((tool) => tool.name)
        .sort();
    const legacyScopes = ['workspace:read', 'workspace:write'] as const;
    const expandedScopes = [
      'workspace:read',
      'workspace:write',
      'signal:write',
      'settings:write',
      'import:write',
      'drive:sync',
    ] as const;
    const expected = toolMatrix(expandedScopes);
    expect(toolMatrix(legacyScopes)).not.toEqual(expected);

    const agentId = crypto.randomUUID();
    const credentialId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO agent_registrations(id, display_label, created_at, last_used_at, last_origin)
       VALUES(?,?,?,NULL,NULL)`,
    ).run(agentId, 'legacy-agent', new Date(1_000).toISOString());
    db.prepare(
      `INSERT INTO agent_credentials(id, agent_id, token_hash, scopes, issued_at, expires_at, last_used_at, revoked_at)
       VALUES(?,?,?,?,?,?,NULL,NULL)`,
    ).run(
      credentialId,
      agentId,
      'legacy-hash',
      JSON.stringify(legacyScopes),
      new Date(1_000).toISOString(),
      new Date(120_000).toISOString(),
    );

    expect(migrateMcpCredentialWorkspaceWriteScopes(db)).toBe(1);
    expect(migrateMcpCredentialWorkspaceWriteScopes(db)).toBe(0);
    const stored = db
      .prepare('SELECT scopes FROM agent_credentials WHERE id=?')
      .get(credentialId) as {
      scopes: string;
    };
    expect(toolMatrix(JSON.parse(stored.scopes) as McpAgentScope[])).toEqual(expected);
  });

  it('keeps the old credential when replacement issuance fails', () => {
    const first = issue('cursor', 1_000);
    expect(() =>
      rotateMcpAgentCredential(db, {
        credentialId: first.credential.id,
        scopes: first.credential.scopes,
        expiresAt: new Date(1_000).toISOString(),
        sessionSecret: SECRET,
        now: 2_000,
      }),
    ).toThrow('future');
    expect(
      resolveMcpAgentCredential(db, {
        rawToken: first.rawToken,
        sessionSecret: SECRET,
        origin: null,
        now: 2_001,
      }),
    ).not.toBeNull();
  });
});
