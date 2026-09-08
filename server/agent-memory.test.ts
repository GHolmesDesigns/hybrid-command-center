import { describe, expect, it } from 'vitest';
import { createDb } from './db.ts';
import {
  archiveMemory,
  correctMemory,
  deleteMemory,
  listMemory,
  purgeExpiredMemory,
  suggestMemory,
} from './agent-memory.ts';

describe('agent memory', () => {
  it('keeps suggestions distinct, records provenance, and permits operator correction', () => {
    const db = createDb(':memory:');
    const memory = suggestMemory(
      db,
      {
        key: 'release-process',
        value: 'Run the gates first.',
        scope: { type: 'workspace' },
        source: 'handoff-123',
      },
      'codex',
      new Date('2026-09-08T12:00:00Z'),
    );
    expect(memory).toMatchObject({
      state: 'SUGGESTED',
      suggestedBy: 'codex',
      approvedBy: null,
      source: 'handoff-123',
    });
    const approved = correctMemory(
      db,
      memory.id,
      { value: 'Run the finalized-head gates first.' },
      'operator',
      new Date('2026-09-08T12:01:00Z'),
    );
    expect(approved).toMatchObject({
      state: 'APPROVED',
      value: 'Run the finalized-head gates first.',
      approvedBy: 'operator',
    });
  });
  it('enforces entity scopes and refuses credential-shaped content', () => {
    const db = createDb(':memory:');
    expect(() =>
      suggestMemory(
        db,
        { key: 'x', value: 'Bearer abc.def', scope: { type: 'workspace' }, source: 'test' },
        'agent',
      ),
    ).toThrow(/credentials/i);
    expect(() =>
      suggestMemory(
        db,
        { key: 'x', value: 'y', scope: { type: 'project', id: 'missing' }, source: 'test' },
        'agent',
      ),
    ).toThrow(/scope/i);
  });
  it('supports operator removal, archive, filtering, and retention expiry', () => {
    const db = createDb(':memory:');
    const old = suggestMemory(
      db,
      {
        key: 'old',
        value: 'value',
        scope: { type: 'workspace' },
        source: 'test',
        retentionDays: 1,
      },
      'agent',
      new Date('2026-01-01T00:00:00Z'),
    );
    const current = suggestMemory(
      db,
      { key: 'current', value: 'value', scope: { type: 'workspace' }, source: 'test' },
      'agent',
      new Date('2026-09-08T00:00:00Z'),
    );
    expect(purgeExpiredMemory(db, new Date('2026-01-03T00:00:00Z'))).toBe(1);
    expect(listMemory(db).memories.map((x) => x.id)).toEqual([current.id]);
    archiveMemory(db, current.id);
    expect(listMemory(db, { state: 'ARCHIVED' }).memories).toHaveLength(1);
    deleteMemory(db, current.id);
    expect(listMemory(db).memories).toHaveLength(0);
    expect(old.id).toBeTruthy();
  });
});
