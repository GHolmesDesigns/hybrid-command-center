/**
 * Merging one client into another: the payload types the preview and the commit answer with,
 * and the statements the confirmation dialog has to make before either happens.
 *
 * A merge is a local workspace operation. It moves every project of the source client to the
 * destination, archives the source, and records the source as an alias of the destination so a
 * later playbook import resolves the old name to the surviving client. It moves no Drive folder,
 * combines no contact field, and cannot be undone in the app.
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

export interface ClientMergePreview {
  source: ClientMergeParty;
  destination: ClientMergeParty;
  /** Every project under the source, sorted by id — the same order the hash is taken over. */
  projects: ClientMergeProject[];
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
  'There is no undo. Recover from a database backup if this was a mistake.',
];
