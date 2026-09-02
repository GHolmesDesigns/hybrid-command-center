/**
 * The integration activity log: the shapes the API and the browser both read.
 *
 * One row per thing an integration did to local data — which integration, which operation,
 * how it ended, which records it touched, and the error when it failed. It answers the
 * question a receipt cannot: *did that partial import leave anything behind, and what?*
 *
 * The write side lives in `server/integration-log.ts`. Nothing here has a database in it.
 */

/** Integrations that write to the log. One value per external system, not per operation. */
export const INTEGRATION_SOURCES = [
  'campaign-playbook',
  'signal-import',
  'signal-campaign',
  'google-drive',
] as const;
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

/**
 * Operations, named `<area>.<verb>`. A new one is added here rather than passed as free text,
 * so the log stays a list of known operations instead of whatever a caller typed.
 */
export const INTEGRATION_OPERATIONS = [
  'playbook.import',
  'signal.import',
  'calendar.sync',
  'drive.sync',
  'drive.create-folder',
  'drive.upload-file',
  'drive.agent-write-request',
  'signal.publish',
  'signal.publish-now',
  'signal.reconcile',
  // Writes to a post the provider already holds. Separate from `signal.publish` because they are a
  // different question in the log — *what did we change out there*, not *what did we send* — and
  // separate from each other because one withdraws a post and the other rewrites it.
  'signal.provider-update',
  'signal.provider-cancel',
  // Reading figures back. Separate from every operation above because it is the one that changes no
  // post, no publication, and no target -- it stores what the platforms counted -- and a log reader
  // asking "what did this app do to my schedule" should be able to tell it apart at a glance.
  'signal.analytics-sync',
  // Reading what else is in the provider. Separate again, and for the sharper version of the reason
  // above: it changes no post, no publication, no target, and no figure -- it replaces one snapshot of
  // somebody else's records. A log reader asking 'what did this app do to my schedule' can see at a
  // glance that the answer here is nothing.
  'signal.provider-inventory-refresh',
  // Reading Buffer channel metadata for publishing preview and target selection. Separate from
  // inventory because it changes no post and asks a different question — which accounts may be
  // chosen — and never runs on an ordinary Signal page load.
  'signal.buffer-accounts-refresh',
  // Reading a provider-filtered window of figures. Separate from `signal.analytics-sync` because it
  // is a different question with a different failure: a sync asks the provider to refresh its own
  // copy for the deliveries this app named, and this asks which deliveries the provider itself would
  // name over one of its windows. One replaces a whole snapshot or replaces nothing, so a log reader
  // can tell an all-or-nothing window read apart from a per-post refresh at a glance.
  'signal.analytics-window-refresh',
] as const;
export type IntegrationOperation = (typeof INTEGRATION_OPERATIONS)[number];

/**
 * How an operation ended.
 *
 * - `SUCCESS` — it did what it set out to do. Records it deliberately passed over are still a
 *   success; they are named in the summary.
 * - `PARTIAL` — some of it landed and some of it did not. This is the outcome that makes a
 *   half-finished operation diagnosable, so anything that writes in steps must be able to
 *   report it. A playbook import cannot: it is one transaction, so it lands or it does not.
 * - `FAILURE` — nothing landed. `error` says why, in the words the failure used.
 */
export const INTEGRATION_OUTCOMES = ['SUCCESS', 'PARTIAL', 'FAILURE'] as const;
export type IntegrationOutcome = (typeof INTEGRATION_OUTCOMES)[number];

/** Record kinds an integration can affect. Each maps to one local table. */
export const INTEGRATION_ENTITY_TYPES = [
  'client',
  'project',
  'task',
  'signalPost',
  'driveFolder',
  'driveFile',
] as const;
export type IntegrationEntityType = (typeof INTEGRATION_ENTITY_TYPES)[number];

/** One record an operation created or changed, addressed the way the rest of the app does. */
export interface IntegrationEntity {
  type: IntegrationEntityType;
  id: string;
  /** The name or title the record carried at the time, so a deleted record is still readable. */
  label: string;
}

/** One thing an integration did. Written once and never updated. */
export interface IntegrationEvent {
  id: string;
  source: IntegrationSource;
  operation: IntegrationOperation;
  outcome: IntegrationOutcome;
  /** One line, in plain words: what the operation did, in counts. */
  summary: string;
  entities: IntegrationEntity[];
  /**
   * How many records the operation affected. Kept as a column because `entities` is capped:
   * the count stays true for an operation that touched more records than the log lists.
   */
  entityCount: number;
  /**
   * The record this event explains — an import receipt id today, a sync run later. It is what
   * lets the Import page show an import's audit record beside the receipt it belongs to.
   */
  correlationId?: string;
  /** Present only for `PARTIAL` and `FAILURE`, and never carrying a credential. */
  error?: string;
  createdAt: string;
}

/**
 * Retention. The newest `INTEGRATION_EVENT_LIMIT` rows are kept and older ones are pruned as
 * new ones are written, so a workspace that syncs on a schedule cannot grow the table without
 * a bound. `INTEGRATION_EVENT_ENTITY_LIMIT` bounds one row the same way: an import of a
 * thousand tasks lists the first hundred and keeps the true count in `entityCount`.
 */
export const INTEGRATION_EVENT_LIMIT = 200;
export const INTEGRATION_EVENT_ENTITY_LIMIT = 100;

/** How many rows one request may ask for. */
export const INTEGRATION_EVENT_PAGE_MAX = INTEGRATION_EVENT_LIMIT;

export const INTEGRATION_SOURCE_LABEL: Record<IntegrationSource, string> = {
  'campaign-playbook': 'Campaign playbook',
  'signal-import': 'Signal import',
  'signal-campaign': 'Signal Campaign',
  'google-drive': 'Google Drive',
};

export const INTEGRATION_OPERATION_LABEL: Record<IntegrationOperation, string> = {
  'playbook.import': 'Playbook import',
  'signal.import': 'Signal import',
  'calendar.sync': 'Calendar sync',
  'drive.sync': 'Drive sync',
  'drive.create-folder': 'Drive create folder',
  'drive.upload-file': 'Drive upload file',
  'drive.agent-write-request': 'Drive agent write request',
  'signal.publish': 'Signal publish',
  'signal.publish-now': 'Signal publish now',
  'signal.reconcile': 'Signal reconcile',
  'signal.provider-update': 'Signal provider update',
  'signal.provider-cancel': 'Signal provider cancel',
  'signal.analytics-sync': 'Signal analytics sync',
  'signal.provider-inventory-refresh': 'Signal provider inventory refresh',
  'signal.buffer-accounts-refresh': 'Signal Buffer accounts refresh',
  'signal.analytics-window-refresh': 'Signal analytics window refresh',
};

export const INTEGRATION_OUTCOME_LABEL: Record<IntegrationOutcome, string> = {
  SUCCESS: 'Succeeded',
  PARTIAL: 'Partly done',
  FAILURE: 'Failed',
};

export const INTEGRATION_ENTITY_LABEL: Record<IntegrationEntityType, string> = {
  client: 'Client',
  project: 'Project',
  task: 'Task',
  signalPost: 'Signal post',
  driveFolder: 'Drive folder',
  driveFile: 'Drive file',
};
