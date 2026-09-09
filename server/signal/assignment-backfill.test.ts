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

  it('assigns an untagged post only when the mapping records an explicit project', () => {
    const assignedMapping: SignalAssignmentBackfillMapping = {
      ...mapping,
      targets: [
        ...mapping.targets,
        { campaigns: ['Other campaign'], project: 'Other project', createIfMissing: false },
      ],
      untagged: [
        {
          date: '2026-08-24',
          textStartsWith: 'Explicitly assigned',
          decision: 'ASSIGN',
          project: 'Other project',
          reason: 'Operator reviewed the post.',
        },
      ],
    };

    expect(
      planSignalAssignmentBackfill(assignedMapping, [
        post({
          id: 'post-explicit',
          date: '2026-08-24',
          text: 'Explicitly assigned post',
          campaignNames: [],
        }),
      ]).assignments,
    ).toEqual([{ project: 'Other project', postIds: ['post-explicit'], createIfMissing: false }]);
  });

  it('refuses ambiguous campaigns and duplicate untagged matches', () => {
    const ambiguousMapping: SignalAssignmentBackfillMapping = {
      ...mapping,
      targets: [
        ...mapping.targets,
        { campaigns: ['Other campaign'], project: 'Other project', createIfMissing: false },
      ],
    };
    expect(() =>
      planSignalAssignmentBackfill(ambiguousMapping, [
        post({ campaignNames: ['Clarity Campaign — Wk1', 'Other campaign'] }),
      ]),
    ).toThrow('matches multiple target projects');

    const duplicate = post({
      id: 'post-duplicate',
      date: '2026-08-24',
      text: 'Unmapped post again',
      campaignNames: [],
    });
    expect(() =>
      planSignalAssignmentBackfill(mapping, [
        {
          ...duplicate,
          id: 'post-first',
          text: 'Unmapped post first',
        },
        duplicate,
      ]),
    ).toThrow('matches more than one post');
  });

  it('refuses invalid ranges and explicitly mapped projects that are not targets', () => {
    expect(() => planSignalAssignmentBackfill({ ...mapping, from: '2026-11-01' }, [])).toThrow(
      'starts after it ends',
    );

    const unknownProjectMapping: SignalAssignmentBackfillMapping = {
      ...mapping,
      untagged: [
        {
          date: '2026-08-24',
          textStartsWith: 'Unknown target',
          decision: 'ASSIGN',
          project: 'Missing project',
          reason: 'Operator reviewed the post.',
        },
      ],
    };
    expect(() =>
      planSignalAssignmentBackfill(unknownProjectMapping, [
        post({
          id: 'post-unknown-target',
          date: '2026-08-24',
          text: 'Unknown target post',
          campaignNames: [],
        }),
      ]),
    ).toThrow('names unknown project');

    expect(
      planSignalAssignmentBackfill(mapping, [
        post({ id: 'outside', date: '2026-11-01' }),
        post({ id: 'undated', date: null }),
      ]),
    ).toEqual({ assignments: [], skipped: [], alreadyAssigned: [] });
  });

  it('rejects duplicate targets and incomplete explicit assignment entries', () => {
    expect(() =>
      planSignalAssignmentBackfill(
        {
          ...mapping,
          targets: [...mapping.targets, { ...mapping.targets[0], createIfMissing: true }],
        },
        [],
      ),
    ).toThrow('appears more than once');

    expect(() =>
      planSignalAssignmentBackfill(
        {
          ...mapping,
          untagged: [
            {
              date: '2026-08-24',
              textStartsWith: 'Missing project',
              decision: 'ASSIGN',
              reason: 'No project was recorded.',
            },
          ],
        } as SignalAssignmentBackfillMapping,
        [],
      ),
    ).toThrow('needs a project');
  });
});
