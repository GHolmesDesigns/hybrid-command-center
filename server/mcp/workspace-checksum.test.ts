import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { workspaceDataChecksum } from './workspace-checksum.ts';
import { postHandoff } from '../agent-coordination/service.ts';

let db: Db;

beforeEach(() => {
  db = createDb(':memory:');
});

describe('workspaceDataChecksum', () => {
  it('changes when a workspace table gains a row', () => {
    const before = workspaceDataChecksum(db);
    postHandoff(
      db,
      {
        fromAgentLabel: 'cursor',
        toAgentLabel: null,
        subjectType: 'freeform',
        subjectId: null,
        message: 'Diagnostic row',
      },
      new Date('2026-08-28T12:00:00.000Z'),
    );
    const after = workspaceDataChecksum(db);
    expect(before).not.toBe(after);
  });
});
