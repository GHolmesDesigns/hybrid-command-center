/**
 * The client merge planner: pure validation and one canonical plan, used for the preview and
 * again inside the commit's transaction. It reads no database and calls no Drive method — the
 * workspace it plans against is read for it in `server/client-merge.ts`, the same shape the
 * import planner takes its snapshot in.
 *
 * The plan hashes to a value the browser sends back on confirmation. If a project was added,
 * removed, renamed, or reassigned between the preview and the confirmation, or if either client
 * was renamed or archived, the hash no longer matches and the commit is refused rather than
 * writing a merge nobody was shown.
 */
import crypto from 'node:crypto';
import type { ClientMergeProject } from '../../shared/client-merge.ts';

/** A client as the merge rules need to see it, merge alias included. */
export interface MergeWorkspaceClient {
  id: string;
  name: string;
  status: string;
  /** The client this one was merged into, when it is already a merge source. */
  mergedIntoId?: string;
}

export interface MergeWorkspaceProject {
  id: string;
  clientId: string;
  name: string;
  status: string;
}

export interface ClientMergeWorkspace {
  clients: MergeWorkspaceClient[];
  projects: MergeWorkspaceProject[];
}

/** A validation refusal, carrying the status the HTTP boundary answers with. */
export class ClientMergeError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClientMergeError';
    this.status = status;
  }
}

/** One planned merge. Everything the hash covers, and nothing else. */
export interface ClientMergePlan {
  source: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED' };
  destination: { id: string; name: string; status: 'ACTIVE' | 'ARCHIVED' };
  projects: ClientMergeProject[];
}

const party = (client: MergeWorkspaceClient) => ({
  id: client.id,
  name: client.name,
  status: client.status === 'ARCHIVED' ? ('ARCHIVED' as const) : ('ACTIVE' as const),
});

/**
 * Validates the pair and describes the merge they would produce.
 *
 * A source may be active or archived — a duplicate is usually archived already — but it may not
 * itself have been merged away, because that alias would then have to point two ways. A
 * destination must be a live, unmerged client: merging into an archived or merged-away client
 * would bury the work that was just consolidated.
 */
export function buildClientMergePlan(
  workspace: ClientMergeWorkspace,
  sourceId: string,
  destinationId: string,
): ClientMergePlan {
  if (sourceId === destinationId)
    throw new ClientMergeError('A client cannot be merged into itself.', 400);
  const source = workspace.clients.find((client) => client.id === sourceId);
  if (!source) throw new ClientMergeError('Client not found.', 404);
  const destination = workspace.clients.find((client) => client.id === destinationId);
  if (!destination) throw new ClientMergeError('Destination client not found.', 404);
  if (source.mergedIntoId)
    throw new ClientMergeError(
      `“${source.name}” has already been merged into another client.`,
      409,
    );
  if (destination.mergedIntoId)
    throw new ClientMergeError(
      `“${destination.name}” has already been merged into another client, so it cannot receive one.`,
      409,
    );
  if (destination.status !== 'ACTIVE')
    throw new ClientMergeError('Choose an active destination client.', 409);
  return {
    source: party(source),
    destination: party(destination),
    // Sorted by id so the same workspace always hashes the same way, whatever order the rows
    // came back in. Every status is included: archived and complete projects move too.
    projects: workspace.projects
      .filter((project) => project.clientId === sourceId)
      .map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status as ClientMergeProject['status'],
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * The plan's digest. Taken over the plan itself rather than over a second description of it,
 * so a field added to the plan is covered by the staleness check without a second edit.
 */
export function clientMergePlanHash(plan: ClientMergePlan): string {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
