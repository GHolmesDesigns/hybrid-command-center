import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { listMcpAgentEvents } from './events.ts';
import { callCoordinationTool } from './coordination.ts';
import { readCoordinationResource } from './resources.ts';
import { redactToolResult } from './redact.ts';
import { createMcpSession } from './session.ts';
import { COORDINATION_WRITE_LIMIT_PER_MINUTE } from '../../shared/mcp-agent-events.ts';

let db: Db;
const NOW = new Date('2026-08-26T16:00:00.000Z');

beforeEach(() => {
  db = createDb(':memory:');
});

const labeled = (label = 'cursor') => createMcpSession({ agentLabel: label });

describe('coordination MCP tools', () => {
  it('maps each write tool to the handoff service and honours client_request_id idempotency', () => {
    const session = labeled('cursor');
    const first = callCoordinationTool(
      db,
      session,
      'coordination_post_handoff',
      {
        subjectType: 'freeform',
        message: 'Please review this caption.',
        clientRequestId: 'req-1',
      },
      NOW,
    );
    expect(first.outcome).toBe('SUCCESS');
    const id = (first.data as { id: string }).id;

    const second = callCoordinationTool(
      db,
      session,
      'coordination_post_handoff',
      {
        subjectType: 'freeform',
        message: 'Different text that must not insert.',
        clientRequestId: 'req-1',
      },
      NOW,
    );
    expect(second.outcome).toBe('SUCCESS');
    expect((second.data as { id: string }).id).toBe(id);
    expect((second.data as { message: string }).message).toBe('Please review this caption.');

    const listed = callCoordinationTool(db, session, 'coordination_list_handoffs', {}, NOW);
    expect(listed.outcome).toBe('SUCCESS');
    expect(listed.data).toHaveLength(1);

    const events = listMcpAgentEvents(db, { tool: 'coordination_post_handoff' });
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.outcome === 'SUCCESS')).toBe(true);
  });

  it('refuses a directed claim for the wrong label and allows open-pool first claim', () => {
    const poster = labeled('cursor');
    const directed = callCoordinationTool(
      db,
      poster,
      'coordination_post_handoff',
      {
        toAgentLabel: 'claude',
        subjectType: 'task',
        subjectId: 'task-1',
        message: 'Take this task.',
      },
      NOW,
    );
    const directedId = (directed.data as { id: string }).id;

    const wrong = callCoordinationTool(
      db,
      labeled('other'),
      'coordination_claim_handoff',
      { handoffId: directedId },
      NOW,
    );
    expect(wrong).toMatchObject({
      outcome: 'REFUSED',
      error: expect.stringMatching(/Only claude/),
    });
    expect(listMcpAgentEvents(db, { tool: 'coordination_claim_handoff' })[0]?.outcome).toBe(
      'REFUSED',
    );

    const right = callCoordinationTool(
      db,
      labeled('claude'),
      'coordination_claim_handoff',
      { handoffId: directedId },
      NOW,
    );
    expect(right.outcome).toBe('SUCCESS');
    expect(right.data).toMatchObject({ state: 'CLAIMED', claimedBy: 'claude' });

    const pool = callCoordinationTool(
      db,
      poster,
      'coordination_post_handoff',
      { subjectType: 'freeform', message: 'Open pool work.' },
      NOW,
    );
    const poolId = (pool.data as { id: string }).id;
    const firstClaim = callCoordinationTool(
      db,
      labeled('alpha'),
      'coordination_claim_handoff',
      { handoffId: poolId },
      NOW,
    );
    expect(firstClaim.outcome).toBe('SUCCESS');
    const secondClaim = callCoordinationTool(
      db,
      labeled('beta'),
      'coordination_claim_handoff',
      { handoffId: poolId },
      NOW,
    );
    expect(secondClaim.outcome).toBe('REFUSED');
  });

  it('allows reads without agent_label and refuses coordination writes', () => {
    const writer = labeled('cursor');
    const posted = callCoordinationTool(
      db,
      writer,
      'coordination_post_handoff',
      { subjectType: 'freeform', message: 'Visible to readers.' },
      NOW,
    );
    const handoffId = (posted.data as { id: string }).id;

    const reader = createMcpSession();
    expect(reader.agentLabel).toBeNull();
    const listed = callCoordinationTool(db, reader, 'coordination_list_handoffs', {}, NOW);
    expect(listed.outcome).toBe('SUCCESS');
    expect(listed.data).toHaveLength(1);

    const got = callCoordinationTool(db, reader, 'coordination_get_handoff', { handoffId }, NOW);
    expect(got.outcome).toBe('SUCCESS');

    const refused = callCoordinationTool(
      db,
      reader,
      'coordination_claim_handoff',
      { handoffId },
      NOW,
    );
    expect(refused).toMatchObject({
      outcome: 'REFUSED',
      error: expect.stringMatching(/agent_label/),
    });
    expect(
      listMcpAgentEvents(db, { tool: 'coordination_claim_handoff' }).some(
        (event) => event.outcome === 'REFUSED',
      ),
    ).toBe(true);
  });

  it('refuses excess coordination writes with REFUSED in mcp_agent_events', () => {
    const session = labeled('cursor');
    const base = NOW.getTime();
    for (let i = 0; i < COORDINATION_WRITE_LIMIT_PER_MINUTE; i += 1) {
      const result = callCoordinationTool(
        db,
        session,
        'coordination_post_handoff',
        { subjectType: 'freeform', message: `Burst ${i}` },
        new Date(base + i),
      );
      expect(result.outcome).toBe('SUCCESS');
    }
    const over = callCoordinationTool(
      db,
      session,
      'coordination_post_handoff',
      { subjectType: 'freeform', message: 'One too many' },
      new Date(base + COORDINATION_WRITE_LIMIT_PER_MINUTE),
    );
    expect(over).toMatchObject({
      outcome: 'REFUSED',
      error: expect.stringMatching(/rate limit/i),
    });
    const refused = listMcpAgentEvents(db).filter(
      (event) => event.outcome === 'REFUSED' && event.summary.includes('rate limit'),
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
  });

  it('redacts credential-shaped strings from tool results', () => {
    const session = labeled('cursor');
    // Service redacts on write; result redaction is a second belt for any string payload.
    const posted = callCoordinationTool(
      db,
      session,
      'coordination_post_handoff',
      {
        subjectType: 'freeform',
        message: 'Use the public docs link only.',
      },
      NOW,
    );
    expect(posted.outcome).toBe('SUCCESS');
    const leaked = redactToolResult({
      message: 'api_key=sk-live-secret-value',
      nested: { token: 'Bearer ya29.example-token' },
    });
    expect(JSON.stringify(leaked)).not.toMatch(/sk-live-secret-value/);
    expect(JSON.stringify(leaked)).not.toMatch(/ya29\.example-token/);
    expect(JSON.stringify(leaked)).toMatch(/\[redacted\]/);
  });

  it('refuses fromAgentLabel that does not match the session label', () => {
    const session = labeled('cursor');
    const result = callCoordinationTool(
      db,
      session,
      'coordination_post_handoff',
      {
        fromAgentLabel: 'other',
        subjectType: 'freeform',
        message: 'Should not post.',
      },
      NOW,
    );
    expect(result.outcome).toBe('REFUSED');
    expect(result.error).toMatch(/from_agent_label/);
  });

  it('completes, cancels, notes, and serves the inbox resource', () => {
    const poster = labeled('cursor');
    const posted = callCoordinationTool(
      db,
      poster,
      'coordination_post_handoff',
      { subjectType: 'freeform', message: 'Lifecycle check.' },
      NOW,
    );
    const handoffId = (posted.data as { id: string }).id;
    const claimer = labeled('claude');
    expect(
      callCoordinationTool(db, claimer, 'coordination_claim_handoff', { handoffId }, NOW).outcome,
    ).toBe('SUCCESS');
    expect(
      callCoordinationTool(
        db,
        claimer,
        'coordination_add_note',
        { handoffId, body: 'Working on it.' },
        NOW,
      ).outcome,
    ).toBe('SUCCESS');

    const inbox = readCoordinationResource(db, 'hcc://coordination/inbox?state=open');
    const parsed = JSON.parse(inbox.text) as { handoffs: Array<{ id: string; state: string }> };
    expect(parsed.handoffs.some((row) => row.id === handoffId && row.state === 'CLAIMED')).toBe(
      true,
    );

    expect(
      callCoordinationTool(db, claimer, 'coordination_complete_handoff', { handoffId }, NOW)
        .outcome,
    ).toBe('SUCCESS');

    const other = callCoordinationTool(
      db,
      poster,
      'coordination_post_handoff',
      { subjectType: 'freeform', message: 'To cancel.' },
      NOW,
    );
    const cancelId = (other.data as { id: string }).id;
    expect(
      callCoordinationTool(
        db,
        poster,
        'coordination_cancel_handoff',
        { handoffId: cancelId, reason: 'No longer needed.' },
        NOW,
      ).outcome,
    ).toBe('SUCCESS');
  });
});
