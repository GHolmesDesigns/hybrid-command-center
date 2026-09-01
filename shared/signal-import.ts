/** The source prefix keeps Signal identities separate from every other import vocabulary. */
export const SIGNAL_IMPORT_SOURCE = 'signal-import';

/** Both columns are optional, but one may never appear without the other. */
export const SIGNAL_POST_IMPORT_IDENTITY_COLUMNS = [
  'post_import_source',
  'post_import_id',
] as const;

export interface SignalPostImportIdentity {
  namespace: string;
  externalId: string;
}

/** A UUID source is normalised before it becomes part of the namespace; the opaque id is not. */
export const signalImportSourceNamespace = (sourceId: string) =>
  `${SIGNAL_IMPORT_SOURCE}:${sourceId.toLowerCase()}`;

export const SIGNAL_IMPORT_SCHEMA_VERSION = 1;
export const SIGNAL_IMPORT_SOURCE_NAME = SIGNAL_IMPORT_SOURCE;
export const SIGNAL_IMPORT_RECEIPT_LIMIT = 50;
export const SIGNAL_IMPORT_SHEETS = ['SignalPosts', 'SignalMedia', 'SignalVariants'] as const;
export type SignalImportSheet = (typeof SIGNAL_IMPORT_SHEETS)[number];

/** The versioned sample workbook served by the Import page. */
export const SAMPLE_SIGNAL_DOWNLOAD_PATH = '/api/import/signal/sample';
export const SAMPLE_SIGNAL_FILENAME = 'signal-import-format.xlsx';

export interface SignalImportIssue {
  sheet: string;
  row?: number;
  column?: string;
  message: string;
}

export interface SignalImportCreation {
  sheet: SignalImportSheet;
  row: number;
  key: string;
  label: string;
}

export interface SignalImportSkip extends SignalImportCreation {
  reason: string;
  existingId: string;
}

export interface SignalImportCounts {
  SignalPosts: number;
  SignalMedia: number;
  SignalVariants: number;
}

export const emptySignalImportCounts = (): SignalImportCounts => ({
  SignalPosts: 0,
  SignalMedia: 0,
  SignalVariants: 0,
});

export const signalImportTotal = (counts: SignalImportCounts) =>
  counts.SignalPosts + counts.SignalMedia + counts.SignalVariants;

/**
 * One `[SignalMedia]` row as the dry run left it — workbook identity plus whatever Drive (or the
 * URL path) answered. Drive fields are present only when `source` is `DRIVE` and resolution
 * succeeded; a failed Drive row still appears so the preview can name what did not bind.
 */
export interface SignalImportResolvedMedia {
  sheet: 'SignalMedia';
  row: number;
  postKey: string;
  order: number;
  source: 'URL' | 'DRIVE';
  url: string;
  resolved: boolean;
  driveName?: string;
  mimeType?: string;
  sizeBytes?: number;
  resolvedAt?: string;
}

/**
 * Whether a capability finding is a property of the imported content, or a fact about today's
 * connections. Presenting them identically would teach a caption over a limit as fixable-by-waiting
 * and a missing account as a property of the copy.
 */
export type SignalImportVerdictDurability = 'DURABLE' | 'MOMENTARY';

export const SIGNAL_IMPORT_VERDICT_DURABILITY_LABEL: Record<SignalImportVerdictDurability, string> =
  {
    DURABLE: 'About the content — stays true until the copy, media, format, or channels change',
    MOMENTARY: 'About right now — depends on which accounts are connected today',
  };

/**
 * One channel finding from the shared publish capability contract, reported as a warning.
 *
 * Import never refuses on these: a caption over Bluesky's limit still imports. `publishWouldRefuse`
 * records what a later publish preview would do with the same facts, so the UI can say refuses
 * versus warns without inventing a second rule.
 */
export interface SignalImportCapabilityVerdict {
  postKey: string;
  row: number;
  channel: string;
  durability: SignalImportVerdictDurability;
  message: string;
  publishWouldRefuse: boolean;
}

/** Counts at the top of the preview so a long workbook does not require reading every row. */
export interface SignalImportCapabilitySummary {
  postsEvaluated: number;
  postsClean: number;
  postsWithWarnings: number;
  durableCount: number;
  momentaryCount: number;
}

export const emptySignalImportCapabilitySummary = (): SignalImportCapabilitySummary => ({
  postsEvaluated: 0,
  postsClean: 0,
  postsWithWarnings: 0,
  durableCount: 0,
  momentaryCount: 0,
});

export interface SignalImportPreview {
  schemaVersion: number;
  ok: boolean;
  creates: SignalImportCounts;
  updates: SignalImportCounts;
  skips: SignalImportCounts;
  failures: SignalImportCounts;
  created: SignalImportCreation[];
  updated: SignalImportCreation[];
  skipped: SignalImportSkip[];
  issues: SignalImportIssue[];
  /** Every media row the workbook named, in workbook order within each post. */
  resolvedMedia: SignalImportResolvedMedia[];
  /** Drive rows the workbook named — compared with `driveResolved` for the human stop. */
  driveNamed: number;
  /** Drive rows that bound a fingerprint in this dry run. */
  driveResolved: number;
  /**
   * Capability findings for what would happen if someone later published. Informational only —
   * they never flip `ok` or refuse the import.
   */
  capabilitySummary: SignalImportCapabilitySummary;
  capabilityVerdicts: SignalImportCapabilityVerdict[];
  duplicateRule: string[];
  fingerprint: string;
}

export type SignalImportOutcome = 'COMMITTED' | 'REJECTED' | 'FAILED';

export interface SignalImportReceipt {
  id: string;
  source: string;
  inputKind: 'xlsx' | 'text';
  filename?: string;
  outcome: SignalImportOutcome;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  creates: SignalImportCounts;
  updates: SignalImportCounts;
  skips: SignalImportCounts;
  created: SignalImportCreation[];
  updated: SignalImportCreation[];
  skipped: SignalImportSkip[];
  issues: SignalImportIssue[];
  /** What the dry run knew about publishability, recoverable after the import. */
  capabilitySummary: SignalImportCapabilitySummary;
  capabilityVerdicts: SignalImportCapabilityVerdict[];
  error?: string;
  createdAt: string;
}

export const SIGNAL_IMPORT_DUPLICATE_RULE = [
  'A source identity matches the post it was recorded against, regardless of copy or schedule changes.',
  'Without an established identity, a post matches by scheduled date (including blank) and trimmed copy, ignoring case.',
  'A fallback-only match never records an identity; a new identity is attached only when the workbook supplies one.',
  'Identity and fallback disagreement, duplicate identities, and duplicate fallback keys refuse the whole import.',
];
