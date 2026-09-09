import { z } from 'zod';

const backfillTarget = z.object({
  campaigns: z.array(z.string().min(1)).min(1),
  project: z.string().min(1),
  createIfMissing: z.boolean().default(false),
});

const untaggedDecision = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  textStartsWith: z.string().min(1),
  decision: z.enum(['ASSIGN', 'SKIP']),
  project: z.string().min(1).optional(),
  reason: z.string().min(1),
});

export const signalAssignmentBackfillMapping = z
  .object({
    version: z.literal(1),
    client: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    targets: z.array(backfillTarget).min(1),
    untagged: z.array(untaggedDecision),
  })
  .superRefine((mapping, context) => {
    const projects = new Set<string>();
    for (const target of mapping.targets) {
      if (projects.has(target.project)) {
        context.addIssue({
          code: 'custom',
          message: `Project "${target.project}" appears more than once.`,
          path: ['targets'],
        });
      }
      projects.add(target.project);
    }
    for (const decision of mapping.untagged) {
      if (decision.decision === 'ASSIGN' && !decision.project) {
        context.addIssue({
          code: 'custom',
          message: `Assigned untagged post "${decision.textStartsWith}" needs a project.`,
          path: ['untagged'],
        });
      }
    }
  });

export type SignalAssignmentBackfillMapping = z.output<typeof signalAssignmentBackfillMapping>;

export interface BackfillPost {
  id: string;
  date: string | null;
  text: string;
  projectId: string | null;
  campaignNames: string[];
}

export interface BackfillAssignment {
  project: string;
  postIds: string[];
  createIfMissing: boolean;
}

export interface BackfillSkip {
  postId: string;
  date: string | null;
  text: string;
  reason: string;
}

export interface BackfillPlan {
  assignments: BackfillAssignment[];
  skipped: BackfillSkip[];
  alreadyAssigned: string[];
}

export class SignalAssignmentBackfillError extends Error {}

const targetForCampaign = (mapping: SignalAssignmentBackfillMapping, campaign: string) =>
  mapping.targets.find((target) => target.campaigns.includes(campaign));

/**
 * Plans only the active, in-range posts that still have no project. A post is never assigned from
 * its date: the only fallback for a post without campaigns is an exact, reviewed mapping entry.
 */
export function planSignalAssignmentBackfill(
  mappingInput: SignalAssignmentBackfillMapping,
  posts: BackfillPost[],
): BackfillPlan {
  const mapping = signalAssignmentBackfillMapping.parse(mappingInput);
  if (mapping.from > mapping.to) {
    throw new SignalAssignmentBackfillError('Backfill range starts after it ends.');
  }

  const assignments = new Map<string, BackfillAssignment>();
  const skipped: BackfillSkip[] = [];
  const alreadyAssigned: string[] = [];
  const usedUntagged = new Set<number>();

  for (const post of posts) {
    if (post.date === null || post.date < mapping.from || post.date > mapping.to) {
      continue;
    }
    if (post.projectId !== null) {
      alreadyAssigned.push(post.id);
      continue;
    }

    const campaignTargets = post.campaignNames
      .map((campaign) => targetForCampaign(mapping, campaign))
      .filter((target): target is NonNullable<typeof target> => target !== undefined);
    const distinctProjects = [...new Set(campaignTargets.map((target) => target.project))];
    if (distinctProjects.length > 1) {
      throw new SignalAssignmentBackfillError(
        `Post ${post.id} matches multiple target projects: ${distinctProjects.join(', ')}.`,
      );
    }

    if (distinctProjects.length === 0) {
      const decisionIndex = mapping.untagged.findIndex(
        (decision) => decision.date === post.date && post.text.startsWith(decision.textStartsWith),
      );
      if (decisionIndex === -1) {
        throw new SignalAssignmentBackfillError(
          `Post ${post.id} has no campaign mapping or explicit untagged decision.`,
        );
      }
      if (usedUntagged.has(decisionIndex)) {
        throw new SignalAssignmentBackfillError(
          `Untagged mapping "${mapping.untagged[decisionIndex]?.textStartsWith}" matches more than one post.`,
        );
      }
      usedUntagged.add(decisionIndex);
      const decision = mapping.untagged[decisionIndex];
      if (decision?.decision === 'SKIP') {
        skipped.push({
          postId: post.id,
          date: post.date,
          text: post.text,
          reason: decision.reason,
        });
        continue;
      }
      const target = mapping.targets.find((candidate) => candidate.project === decision.project);
      if (!target) {
        throw new SignalAssignmentBackfillError(
          `Untagged mapping for ${post.id} names unknown project "${decision.project}".`,
        );
      }
      const current = assignments.get(target.project) ?? {
        project: target.project,
        postIds: [],
        createIfMissing: target.createIfMissing,
      };
      current.postIds.push(post.id);
      assignments.set(target.project, current);
      continue;
    }

    const target = campaignTargets[0] as NonNullable<(typeof campaignTargets)[number]>;
    const current = assignments.get(target.project) ?? {
      project: target.project,
      postIds: [],
      createIfMissing: target.createIfMissing,
    };
    current.postIds.push(post.id);
    assignments.set(target.project, current);
  }

  return {
    assignments: [...assignments.values()],
    skipped,
    alreadyAssigned,
  };
}
