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
  error?: string;
  createdAt: string;
}

export const SIGNAL_IMPORT_DUPLICATE_RULE = [
  'A source identity matches the post it was recorded against, regardless of copy or schedule changes.',
  'Without an established identity, a post matches by scheduled date (including blank) and trimmed copy, ignoring case.',
  'A fallback-only match never records an identity; a new identity is attached only when the workbook supplies one.',
  'Identity and fallback disagreement, duplicate identities, and duplicate fallback keys refuse the whole import.',
];
