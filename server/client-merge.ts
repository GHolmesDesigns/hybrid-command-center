/**
 * Merging one client into another: read the workspace, plan, and write once.
 *
 * The shape follows the playbook import beside it. The rules live in
 * `server/domain/client-merge.ts` and everything that needs the database is here, with two
 * properties the module exists for:
 *
 * - **The plan is never trusted from the browser.** A commit re-reads the workspace inside its
 *   own transaction and re-plans, so the write is decided by the same code that produced the
 *   preview, against the workspace as it stands at the moment of the write. A plan that no
 *   longer matches the confirmed one is refused with a 409 rather than written.
 * - **One transaction.** The projects, the archived source, the destination's stamp, the
 *   retargeted aliases, and the new alias row land together or not at all.
 *
 * No `DriveProvider` method is called from here. `drive_folder_id`, `drive_folder_url`, and the
 * `drive_steps` rows stay on the projects that carry them, so Files still opens the same folders
 * after a merge and the source client's own folder is left where it is.
 *
 * No `integration_events` row is written either: this is a local workspace operation, like
 * archiving a project, and the activity log is for what an *integration* did.
 */
import type { Db } from './db.ts';
import { transaction } from './db.ts';
import {
  ClientMergeError,
  buildClientMergePlan,
  clientMergePlanHash,
  type ClientMergePlan,
  type ClientMergeWorkspace,
  type MergeWorkspaceAlias,
  type MergeWorkspaceClient,
  type MergeWorkspaceProject,
} from './domain/client-merge.ts';
import type { ClientMergePreview, ClientMergeResult } from '../shared/client-merge.ts';

const now = () => new Date().toISOString();

/**
 * The clients, projects, and import identities the merge rules compare, read in three statements.
 * Archived records are included on both sides: an archived duplicate is the ordinary source, and
 * its archived projects move with the rest.
 */
export function readMergeWorkspace(db: Db): ClientMergeWorkspace {
  const clients = (
    db
      .prepare(
        `SELECT c.id, c.name, c.status, m.surviving_client_id mergedIntoId
         FROM clients c LEFT JOIN client_merges m ON m.source_client_id = c.id`,
      )
      .all() as unknown as (MergeWorkspaceClient & { mergedIntoId: string | null })[]
  ).map(({ mergedIntoId, ...client }) => ({
    ...client,
    ...(mergedIntoId ? { mergedIntoId } : {}),
  }));
  return {
    clients,
    projects: db
      .prepare('SELECT id, client_id clientId, name, status FROM projects')
      .all() as unknown as MergeWorkspaceProject[],
    clientAliases: db
      .prepare(
        `SELECT source_namespace namespace, external_id externalId, client_id clientId
         FROM client_import_aliases`,
      )
      .all() as unknown as MergeWorkspaceAlias[],
  };
}

const toPreview = (plan: ClientMergePlan): ClientMergePreview => ({
  source: plan.source,
  destination: plan.destination,
  projects: plan.projects,
  aliases: plan.aliases,
  planHash: clientMergePlanHash(plan),
});

/** The dry run. Reads the workspace, validates the pair, and writes nothing at all. */
export function previewClientMerge(
  db: Db,
  sourceId: string,
  destinationId: string,
): ClientMergePreview {
  return toPreview(buildClientMergePlan(readMergeWorkspace(db), sourceId, destinationId));
}

/**
 * Performs the merge the confirmed plan describes, or refuses it.
 *
 * The plan is rebuilt inside the transaction, after `BEGIN IMMEDIATE` has taken the write lock,
 * so nothing can change between the check and the write. A thrown error rolls the whole thing
 * back and leaves both clients and every project exactly as they were.
 *
 * A source with no projects is a valid merge: it still archives the source and records the
 * alias, which is the half of the operation that matters for a duplicate nobody ever used.
 */
export function commitClientMerge(
  db: Db,
  sourceId: string,
  destinationId: string,
  expectedHash: string,
): ClientMergeResult {
  return transaction(db, () => {
    const plan = buildClientMergePlan(readMergeWorkspace(db), sourceId, destinationId);
    if (clientMergePlanHash(plan) !== expectedHash)
      throw new ClientMergeError(
        'These clients changed since this merge was previewed. Review the new preview before merging.',
        409,
      );
    const stamp = now();
    /**
     * The projects move by client id alone. `updated_at`, `last_activity_at`, `position`, and
     * every Drive column are deliberately left alone — the work did not change, its owner did —
     * and the tasks, checklists, dependencies, categories, and `drive_steps` rows beneath each
     * project follow the project id without being touched.
     */
    db.prepare('UPDATE projects SET client_id=? WHERE client_id=?').run(destinationId, sourceId);
    // Stamped even when the source was already archived: being merged is a change to it.
    db.prepare("UPDATE clients SET status='ARCHIVED', updated_at=? WHERE id=?").run(
      stamp,
      sourceId,
    );
    // The destination's portfolio changed, so its record did. Its own fields still win.
    db.prepare('UPDATE clients SET updated_at=? WHERE id=?').run(stamp, destinationId);
    /**
     * Aliases that pointed at the source now point past it. Merging A into B and then B into C
     * leaves A pointing at C, so resolving a merged name is always one hop and never a chain.
     */
    db.prepare('UPDATE client_merges SET surviving_client_id=? WHERE surviving_client_id=?').run(
      destinationId,
      sourceId,
    );
    /**
     * The source's import identities follow its work. One statement covers every one of them, and
     * one hop is all it ever is: the identity now names the client that holds the projects, so a
     * later playbook resolves it there directly rather than through the archived source.
     *
     * It cannot collide with an identity the destination already carries. The pair is unique across
     * the table, so an identity exists against exactly one client and there is no second row here
     * for this one to run into.
     */
    db.prepare('UPDATE client_import_aliases SET client_id=? WHERE client_id=?').run(
      destinationId,
      sourceId,
    );
    db.prepare(
      'INSERT INTO client_merges(source_client_id,surviving_client_id,merged_at) VALUES(?,?,?)',
    ).run(sourceId, destinationId, stamp);
    return {
      source: { ...plan.source, status: 'ARCHIVED' as const },
      destination: plan.destination,
      projects: plan.projects,
      aliases: plan.aliases,
      movedProjectCount: plan.projects.length,
      mergedAt: stamp,
    };
  });
}

/** Whether this client has been merged away, which is what the guards on other routes ask. */
export function isMergedSource(db: Db, clientId: string): boolean {
  return Boolean(
    db.prepare('SELECT source_client_id FROM client_merges WHERE source_client_id=?').get(clientId),
  );
}
