import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import mappingJson from '../signal-assignment-backfill.json' with { type: 'json' };
import { getDb } from '../db.ts';
import { createProject } from '../workspace/writes.ts';
import { createMcpSession } from '../mcp/session.ts';
import { callWorkspaceWriteTool } from '../mcp/workspace-write.ts';
import {
  planSignalAssignmentBackfill,
  signalAssignmentBackfillMapping,
  type BackfillPost,
  type SignalAssignmentBackfillMapping,
} from '../signal/assignment-backfill.ts';

const mapping = signalAssignmentBackfillMapping.parse(
  mappingJson,
) as SignalAssignmentBackfillMapping;
const commit = process.argv.includes('--commit');
const confirmed = process.argv.includes('--yes');

type ProjectTarget = {
  clientId: string;
  projectId: string | null;
  createIfMissing: boolean;
};

function loadPosts(db: ReturnType<typeof getDb>): BackfillPost[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.date, p.text, p.project_id,
              GROUP_CONCAT(sc.name, char(31)) AS campaign_names
         FROM signal_posts p
         LEFT JOIN signal_post_campaigns spc ON spc.post_id = p.id
         LEFT JOIN signal_campaigns sc ON sc.id = spc.campaign_id
        WHERE p.lifecycle = 'ACTIVE'
        GROUP BY p.id
        ORDER BY p.date, p.id`,
    )
    .all() as {
    id: string;
    date: string | null;
    text: string;
    project_id: string | null;
    campaign_names: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    date: row.date,
    text: row.text,
    projectId: row.project_id,
    campaignNames: row.campaign_names ? row.campaign_names.split(String.fromCharCode(31)) : [],
  }));
}

function resolveClient(db: ReturnType<typeof getDb>): string {
  const clients = db
    .prepare("SELECT id FROM clients WHERE name=? COLLATE NOCASE AND status='ACTIVE'")
    .all(mapping.client) as { id: string }[];
  if (clients.length !== 1) {
    throw new Error(
      `Expected exactly one active client named "${mapping.client}", found ${clients.length}.`,
    );
  }
  return clients[0].id;
}

function resolveTargets(
  db: ReturnType<typeof getDb>,
  clientId: string,
): Map<string, ProjectTarget> {
  const targets = new Map<string, ProjectTarget>();
  for (const target of mapping.targets) {
    const projects = db
      .prepare(
        `SELECT id FROM projects
          WHERE client_id=? AND name=? COLLATE NOCASE AND status <> 'COMPLETE'`,
      )
      .all(clientId, target.project) as { id: string }[];
    if (projects.length > 1) {
      throw new Error(`Project "${target.project}" is duplicated for client "${mapping.client}".`);
    }
    if (projects.length === 0 && !target.createIfMissing) {
      throw new Error(`Required project "${target.project}" does not exist.`);
    }
    targets.set(target.project, {
      clientId,
      projectId: projects[0]?.id ?? null,
      createIfMissing: target.createIfMissing,
    });
  }
  return targets;
}

function createMissingProjects(
  db: ReturnType<typeof getDb>,
  targets: Map<string, ProjectTarget>,
): void {
  for (const [name, target] of targets) {
    if (target.projectId || !target.createIfMissing) continue;
    const project = createProject(db, { clientId: target.clientId, name });
    target.projectId = project.id;
    console.log(`Created project: ${name} (${project.id})`);
  }
}

function printPlan(
  plan: ReturnType<typeof planSignalAssignmentBackfill>,
  targets: Map<string, ProjectTarget>,
): void {
  console.log(`Signal assignment backfill ${mapping.from} through ${mapping.to}`);
  console.log(
    `Assignments: ${plan.assignments.reduce((count, item) => count + item.postIds.length, 0)}`,
  );
  console.log(`Already assigned and untouched: ${plan.alreadyAssigned.length}`);
  console.log(`Explicitly skipped: ${plan.skipped.length}`);
  for (const assignment of plan.assignments) {
    const target = targets.get(assignment.project);
    console.log(
      `  ${assignment.project}${target?.projectId ? ` (${target.projectId})` : ' [would create project]'}: ${assignment.postIds.length} post(s)`,
    );
    for (const postId of assignment.postIds) console.log(`    ${postId}`);
  }
  for (const skipped of plan.skipped) {
    console.log(`  SKIP ${skipped.postId}: ${skipped.reason}`);
  }
}

async function confirmCommit(): Promise<void> {
  if (!commit) return;
  if (confirmed) return;
  const rl = createInterface({ input, output });
  const answer = await rl.question('Type COMMIT to apply this assignment: ');
  rl.close();
  if (answer.trim() !== 'COMMIT')
    throw new Error('Confirmation not received; nothing was written.');
}

async function main(): Promise<void> {
  const db = getDb();
  try {
    const clientId = resolveClient(db);
    const targets = resolveTargets(db, clientId);
    const plan = planSignalAssignmentBackfill(mapping, loadPosts(db));
    printPlan(plan, targets);
    await confirmCommit();
    if (!commit) {
      console.log('Dry run only; no workspace assignment or project creation was performed.');
      return;
    }

    createMissingProjects(db, targets);
    const session = createMcpSession({ agentLabel: 'signal-assignment-backfill' });
    for (const assignment of plan.assignments) {
      const target = targets.get(assignment.project);
      if (!target?.projectId)
        throw new Error(`Project "${assignment.project}" could not be resolved.`);
      const result = await callWorkspaceWriteTool(db, session, 'signal_assign_posts', {
        clientRequestId: `signal-581-${assignment.project.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        clientId,
        projectId: target.projectId,
        postIds: assignment.postIds,
      });
      if (result.outcome !== 'SUCCESS') {
        throw new Error(
          `signal_assign_posts refused "${assignment.project}": ${result.error ?? 'unknown error'}`,
        );
      }
      console.log(`Assigned ${assignment.postIds.length} post(s) to ${assignment.project}.`);
    }
    console.log(
      'Backfill committed. A repeated run will report already-assigned posts as unchanged.',
    );
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
