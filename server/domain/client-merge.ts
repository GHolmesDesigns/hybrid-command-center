/**
 * The client merge planner: pure validation and one canonical plan, used for the preview and
 * again inside the commit's transaction. It reads no database and calls no Drive method — the
 * workspace it plans against is read for it in `server/client-merge.ts`, the same shape the
 * import planner takes its snapshot in.
 *
 * The plan hashes to a value the browser sends back on confirmation. If a project was added,
 * removed, renamed, or reassigned between the preview and the confirmation, if either client was
 * renamed or archived, or if a field either record holds changed underneath a choice made about
 * it, the hash no longer matches and the commit is refused rather than writing a merge nobody
 * was shown.
 */
import crypto from 'node:crypto';
import type {
  ClientMergeAlias,
  ClientMergeField,
  ClientMergeFieldPlan,
  ClientMergeProject,
  ClientMergeSelections,
} from '../../shared/client-merge.ts';
import { CLIENT_MERGE_FIELDS, clientMergeFieldValues } from '../../shared/client-merge.ts';
import { buildClientSlug } from './client-slugs.ts';

/**
 * A client as the merge rules need to see it: the pair's identity, the merge alias, and the six
 * fields a merge chooses between, which are exactly the properties named in `CLIENT_MERGE_FIELDS`.
 * `slug` is here to be derived from the surviving name, never to be chosen; no `drive_*` column
 * is here at all, because nothing on this path may read or write one.
 */
export interface MergeWorkspaceClient {
  id: string;
  name: string;
  slug: string;
  status: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  /** The client this one was merged into, when it is already a merge source. */
  mergedIntoId?: string;
}

export interface MergeWorkspaceProject {
  id: string;
  clientId: string;
  name: string;
  status: string;
}

/** A source identity as `client_import_aliases` stores it, for the client it is recorded against. */
export interface MergeWorkspaceAlias {
  namespace: string;
  externalId: string;
  clientId: string;
}

export interface ClientMergeWorkspace {
  clients: MergeWorkspaceClient[];
  projects: MergeWorkspaceProject[];
  clientAliases: MergeWorkspaceAlias[];
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
  /**
   * The source identities the merge retargets. Part of the plan, so `clientMergePlanHash` covers
   * them: an identity attached to either client between the preview and the confirmation changes
   * what the merge would do, and a confirmation always applies to the merge that was shown.
   */
  aliases: ClientMergeAlias[];
  /**
   * Each choosable field with both records' current values and the value the survivor keeps.
   * In the plan for the same reason the aliases are: the hash then covers every selected value
   * *and* the two values it was selected between, so a contact detail edited on either client
   * after the preview refuses the confirmation instead of being silently planned around.
   */
  fields: ClientMergeFieldPlan[];
  /** The survivor's slug, derived from the name it keeps rather than chosen. */
  slug: { current: string; next: string };
}

const party = (client: MergeWorkspaceClient) => ({
  id: client.id,
  name: client.name,
  status: client.status === 'ARCHIVED' ? ('ARCHIVED' as const) : ('ACTIVE' as const),
});

/**
 * One field's outcome. A blank value on either side is a value like any other: it is offered,
 * and it wins only when it is chosen. Nothing here looks at whether a value is filled in, which
 * is what keeps `DESTINATION` the default for a blank destination beside a filled-in source.
 */
function resolveField(
  field: ClientMergeField,
  source: MergeWorkspaceClient,
  destination: MergeWorkspaceClient,
  selections: ClientMergeSelections,
): ClientMergeFieldPlan {
  const destinationValue = destination[field] ?? null;
  const sourceValue = source[field] ?? null;
  const selection = selections[field];
  const choice = selection?.choice ?? 'DESTINATION';
  const value =
    choice === 'SOURCE'
      ? sourceValue
      : choice === 'CUSTOM'
        ? (selection?.value ?? null)
        : destinationValue;
  if (field === 'name' && !value)
    throw new ClientMergeError('The client you keep needs a name.', 400);
  return { field, destination: destinationValue, source: sourceValue, choice, value };
}

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
  selections: ClientMergeSelections = {},
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
  const fields = CLIENT_MERGE_FIELDS.map(({ key }) =>
    resolveField(key, source, destination, selections),
  );
  /**
   * The slug decision this card had to make, made here and nowhere else: the survivor's slug
   * follows the name it ends up with. Keeping the destination's name keeps its slug untouched;
   * any other surviving name rebuilds it from that name and the destination's own id, which is
   * exactly what `PATCH /api/clients/:id` does when a client is renamed. A slug that contradicts
   * the name it is derived from would be a state nothing else in the workspace can produce, and
   * the slug addresses nothing — every route, link, and lookup goes by id — so rebuilding it
   * changes no address anybody holds.
   */
  const survivingName = clientMergeFieldValues(fields).name ?? destination.name;
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
    // Sorted for the same reason the projects are, over the pair that identifies one.
    aliases: workspace.clientAliases
      .filter((alias) => alias.clientId === sourceId)
      .map((alias) => ({ namespace: alias.namespace, externalId: alias.externalId }))
      .sort(
        (a, b) =>
          a.namespace.localeCompare(b.namespace) || a.externalId.localeCompare(b.externalId),
      ),
    fields,
    slug: {
      current: destination.slug,
      next:
        survivingName === destination.name
          ? destination.slug
          : buildClientSlug(survivingName, destination.id),
    },
  };
}

/**
 * The plan's digest. Taken over the plan itself rather than over a second description of it,
 * so a field added to the plan is covered by the staleness check without a second edit.
 */
export function clientMergePlanHash(plan: ClientMergePlan): string {
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}
