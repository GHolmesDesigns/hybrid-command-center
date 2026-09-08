import { describe, expect, it } from 'vitest';
import { agentMemoryInputSchema } from './agent-memory.ts';

describe('agent memory schema', () => {
  it('requires identifiers for non-workspace scopes', () => {
    for (const type of ['client', 'project', 'task'] as const) {
      expect(() =>
        agentMemoryInputSchema.parse({
          key: 'k',
          value: 'v',
          source: 's',
          scope: { type },
        }),
      ).toThrow('A scoped memory record requires an id.');
    }
    expect(
      agentMemoryInputSchema.parse({
        key: ' k ',
        value: ' v ',
        source: ' s ',
        scope: { type: 'workspace' },
      }),
    ).toMatchObject({ key: 'k', value: 'v', source: 's' });
  });
});
