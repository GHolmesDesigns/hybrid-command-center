/**
 * Campaign playbook import: the shapes the API and the browser both read.
 *
 * The format itself is specified in `docs/campaign-playbook-import-format.md`; this file
 * carries only what crosses the wire, so the preview the modal renders and the receipt the
 * Import page lists cannot drift from what the server produced.
 */

/** Data tabs the importer reads, in dependency order — a parent tab always precedes its children. */
export const PLAYBOOK_SHEETS = [
  'Clients',
  'Projects',
  'Tasks',
  'ChecklistItems',
  'Dependencies',
] as const;
export type PlaybookSheet = (typeof PLAYBOOK_SHEETS)[number];
/** Tabs the workbook may carry for its authors. Present or absent, the importer ignores them. */
export const PLAYBOOK_DOC_SHEETS = ['README', 'DataDictionary', 'AllowedValues'] as const;
/** The only format version this build understands. */
export const PLAYBOOK_SCHEMA_VERSION = 1;

/**
 * The versioned sample workbook: where the API serves it and the name the browser saves it as.
 *
 * Both live here rather than once in the route and once in the page, so the link the Import page
 * offers and the `Content-Disposition` the route answers with cannot come to disagree about what
 * is downloaded or what it is called. The file itself stays in `docs/examples/`, beside the format
 * document that links it — the server reads it from there rather than a copy.
 */
export const SAMPLE_PLAYBOOK_DOWNLOAD_PATH = '/api/import/playbook/sample';
export const SAMPLE_PLAYBOOK_FILENAME = 'campaign-playbook-import-format.xlsx';

/**
 * One reason an import cannot proceed, addressed the way an author reads their workbook:
 * which tab, which spreadsheet row, which column header. Row and column are absent for a
 * whole-workbook problem such as a missing tab.
 */
export interface PlaybookIssue {
  sheet: string;
  /** The spreadsheet row number, 1-based, as the author sees it — header row included. */
  row?: number;
  column?: string;
  message: string;
}

/** A record the commit would create, named the way the preview lists it. */
export interface PlaybookCreation {
  sheet: PlaybookSheet;
  row: number;
  /** `client_key`, `project_key`, `task_key`, or the parent key for a child row. */
  key: string;
  label: string;
}

/**
 * A record the commit will not create because the workspace already has it, with the rule
 * that matched. Skipping rather than refusing is what makes a re-import safe: the second
 * run of the same file matches everything and creates nothing.
 */
export interface PlaybookSkip extends PlaybookCreation {
  reason: string;
  /** The record already in the workspace that the row resolved to. */
  existingId: string;
}

export type PlaybookCountKey = PlaybookSheet;
export type PlaybookCounts = Record<PlaybookCountKey, number>;

export const emptyCounts = (): PlaybookCounts => ({
  Clients: 0,
  Projects: 0,
  Tasks: 0,
  ChecklistItems: 0,
  Dependencies: 0,
});

export const totalCount = (counts: PlaybookCounts) =>
  PLAYBOOK_SHEETS.reduce((total, sheet) => total + counts[sheet], 0);

/**
 * The dry run. `ok` is the only thing the confirm button reads: a preview with any issue
 * writes nothing, and duplicates are not issues — they are rows the commit will pass over.
 */
export interface PlaybookPreview {
  schemaVersion: number;
  ok: boolean;
  /** Rows that would be created, per tab. */
  creates: PlaybookCounts;
  /** Rows the workspace already has, per tab. */
  skips: PlaybookCounts;
  /** Rows that failed validation, per tab. */
  failures: PlaybookCounts;
  created: PlaybookCreation[];
  skipped: PlaybookSkip[];
  issues: PlaybookIssue[];
  /**
   * The duplicate rule in the preview's own words, so a wrong assumption about what counts
   * as "already imported" is caught before the write rather than after it.
   */
  duplicateRule: string[];
  /**
   * Digest of the parsed input. The commit sends it back and is refused if the file changed
   * between the preview and the confirmation.
   */
  fingerprint: string;
}

export type ImportOutcome = 'COMMITTED' | 'REJECTED' | 'FAILED';

/**
 * What one import did, kept after the modal closes. Counts and reasons are the same numbers
 * the preview showed, recorded from the write that actually happened.
 */
export interface ImportReceipt {
  id: string;
  source: string;
  inputKind: PlaybookInputKind;
  filename?: string;
  outcome: ImportOutcome;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
  creates: PlaybookCounts;
  skips: PlaybookCounts;
  created: PlaybookCreation[];
  skipped: PlaybookSkip[];
  issues: PlaybookIssue[];
  error?: string;
  createdAt: string;
}

export type PlaybookInputKind = 'xlsx' | 'text';

/** How many receipts are kept. Older ones are pruned as new ones are written. */
export const IMPORT_RECEIPT_LIMIT = 50;
export const PLAYBOOK_SOURCE = 'campaign-playbook';

/** One line per rule, rendered in the preview and stored on the receipt's detail. */
export const DUPLICATE_RULE: string[] = [
  'A client matches an existing client when the trimmed name is the same, ignoring case. The import attaches to that client instead of creating a second one.',
  'A project matches when its resolved client already has a project with the same trimmed name, ignoring case.',
  'A task matches when its resolved project already has a task with the same trimmed title, ignoring case, and the same due date — an empty due date counts as a match only against another empty one.',
  'Checklist items and dependencies of a matched record are skipped with it: an existing record is never edited by an import.',
  'Archived clients and projects match too. An import never revives or rewrites them.',
  'A client that was merged into another one keeps its name as an alias: a playbook naming it attaches to the surviving client instead. A client of that name that was never merged still wins.',
];

/** Human wording for a skip, used by the server and shown unchanged in the browser. */
export const SKIP_REASON = {
  client: 'A client with this name already exists; the import will use it.',
  clientMergedAlias:
    'A client with this name was merged into another client; the import will use the surviving client.',
  project: 'This client already has a project with this name.',
  task: 'This project already has a task with this title and due date.',
  checklistItem: 'Its task already exists, so its checklist is left as it is.',
  dependency: 'Both tasks already have this dependency.',
} as const;
