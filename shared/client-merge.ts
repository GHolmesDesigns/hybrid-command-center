/**
 * Merging one client into another: the payload types the preview and the commit answer with,
 * the vocabulary of fields a merge can choose between, and the statements the confirmation
 * dialog has to make before either happens.
 *
 * A merge is a local workspace operation. It moves every project of the source client to the
 * destination, archives the source, and records the source as an alias of the destination so a
 * later playbook import resolves the old name to the surviving client. Any import identity the
 * source carried moves with the work, for the same reason and to the same end. It moves no Drive
 * folder and cannot be undone in the app.
 *
 * What the survivor is left holding in its own six editable fields is chosen, one field at a
 * time, from either record or from a value typed in the dialog. Nothing else about it is: its
 * status, its Drive columns, and its Drive connection are untouched, and its slug is derived
 * from whichever name it keeps rather than chosen.
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

/**
 * The fields a merge chooses between, in the order the dialog lists them.
 *
 * Exactly the six a person edits on the client form. `status` is not here — a merge decides both
 * clients' statuses itself — and neither is `slug`, which is derived from the name, nor any
 * `drive_*` column, which describes a folder this operation never touches.
 */
export const CLIENT_MERGE_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'contactName', label: 'Contact name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'website', label: 'Website' },
  // The only one long enough to want more than a single line in the dialog.
  { key: 'notes', label: 'Notes', multiline: true },
] as const;

export type ClientMergeField = (typeof CLIENT_MERGE_FIELDS)[number]['key'];

/**
 * Where one field's surviving value comes from. `DESTINATION` is the default for every field and
 * is never inferred away: a blank value on the client being kept stays blank unless someone says
 * otherwise here, because a merge that quietly filled in the gaps would be a different operation.
 */
export type ClientMergeChoice = 'DESTINATION' | 'SOURCE' | 'CUSTOM';

/** The three choices, with the words the dialog offers them under. */
export const CLIENT_MERGE_CHOICES = [
  { choice: 'DESTINATION', label: 'Keep destination' },
  { choice: 'SOURCE', label: 'Use source' },
  { choice: 'CUSTOM', label: 'Custom value' },
] as const satisfies readonly { choice: ClientMergeChoice; label: string }[];

/** One field's choice as the browser sends it. `value` is read only for `CUSTOM`. */
export interface ClientMergeFieldSelection {
  choice: ClientMergeChoice;
  value?: string | null;
}

/** Every choice a merge was asked for. An absent field is `DESTINATION`. */
export type ClientMergeSelections = Partial<Record<ClientMergeField, ClientMergeFieldSelection>>;

/**
 * One field as the plan settles it: both records' current values, the choice made, and the value
 * the survivor ends up with. Part of the plan, so the confirmation hash covers every selected
 * value and a preview taken under different choices cannot be confirmed.
 */
export interface ClientMergeFieldPlan {
  field: ClientMergeField;
  /** What the client being kept holds now. */
  destination: string | null;
  /** What the client being merged away holds. */
  source: string | null;
  choice: ClientMergeChoice;
  /** What the survivor is left with. `null` is a blank field. */
  value: string | null;
}

/** The chosen values by field, which is how the write and the dialog both want to read them. */
export function clientMergeFieldValues(
  fields: ClientMergeFieldPlan[],
): Record<ClientMergeField, string | null> {
  const values = {} as Record<ClientMergeField, string | null>;
  for (const field of fields) values[field.field] = field.value;
  return values;
}

export interface ClientMergePreview {
  source: ClientMergeParty;
  destination: ClientMergeParty;
  /** Every project under the source, sorted by id — the same order the hash is taken over. */
  projects: ClientMergeProject[];
  /** Every import identity that moves with them, sorted the same way and for the same reason. */
  aliases: ClientMergeAlias[];
  /** The six choosable fields, in `CLIENT_MERGE_FIELDS` order. */
  fields: ClientMergeFieldPlan[];
  /**
   * The survivor's slug before and after. It is derived rather than chosen: keeping the
   * destination's name keeps its slug, and any other surviving name rebuilds it exactly as
   * renaming the client would.
   */
  slug: { current: string; next: string };
  /**
   * SHA-256 of the plan. The commit sends it back and is refused with a 409 if the workspace
   * moved underneath it, so a confirmation always applies to the merge that was shown.
   */
  planHash: string;
}

export interface ClientMergeResult {
  source: ClientMergeParty;
  /** The survivor as it stands afterwards, under whichever name it now carries. */
  destination: ClientMergeParty;
  /** The projects that moved, in the order the preview listed them. */
  projects: ClientMergeProject[];
  /** The import identities that moved, in the order the preview listed them. */
  aliases: ClientMergeAlias[];
  /** The fields as the merge settled them, in the order the preview listed them. */
  fields: ClientMergeFieldPlan[];
  movedProjectCount: number;
  mergedAt: string;
}

/**
 * What a merge does and does not do, stated once so the dialog, the manual, and the tests
 * cannot describe it differently. Rendered verbatim in the confirmation dialog.
 */
export const CLIENT_MERGE_NOTICES: string[] = [
  'Every project moves to the destination client, with its tasks, checklists, dependencies, categories, ordering, dates, and Drive references unchanged.',
  'The source client becomes archived and is recorded as merged into the destination. Its own details stay readable on it whichever values you keep, and nothing is copied across that you did not choose.',
  'The client you are keeping takes exactly the values selected above. Keep destination is the default for every field, a blank one included, so a merge you do not touch leaves its details as they are today.',
  'Nothing else about the client you are keeping is chosen here: its status, its Drive folder, and its Drive connection are untouched, and its web address follows whichever name it keeps, exactly as renaming it would.',
  'No Drive folder is moved, renamed, created, or deleted. Files still open exactly where they are now.',
  'Projects with the same name stay separate; nothing is combined.',
  'Any import identity recorded for the source client moves to the destination, so a later playbook naming that source still lands on the client keeping the work.',
  'There is no undo. Recover from a database backup if this was a mistake.',
];
