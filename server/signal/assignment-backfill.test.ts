import { describe, expect, it } from 'vitest';
import {
  planSignalAssignmentBackfill,
  type BackfillPost,
  type SignalAssignmentBackfillMapping,
} from './assignment-backfill.ts';

const mapping: SignalAssignmentBackfillMapping = {
  version: 1,
  client: 'G.Holmes Designs',
  from: '2026-08-01',
  to: '2026-10-31',
  targets: [
    {
      campaigns: ['Clarity Campaign — Wk1'],
      project: 'Six Weeks of Clarity — Week 1',
      createIfMissing: true,
    },
  ],
  untagged: [
    {
      date: '2026-08-24',
      textStartsWith: 'Unmapped post',
      decision: 'SKIP',
      reason: 'No operator decision.',
    },
  ],
};

const post = (overrides: Partial<BackfillPost> = {}): BackfillPost => ({
  id: 'post-1',
  date: '2026-08-25',
  text: 'Mapped post',
  projectId: null,
  campaignNames: ['Clarity Campaign — Wk1'],
  ...overrides,
});

describe('Signal assignment backfill planner', () => {
  it('groups only unassigned campaign posts and leaves assigned posts untouched', () => {
    const plan = planSignalAssignmentBackfill(mapping, [
      post(),
      post({ id: 'post-2', projectId: 'existing-project' }),
    ]);

    expect(plan.assignments).toEqual([
      {
        project: 'Six Weeks of Clarity — Week 1',
        postIds: ['post-1'],
        createIfMissing: true,
      },
    ]);
    expect(plan.alreadyAssigned).toEqual(['post-2']);
    expect(plan.skipped).toEqual([]);
  });

  it('records an explicit skip for an untagged post instead of using date adjacency', () => {
    const plan = planSignalAssignmentBackfill(mapping, [
      post({
        id: 'post-untagged',
        date: '2026-08-24',
        text: 'Unmapped post is beside Week 1',
        campaignNames: [],
      }),
    ]);

    expect(plan.assignments).toEqual([]);
    expect(plan.skipped).toEqual([
      {
        postId: 'post-untagged',
        date: '2026-08-24',
        text: 'Unmapped post is beside Week 1',
        reason: 'No operator decision.',
      },
    ]);
  });

  it('refuses a post that has neither a campaign mapping nor an explicit decision', () => {
    expect(() =>
      planSignalAssignmentBackfill(mapping, [
        post({ id: 'post-unknown', campaignNames: [], text: 'No mapping here' }),
      ]),
    ).toThrow('has no campaign mapping or explicit untagged decision');
  });
});
