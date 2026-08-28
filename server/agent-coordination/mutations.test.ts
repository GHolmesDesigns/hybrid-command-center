import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { postHandoff } from './service.ts';
import { AGENT_HANDOFF_MUTATION_LIMIT, recordHandoffMutation } from './mutations.ts';

let db: Db;
const NOW = new Date('2026-08-26T15:00:00.000Z');

beforeEach(() => {
  db = createDb(':memory:');
});

describe('agent_handoff_mutations retention', () => {
  it('prunes oldest replay keys once the table exceeds the limit', () => {
    const handoff = postHandoff(
      db,
      {
        fromAgentLabel: 'cursor',
        subjectType: 'freeform',
        message: 'Retention fixture.',
      },
      NOW,
    );
    for (let i = 0; i < AGENT_HANDOFF_MUTATION_LIMIT + 5; i += 1) {
      recordHandoffMutation(db, {
        agentLabel: 'cursor',
        clientRequestId: `req-${i}`,
        tool: 'coordination_add_note',
        handoffId: handoff.id,
        resultKind: 'note',
        resultId: `note-${i}`,
        at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      });
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM agent_handoff_mutations').get() as {
      n: number;
    };
    expect(count.n).toBe(AGENT_HANDOFF_MUTATION_LIMIT);
    const oldest = db
      .prepare(
        'SELECT client_request_id FROM agent_handoff_mutations ORDER BY created_at ASC, rowid ASC LIMIT 1',
      )
      .get() as { client_request_id: string };
    expect(oldest.client_request_id).toBe('req-5');
  });
});
