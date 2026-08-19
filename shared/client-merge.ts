/**
 * Merging one client into another: the payload types the preview and the commit answer with,
 * and the statements the confirmation dialog has to make before either happens.
 *
 * A merge is a local workspace operation. It moves every project of the source client to the
 * destination, archives the source, and records the source as an alias of the destination so a
 * later playbook import resolves the old name to the surviving client. Any import identity the
 * source carried moves with the work, for the same reason and to the same end. It moves no Drive
 * folder, combines no contact field, and cannot be undone in the app.
 */
import type { Project } from './types.ts';

/** One side of a merge, as the dialog names it. */
export interface ClientMergeParty {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
}

/** One project the merge would move, listed whatever its status. */
export interface ClientMergeProject {
  id: string;
  name: string;
  status: Project['status'];
}

/**
 * One source identity recorded against the client being merged away, which the merge retargets to
 * the survivor. Without that, a playbook naming the client by the id it has at its source would
 * resolve to a client whose work has moved somewhere else.
 */
export interface ClientMergeAlias {
  /** The source the identity belongs to, e.g. `campaign-playbook:<source-uuid>`. */
  namespace: string;
  /** What the client is called at that source. */
  externalId: string;
}

export interface ClientMergePreview {
  source: ClientMergeParty;
  destination: ClientMergeParty;
  /** Every project under the source, sorted by id — the same order the hash is taken over. */
  projects: ClientMergeProject[];
  /** Every import identity that moves with them, sorted the same way and for the same reason. */
  aliases: ClientMergeAlias[];
  /**
   * SHA-256 of the plan. The commit sends it back and is refused with a 409 if the workspace
   * moved underneath it, so a confirmation always applies to the merge that was shown.
   */
  planHash: string;
}

export interface ClientMergeResult {
  source: ClientMergeParty;
  destination: ClientMergeParty;
  /** The projects that moved, in the order the preview listed them. */
  projects: ClientMergeProject[];
  /** The import identities that moved, in the order the preview listed them. */
  aliases: ClientMergeAlias[];
  movedProjectCount: number;
  mergedAt: string;
}

/**
 * What a merge does and does not do, stated once so the dialog, the manual, and the tests
 * cannot describe it differently. Rendered verbatim in the confirmation dialog.
 */
export const CLIENT_MERGE_NOTICES: string[] = [
  'Every project moves to the destination client, with its tasks, checklists, dependencies, categories, ordering, dates, and Drive references unchanged.',
  'The source client becomes archived and is recorded as merged into the destination. Its contact details and notes stay readable on it and are never copied across.',
  'The destination client keeps its own name, contact details, and notes.',
  'No Drive folder is moved, renamed, created, or deleted. Files still open exactly where they are now.',
  'Projects with the same name stay separate; nothing is combined.',
  'Any import identity recorded for the source client moves to the destination, so a later playbook naming that source still lands on the client keeping the work.',
  'There is no undo. Recover from a database backup if this was a mistake.',
];
