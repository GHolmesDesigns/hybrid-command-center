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
