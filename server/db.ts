import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export type Db = DatabaseSync;

/**
 * Tables and columns as a fresh install gets them. Also the definition an
 * existing database is reconciled against — see `applyAdditiveMigrations`.
 */
const tableSchema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, contact_name TEXT, email TEXT,
  phone TEXT, website TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE', drive_folder_id TEXT,
  drive_folder_url TEXT, drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', drive_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- One row per client that was merged into another. Clients are archive-only, so a merge never
-- deletes the source: it archives it and records the survivor here, which is what lets a later
-- playbook import resolve the old client's name to the client that now owns its work. The
-- primary key is the source, so a client can be merged away exactly once; when a survivor is
-- itself merged, the earlier rows are retargeted in the same transaction, keeping every alias
-- one hop from its current survivor rather than the head of a chain.
CREATE TABLE IF NOT EXISTS client_merges (
  source_client_id TEXT PRIMARY KEY REFERENCES clients(id),
  surviving_client_id TEXT NOT NULL REFERENCES clients(id),
  merged_at TEXT NOT NULL,
  CHECK(source_client_id <> surviving_client_id)
);
-- One row per source identity a client is known by outside this workspace. A playbook may carry
-- the id its client has at the source it was written from alongside the name, and that pair is
-- recorded here, so renaming the client at the source no longer makes the next import look like a
-- client this workspace has never seen. The namespace is campaign-playbook:<stable-source-uuid>,
-- which keeps two sources that happen to number their clients the same way apart.
--
-- The uniqueness is on the pair alone, deliberately: one identity belongs to exactly one client, so
-- no second client can claim it and retargeting one during a merge can never collide. The reverse is
-- one to many -- a client may carry several identities, one per source it arrived from.
CREATE TABLE IF NOT EXISTS client_import_aliases (
  source_namespace TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  client_id        TEXT NOT NULL REFERENCES clients(id),
  created_at       TEXT NOT NULL,
  UNIQUE (source_namespace, external_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), name TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', start_date TEXT, target_deadline TEXT, priority TEXT NOT NULL DEFAULT 'MEDIUM',
  notes TEXT, position INTEGER NOT NULL DEFAULT 0, drive_folder_id TEXT, drive_folder_url TEXT,
  drive_status TEXT NOT NULL DEFAULT 'DISCONNECTED', drive_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_activity_at TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT,
  status TEXT NOT NULL DEFAULT 'BACKLOG', priority TEXT NOT NULL DEFAULT 'MEDIUM', task_type TEXT,
  due_date TEXT, start_date TEXT, notes TEXT, position INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, text TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  dependency_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, dependency_id), CHECK(task_id <> dependency_id)
);
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT
);
CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT
);
CREATE TABLE IF NOT EXISTS project_categories (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, category_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_receipts (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, input_kind TEXT NOT NULL, filename TEXT,
  fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, created_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
);
-- The integration activity log. Append-only from the app's perspective: one INSERT in
-- server/integration-log.ts writes it, retention deletes the oldest rows, and nothing updates
-- one. It carries no foreign key to the records it names on purpose -- an event has to stay
-- readable after the client, project, or task it mentions is deleted, which is exactly the
-- case the log exists for.
CREATE TABLE IF NOT EXISTS integration_events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, operation TEXT NOT NULL, outcome TEXT NOT NULL,
  summary TEXT NOT NULL, entities TEXT NOT NULL DEFAULT '[]', entity_count INTEGER NOT NULL DEFAULT 0,
  correlation_id TEXT, error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drive_steps (
  entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, step_key TEXT NOT NULL, folder_id TEXT NOT NULL,
  folder_url TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(entity_type, entity_id, step_key)
);
-- Signal Campaign's schedule: the authoritative store for planned content (decision 5.7).
-- The date column is a YYYY-MM-DD value in local time, never an instant, and NULL means the
-- post is in the unscheduled queue rather than on any day. See shared/signal.ts for the rule.
--
-- The campaign column is frozen. It held one nullable free-text campaign-and-week label per post
-- until signal_campaigns replaced it with a normalized join; backfillSignalCampaigns below reads it
-- once into that join, and from then on nothing in this app reads it for behaviour and nothing
-- writes it. It is kept rather than dropped for two reasons: this module is additive by design
-- (see applyAdditiveMigrations), so removing a column means a full table rebuild and is its own
-- decision; and while it is here the backfill stays auditable and reversible, because what each
-- post used to say is still on the row that says it.
CREATE TABLE IF NOT EXISTS signal_posts (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, date TEXT, time TEXT NOT NULL DEFAULT '09:00',
  format TEXT NOT NULL DEFAULT 'TEXT', status TEXT NOT NULL DEFAULT 'DRAFT', campaign TEXT,
  cta TEXT NOT NULL DEFAULT 'NONE', position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- Signal campaigns: the shared vocabulary a post's content belongs to, modelled exactly as tags
-- and categories are one level up -- a name-unique row here and a join below, so a post can carry
-- several, renaming one is a single write that reaches every post, and deleting one detaches it
-- without touching a post. COLLATE NOCASE is what makes the shared normalisation rule in
-- shared/types.ts enforceable rather than advisory: two spellings of one name cannot both exist.
CREATE TABLE IF NOT EXISTS signal_campaigns (
  id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT
);
CREATE TABLE IF NOT EXISTS signal_post_campaigns (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  campaign_id TEXT NOT NULL REFERENCES signal_campaigns(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, campaign_id)
);
-- Channels are a normalized join rather than a packed column, for the same reason tags and
-- categories are: one row per channel a post goes out on, queryable without parsing a string.
CREATE TABLE IF NOT EXISTS signal_post_channels (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, PRIMARY KEY(post_id, channel)
);
-- Media is an ordered list of public references. This app stores no media files, serves no media
-- bytes, and holds no media bytes at rest, and nothing on this path fetches, uploads, or proxies
-- one. The single exception the repository has decided is not built: C74 and C75 in
-- docs/post-bridge-integrations-plan.md give the confirmed publishing path one stream from a
-- user-selected Drive file to the provider, through server/drive/media.ts, storing nothing. Until
-- those cards land there is no byte path at all, and a provider media id is ephemeral either way --
-- never a durable reference here, and recreated on every submit, update, and restore-and-resubmit.
CREATE TABLE IF NOT EXISTS signal_post_media (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0), url TEXT NOT NULL,
  PRIMARY KEY(post_id, position)
);
-- Platform and account content overrides for one post. The layers resolve base -> platform ->
-- account in shared/publish-variants.ts, and both live here as one shape: a NULL account_id is the
-- platform layer and a provider account id is the account layer, so the resolution reads one table
-- rather than joining two that would drift. Uniqueness is the expression index below, because
-- SQLite does not enforce NOT NULL on a PRIMARY KEY column and a nullable key column would let a
-- platform layer be written twice.
--
-- media_urls is a JSON array of URLs the post already carries: a selection of its own media, never
-- a new reference. NULL means the platform inherits the post's media and '[]' means it deliberately
-- receives none, which are different answers. Nothing here is fetched, uploaded, or proxied by the
-- server -- the rule signal_post_media above states, restated because cover_image_url and
-- thumbnail_url are the two columns most likely to tempt someone into breaking it. Those two reach
-- no provider field today and C76 is where they would; a byte path arriving for the publishing
-- stream does not make one for this table.
CREATE TABLE IF NOT EXISTS signal_post_variants (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, account_id INTEGER,
  caption TEXT, media_urls TEXT, post_kind TEXT, title TEXT, first_comment TEXT,
  disclose_synthetic_media INTEGER, cover_image_url TEXT, thumbnail_url TEXT,
  updated_at TEXT NOT NULL,
  CHECK(account_id IS NULL OR account_id > 0)
);
-- Delivery, which is a different fact from the planning status on signal_posts. checked_at is
-- the last reconciliation of either kind and check_attempts is the automatic budget alone, so a
-- manual refresh can update what the planner shows without spending a scheduled check.
CREATE TABLE IF NOT EXISTS signal_publications (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL, provider TEXT NOT NULL, provider_post_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE, scheduled_instant TEXT NOT NULL, timezone TEXT NOT NULL,
  sent_caption TEXT NOT NULL, sent_channels TEXT NOT NULL, error TEXT,
  -- What the provider was handed, snapshotted like the caption above: sent_media is the JSON media
  -- array and sent_configurations the JSON platform_configurations. Both exist so that comparing a
  -- Signal edit against the provider reads the request that was actually sent rather than
  -- re-deriving it from a post that has since moved on.
  --
  -- Nullable, and NULL is not '[]' -- the same distinction signal_post_variants.media_urls makes.
  -- '[]' is a submission that deliberately carried no media; NULL is a publication written before
  -- these columns existed, where what went out is genuinely unknown. Backfilling those to '[]'
  -- would have made every migrated publication with media report a media difference it has no
  -- evidence for, so the unknown stays unknown and the comparison says so. Every row written from
  -- now on carries a value.
  sent_media TEXT, sent_configurations TEXT,
  checked_at TEXT, check_attempts INTEGER NOT NULL DEFAULT 0,
  -- What the last provider check concluded, and what the row held before it. Written by a check
  -- and by nothing else: every other state write leaves them alone, which is deliberate, because
  -- checked_state still matching state is how a reader knows the change has not already been
  -- answered by a cancel or a resubmit. Both NULL until the provider has been asked once.
  checked_state TEXT, prior_state TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- mode is the delivery route decided at submit time from the capability contract, kept beside
-- the outcome rather than derived later: the contract can change, and what a delivery needed from
-- a person when it was sent is a fact about that submission. manual_completed_at is the person's
-- own record that they finished it where it had to be finished, and it never touches the post.
-- post_result_id is the provider's own identity for this one delivery -- the id of the
-- post-results row, which is not the post id and not the account id. It is the only thing the
-- analytics endpoints will answer a question about, so without it there is nothing to ask for
-- figures against. Captured by reconciliation, which is the only call that reads post-results,
-- and never overwritten with NULL: a response that omits it has said nothing about it.
CREATE TABLE IF NOT EXISTS signal_publication_targets (
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, provider_account_id INTEGER NOT NULL, outcome TEXT, permalink TEXT, error TEXT,
  handle TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'AUTOMATIC', manual_completed_at TEXT,
  post_result_id TEXT,
  PRIMARY KEY(publication_id, provider_account_id)
);
-- Current totals per delivery, and the daily snapshots behind them.
--
-- Two tables rather than one because they answer different questions and arrive separately: a total
-- is one row that is rewritten, and a day is a row that is never rewritten once the provider has
-- moved past it. Both are keyed the way the delivery they describe is keyed --
-- (publication_id, provider_account_id) -- rather than by the provider's analytics id, so a figure
-- is joinable to the target row it belongs to and survives the provider reissuing an id.
-- signal_publication_targets has no id column of its own, which is why the key is the pair and not
-- a foreign key to one column.
--
-- Nothing here is ever written by a failed refresh. The service writes only rows the provider
-- actually returned, in one transaction, so a refusal or a network failure leaves the last known
-- good values exactly as they were rather than replacing them with zeros or with nothing.
--
-- provider_synced_at is the provider's own last_synced_at for the record; synced_at is when this
-- app stored it. Both are kept because they answer different questions -- how old the platform's
-- reading is, and how old this app's copy of it is -- and one of them being fresh does not make the
-- other one fresh.
CREATE TABLE IF NOT EXISTS signal_post_metrics (
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  provider_account_id INTEGER NOT NULL,
  post_result_id TEXT NOT NULL, analytics_id TEXT NOT NULL, platform TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  share_url TEXT, provider_synced_at TEXT, synced_at TEXT NOT NULL,
  PRIMARY KEY(publication_id, provider_account_id)
);
-- One row per day the provider snapshotted, carrying the cumulative totals as of that date. The
-- date is a YYYY-MM-DD value and never an instant, the same rule signal_posts.date follows: it is
-- the provider's own label for a day, and deriving a moment from it would put a snapshot on the
-- wrong side of midnight in half the world's zones. Per-day gains are subtracted from these on
-- read (shared/publish-analytics.ts) rather than stored beside them.
CREATE TABLE IF NOT EXISTS signal_post_metric_days (
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  provider_account_id INTEGER NOT NULL, date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(publication_id, provider_account_id, date)
);
-- Queue-health acknowledgements: one row per alert a person has said they have seen.
--
-- This is the only table the health summary writes, and it holds nothing about the plan or the
-- delivery -- which is the acceptance criterion of the card that added it. The alerts themselves are
-- derived on every read from the rows above (shared/queue-health.ts) and are never stored, so this
-- table cannot disagree with them; the worst it can hold is a row for an alert that no longer
-- exists, which reads as nothing at all.
--
-- fingerprint is the shape of the facts that were acknowledged. The derivation compares it, so a
-- situation that moves on stops matching and the alert returns live rather than staying dismissed
-- for a problem that has become a different problem.
CREATE TABLE IF NOT EXISTS signal_alert_acks (
  alert_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, acknowledged_at TEXT NOT NULL
);
`;

/**
 * Indexes, applied after the additive migration so that an index over a
 * newly added column is created against a table that already has it.
 */
const indexSchema = `
CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id);
-- Retargeting a merge reads every alias pointing at the client being merged away, and the
-- client list joins the survivor of each one.
CREATE INDEX IF NOT EXISTS idx_client_merges_surviving ON client_merges(surviving_client_id);
-- A merge reads every import identity pointing at the client being merged away, for the same reason
-- the index above exists: those identities have to follow the work to the survivor.
CREATE INDEX IF NOT EXISTS idx_client_import_aliases_client
  ON client_import_aliases(client_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_open ON tasks(due_date) WHERE status <> 'COMPLETE';
CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id, position);
CREATE INDEX IF NOT EXISTS idx_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_project_categories_category ON project_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_import_receipts_created ON import_receipts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_events_created ON integration_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_events_correlation ON integration_events(correlation_id);
-- The calendar reads a date range; the planner reads the queue. Both are this one index:
-- dated rows order by day, and the NULL dates group together at the front.
CREATE INDEX IF NOT EXISTS idx_signal_posts_date ON signal_posts(date, time);
CREATE INDEX IF NOT EXISTS idx_signal_post_channels_channel ON signal_post_channels(channel);
-- The campaign side of the join: what a campaign's deletion has to detach, what its post count
-- counts, and what the segmented analytics read walks. The post side is the primary key's prefix.
CREATE INDEX IF NOT EXISTS idx_signal_post_campaigns_campaign
  ON signal_post_campaigns(campaign_id);
-- One layer per platform and one per account, enforced over the coalesced key because the platform
-- layer's account_id is NULL and SQLite's PRIMARY KEY would not have refused a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_post_variants_layer
  ON signal_post_variants(post_id, platform, COALESCE(account_id, -1));
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_publications_live ON signal_publications(post_id)
  WHERE state IN ('SUBMITTING','SUBMITTED','UNCONFIRMED');
CREATE INDEX IF NOT EXISTS idx_signal_publications_post ON signal_publications(post_id);
-- Retention over acknowledgements keeps the newest rows and prunes the rest, so the oldest are
-- what it has to find.
CREATE INDEX IF NOT EXISTS idx_signal_alert_acks_time ON signal_alert_acks(acknowledged_at);
-- A refresh asks the provider about the result ids it holds, so it looks them up from the targets
-- of one post's publications; the analytics read then walks the same rows back. Both are the
-- publication prefix of the primary keys above, so the only index worth adding is the one that
-- finds a delivery from the provider's own identity for it -- which is how an analytics row that
-- arrives with a result id and nothing else is matched back to the delivery it belongs to.
CREATE INDEX IF NOT EXISTS idx_signal_publication_targets_result
  ON signal_publication_targets(post_result_id);
`;

const schema = `${tableSchema}${indexSchema}`;

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKey {
  table: string;
  to: string | null;
  on_delete: string;
  on_update: string;
}

/** PRAGMA statements take no bound parameters, so identifiers are quoted instead. */
const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

const rows = <T>(db: Db, sql: string) => db.prepare(sql).all() as unknown as T[];

const tableNames = (db: Db) =>
  rows<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).map((row) => row.name);

const tableInfo = (db: Db, table: string) =>
  rows<ColumnInfo>(db, `PRAGMA table_info(${quote(table)})`);

const foreignKeys = (db: Db, table: string) =>
  new Map(
    rows<ForeignKey & { from: string }>(db, `PRAGMA foreign_key_list(${quote(table)})`).map(
      (key) => [key.from, key],
    ),
  );

/** Columns carrying a UNIQUE constraint, which `ALTER TABLE` cannot reproduce. */
const uniqueColumns = (db: Db, table: string) => {
  const names = new Set<string>();
  for (const index of rows<{ name: string; origin: string }>(
    db,
    `PRAGMA index_list(${quote(table)})`,
  )) {
    if (index.origin !== 'u') continue;
    for (const column of rows<{ name: string | null }>(
      db,
      `PRAGMA index_info(${quote(index.name)})`,
    )) {
      if (column.name) names.add(column.name);
    }
  }
  return names;
};

/**
 * Rebuilds the `ADD COLUMN` clause for a column the reference schema declares
 * and the live database lacks. Throws rather than emit a statement SQLite would
 * reject, or one that would quietly drop a constraint the schema declares.
 */
function addColumnClause(
  table: string,
  column: ColumnInfo,
  foreignKey: ForeignKey | undefined,
  unique: boolean,
): string {
  const where = `${table}.${column.name}`;
  if (column.pk) {
    throw new Error(`Cannot add ${where}: SQLite cannot add a primary key to an existing table.`);
  }
  if (unique) {
    throw new Error(`Cannot add ${where}: SQLite cannot add a UNIQUE column to an existing table.`);
  }
  if (column.notnull && column.dflt_value === null) {
    throw new Error(
      `Cannot add ${where}: SQLite cannot add a NOT NULL column without a default. ` +
        'Give it a default or make it nullable.',
    );
  }
  if (foreignKey && column.dflt_value !== null) {
    throw new Error(
      `Cannot add ${where}: a column referencing ${foreignKey.table} must default to NULL ` +
        'while PRAGMA foreign_keys is ON.',
    );
  }

  let clause = `${quote(column.name)} ${column.type}`;
  if (column.notnull) clause += ' NOT NULL';
  if (column.dflt_value !== null) clause += ` DEFAULT ${column.dflt_value}`;
  if (foreignKey) {
    clause += ` REFERENCES ${quote(foreignKey.table)}`;
    if (foreignKey.to) clause += `(${quote(foreignKey.to)})`;
    if (foreignKey.on_delete !== 'NO ACTION') clause += ` ON DELETE ${foreignKey.on_delete}`;
    if (foreignKey.on_update !== 'NO ACTION') clause += ` ON UPDATE ${foreignKey.on_update}`;
  }
  return clause;
}

/**
 * Brings an existing database up to the current schema by adding the columns it
 * is missing, and returns the statements it ran.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists,
 * so a column added to `tableSchema` would never reach a database created
 * before it: the code would expect a column the file does not have and every
 * query touching it would fail. This closes that gap by comparing the live
 * database against a throwaway reference database built from the schema, so a
 * new column needs no second declaration to be migrated.
 *
 * Additive only, by design — new tables (handled by `CREATE TABLE IF NOT
 * EXISTS`) and new columns. Dropping, renaming, retyping, or re-constraining a
 * column needs a full table rebuild in SQLite and is deliberately out of scope,
 * as are CHECK constraints, which `PRAGMA table_info` does not report.
 *
 * Safe to run on every boot: with nothing to add it inspects and returns empty.
 */
export function applyAdditiveMigrations(db: Db, referenceSchema = schema): string[] {
  const reference = new DatabaseSync(':memory:');
  const statements: string[] = [];
  try {
    reference.exec(referenceSchema);
    for (const table of tableNames(reference)) {
      const present = new Set(tableInfo(db, table).map((column) => column.name));
      if (present.size === 0) {
        throw new Error(`Cannot migrate ${table}: the table is missing from the database.`);
      }
      const missing = tableInfo(reference, table).filter((column) => !present.has(column.name));
      if (missing.length === 0) continue;
      const keys = foreignKeys(reference, table);
      const unique = uniqueColumns(reference, table);
      for (const column of missing) {
        const clause = addColumnClause(
          table,
          column,
          keys.get(column.name),
          unique.has(column.name),
        );
        statements.push(`ALTER TABLE ${quote(table)} ADD COLUMN ${clause}`);
      }
    }
  } finally {
    reference.close();
  }

  if (statements.length === 0) return statements;
  transaction(db, () => {
    for (const statement of statements) db.exec(statement);
  });
  return statements;
}

/**
 * Gives every project a `last_activity_at`, taking it from the `updated_at` the
 * row already carries, and returns how many rows it filled.
 *
 * Activity is deliberately a separate field from `updated_at` (see
 * `touchProjectActivity` in `server/app.ts`), but on a database migrated from a
 * release that had no activity column the only timestamp available is
 * `updated_at`, so it is the honest starting point: every project keeps the
 * position in Recently updated it had before the migration.
 *
 * Runs on every boot rather than only when the column was just added. The
 * `ALTER TABLE` and this backfill are separate statements, so a crash between
 * them would otherwise leave those rows with no activity for good. Idempotent —
 * with nothing left to fill it writes nothing.
 */
export function backfillProjectActivity(db: Db): number {
  const result = db
    .prepare(
      `UPDATE projects SET last_activity_at = updated_at
       WHERE last_activity_at IS NULL OR last_activity_at = ''`,
    )
    .run();
  return Number(result.changes);
}

/**
 * Turns the free text in `signal_posts.campaign` into `signal_campaigns` rows and the join that
 * attaches them, and returns how many campaigns it created and how many posts it attached.
 *
 * ## What resolves to what
 *
 * Names are normalised by the one shared rule (`normalizeSignalCampaignName`, which is
 * `normalizeTagName`): the ends trimmed and runs of inner whitespace collapsed. Matching is
 * case-insensitive, enforced by the `COLLATE NOCASE` uniqueness on the name column, so two
 * spellings of one campaign become one row. **The spelling kept is the one the earliest post
 * carrying it used** — ordered by `created_at` then `id`, which is deterministic and reproducible
 * from the rows themselves. `CAMPAIGN` on a post written in March and `Campaign` on one written in
 * May resolve to a single campaign named `CAMPAIGN`, and both posts are attached to it.
 *
 * The archive's labels are `Clarity Campaign — Wk1: The Problem` and its siblings, so a workspace
 * carrying it gains one campaign per week rather than one per campaign. That is deliberately not
 * unpicked here: splitting on a dash would be this migration inventing a vocabulary the user never
 * typed, where keeping the label whole preserves exactly what they wrote. A post can belong to
 * several campaigns now, so anyone who wants the coarser grouping can add it and keep the week.
 *
 * ## Why it runs on every boot
 *
 * The same reason `backfillProjectActivity` does: the tables are created by one statement and
 * filled by another, so a crash between them would otherwise leave those posts unclassified for
 * good. Idempotent — it reads only posts that have a campaign string and no join row yet, so a
 * second run writes nothing, and a post deliberately detached afterwards is **not** re-attached,
 * because the detach left a row that no longer has the string's campaign among its own.
 *
 * A post whose campaign column is empty or whitespace is left alone: that is a post with no
 * campaign, not a post with a campaign called nothing.
 */
export function backfillSignalCampaigns(db: Db): { campaigns: number; attachments: number } {
  const pending = db
    .prepare(
      `SELECT id, campaign FROM signal_posts
        WHERE campaign IS NOT NULL AND TRIM(campaign) <> ''
          AND id NOT IN (SELECT post_id FROM signal_post_campaigns)
        ORDER BY created_at, id`,
    )
    .all() as unknown as { id: string; campaign: string }[];
  if (pending.length === 0) return { campaigns: 0, attachments: 0 };

  // The lookup and both writes are one transaction: a post attached to a campaign that was not
  // created, or a campaign created with nothing attached to it, would be a half-migrated row.
  return transaction(db, () => {
    const find = db.prepare('SELECT id FROM signal_campaigns WHERE name=? COLLATE NOCASE');
    const insertCampaign = db.prepare(
      'INSERT INTO signal_campaigns(id,name,color) VALUES(?,?,NULL)',
    );
    const attach = db.prepare(
      'INSERT OR IGNORE INTO signal_post_campaigns(post_id,campaign_id) VALUES(?,?)',
    );
    let campaigns = 0;
    let attachments = 0;
    for (const post of pending) {
      // The rule is one line of `shared/types.ts`, restated here rather than imported: this module
      // is the schema and deliberately imports nothing from `shared/`, and the rule is a trim and a
      // whitespace collapse. `sameTagName`'s case-insensitivity is the `COLLATE NOCASE` lookup.
      const name = post.campaign.trim().replace(/\s+/g, ' ');
      if (!name) continue;
      let campaignId = (find.get(name) as { id: string } | undefined)?.id;
      if (!campaignId) {
        campaignId = crypto.randomUUID();
        insertCampaign.run(campaignId, name);
        campaigns += 1;
      }
      attachments += Number(attach.run(post.id, campaignId).changes);
    }
    return { campaigns, attachments };
  });
}

export function createDb(
  filename = config.databasePath,
  onMigration?: (statements: readonly string[]) => void,
): Db {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  // WAL lets readers continue while a writer is active. A busy timeout gives a concurrent
  // writer (backup rehearsal, migration script, or another process) a short window to finish
  // instead of making BEGIN IMMEDIATE fail as soon as it meets the lock.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(tableSchema);
  const applied = applyAdditiveMigrations(db);
  backfillProjectActivity(db);
  backfillSignalCampaigns(db);
  db.exec(indexSchema);
  db.exec('PRAGMA optimize');
  onMigration?.(applied);
  return db;
}

let singleton: Db | undefined;
export function getDb() {
  return (singleton ??= createDb());
}

export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
