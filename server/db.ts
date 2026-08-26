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
--
-- lifecycle and delivery_provenance are separate from status on purpose (C107). status stays the
-- person's Draft / Scheduled / Published claim. lifecycle = RETIRED hides a plan from ordinary
-- views while keeping publication history; delivery_provenance = OUTSIDE_SIGNAL records that the
-- content went out outside this app and is never a substitute for a publication row. Neutral
-- defaults preserve every historical row as an active in-Signal plan.
CREATE TABLE IF NOT EXISTS signal_posts (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, date TEXT, time TEXT NOT NULL DEFAULT '09:00',
  format TEXT NOT NULL DEFAULT 'TEXT', status TEXT NOT NULL DEFAULT 'DRAFT', campaign TEXT,
  cta TEXT NOT NULL DEFAULT 'NONE', position INTEGER NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL DEFAULT 'ACTIVE',
  retired_at TEXT,
  delivery_provenance TEXT NOT NULL DEFAULT 'IN_SIGNAL',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- One row per stable identity a Signal post carries at an authoring source. Copy and schedule are
-- deliberately absent from this key: both are ordinary edits, so neither can identify the post
-- across imports. The namespace is signal-import:<stable-source-uuid>; the external id is opaque
-- and case-sensitive. One pair can name exactly one post, while one post may have identities from
-- several sources. Retiring a post keeps its aliases; hard-delete (only when no publication
-- history exists) removes them by cascade.
CREATE TABLE IF NOT EXISTS signal_post_import_aliases (
  source_namespace TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  post_id          TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  UNIQUE (source_namespace, external_id)
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
-- Media is an ordered list of references, and a reference is one of two things (C74). This app
-- still stores no media files, serves no media bytes, and holds no media bytes at rest, and
-- nothing on this path fetches, uploads, or proxies one. The single exception the repository has
-- decided is half built: server/drive/media.ts resolves one user-selected Drive file to the
-- metadata and version evidence below and reads nothing; C75 is the card that streams its bytes
-- straight to the provider during a confirmed submit, storing nothing. A provider media id is
-- ephemeral either way -- never a durable reference here, and recreated on every submit, update,
-- and restore-and-resubmit.
--
-- source discriminates the two. url stays NOT NULL for both and is what every display and
-- selection path reads: a URL row stores the public URL and a DRIVE row stores Drive's canonical
-- webViewLink, which is a viewer page for a person to open and never provider-fetchable media.
--
-- The Drive columns are the identity and the version fingerprint together, because a file id is
-- not evidence of the bytes anyone previewed: Drive may replace a file's content under the same
-- id. drive_verified_at is when this app last resolved the rest, which is a fact about the
-- resolution rather than about the file -- it is what the composer shows and deliberately not part
-- of the fingerprint the plan hash covers.
CREATE TABLE IF NOT EXISTS signal_post_media (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position >= 0), url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'URL' CHECK(source IN ('URL','DRIVE')),
  drive_file_id TEXT, drive_name TEXT, mime_type TEXT, size_bytes INTEGER,
  drive_version TEXT, drive_modified_at TEXT, drive_checksum TEXT, drive_verified_at TEXT,
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
-- server -- the rule signal_post_media above states, restated because a byte path arriving for the
-- publishing stream does not make one for this table.
--
-- cover_image_url and thumbnail_url are frozen (C76). They held a role as a URL string, which a
-- Drive-backed role cannot be without overloading a column whose contract is "URL string", so a
-- role now lives in signal_post_variant_media below. backfillSignalVariantRoleMedia moves each
-- legacy value into a URL role row exactly once and clears the column in the same transaction, so
-- there is one writable source of truth rather than two. The columns are kept rather than dropped
-- for the reason signal_posts.campaign is: this module is additive by design and a drop is a table
-- rebuild. Nothing reads them after the backfill and nothing writes them again.
CREATE TABLE IF NOT EXISTS signal_post_variants (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, account_id INTEGER,
  caption TEXT, media_urls TEXT, post_kind TEXT, title TEXT, first_comment TEXT,
  disclose_synthetic_media INTEGER, cover_image_url TEXT, thumbnail_url TEXT,
  updated_at TEXT NOT NULL,
  CHECK(account_id IS NULL OR account_id > 0)
);
-- One media role on one variant layer: the cover image or the thumbnail a platform, or one of its
-- accounts, would send. Keyed the way the layer above is keyed, plus the role, so a layer carries at
-- most one of each; the uniqueness is the expression index below for the same reason -- the platform
-- layer's account_id is NULL and SQLite would not have refused a duplicate.
--
-- The reference itself is signal_post_media's contract, column for column: source discriminates a
-- public https URL from a version-bound Drive file, url stays NOT NULL for both and is Drive's
-- viewer page on a DRIVE row, and the Drive columns are the identity and the version fingerprint
-- together. The same two triggers below enforce the same cross-field rule, because a second table
-- holding the same kind of thing under a weaker rule is the first place the rule stops being true.
--
-- This stores no bytes and fetches nothing, like every other reference in this file. A role also
-- reaches no provider field yet: the live probe left Instagram's cover_image and YouTube's thumbnail
-- unverified, so a stored role is warned about in the preview rather than uploaded (C76, and
-- docs/post-bridge-api-surface.md section 14).
CREATE TABLE IF NOT EXISTS signal_post_variant_media (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, account_id INTEGER,
  role TEXT NOT NULL CHECK(role IN ('COVER_IMAGE','THUMBNAIL')),
  url TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'URL' CHECK(source IN ('URL','DRIVE')),
  drive_file_id TEXT, drive_name TEXT, mime_type TEXT, size_bytes INTEGER,
  drive_version TEXT, drive_modified_at TEXT, drive_checksum TEXT, drive_verified_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK(account_id IS NULL OR account_id > 0)
);
-- Which provider accounts a person explicitly chose for one Signal channel (C77).
-- Provider-owned account ids are opaque. The integer below is this database's surrogate and the
-- provider plus provider_account_ref pair is the durable identity. Existing Post Bridge numeric
-- ids are preserved as surrogates by backfillProviderAccounts, so every historical join keeps the
-- same value while Buffer ids can remain arbitrary text.
CREATE TABLE IF NOT EXISTS signal_provider_accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_account_ref TEXT NOT NULL,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(provider, provider_account_ref)
);

--
-- This is a **choice**, not a copy of a provider account record: the row holds the local surrogate
-- for the provider-qualified identity the user picked. Current display metadata lives on
-- signal_provider_accounts and can refresh without changing this relationship.
--
-- **No rows means unchanged.** A post with no row for a channel resolves exactly as it did before
-- this table existed -- server/publish/plan.ts finds the channel's single account and refuses zero
-- or several -- so the table is additive in behaviour as well as in schema, and an existing
-- database arrives with it empty and publishes identically.
--
-- Uniqueness is one row per (post, channel, account): selecting the same account twice for one
-- channel is the same selection, and the index makes a repeated write idempotent rather than
-- something the service has to remember to guard.
CREATE TABLE IF NOT EXISTS signal_post_publish_targets (
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  provider_account_id INTEGER NOT NULL CHECK(provider_account_id > 0),
  created_at TEXT NOT NULL
);
-- Delivery, which is a different fact from the planning status on signal_posts. checked_at is
-- the last reconciliation of either kind and check_attempts is the automatic budget alone, so a
-- manual refresh can update what the planner shows without spending a scheduled check.
CREATE TABLE IF NOT EXISTS signal_publications (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL, provider TEXT NOT NULL, provider_post_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  -- NULL means the provider was asked to post immediately (Publish now); a string is the explicit
  -- instant that was sent for scheduled publishing.
  scheduled_instant TEXT, timezone TEXT NOT NULL,
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
  -- Versioned source evidence and the ephemeral provider ids used for this exact attempt. NULL on
  -- legacy and URL-only rows; neither column stores bytes or a reusable provider reference.
  sent_media_sources TEXT, sent_provider_media_ids TEXT,
  -- What each account was handed, as its own versioned snapshot rather than a new meaning for
  -- sent_configurations (C77). The legacy column is the JSON platform_configurations and stays
  -- exactly that: a row written before this existed must keep reading the way it always did, and
  -- overloading it would make every old row ambiguous rather than merely silent about accounts.
  --
  -- NULL is **unknown**, not "no accounts were tailored". A migrated row and a row that genuinely
  -- sent nothing per account are different facts, and only one of them can be compared against a
  -- plan -- so reconciliation reports no account drift at all where this is NULL.
  sent_account_configurations TEXT,
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
  post_result_id TEXT, remote_post_id TEXT,
  -- Buffer owns one post per target. These fields snapshot that target's last answered remote state
  -- and preconditions independently, so editing or cancelling one channel cannot rewrite another.
  remote_state TEXT, remote_updated_at TEXT, remote_allowed_actions TEXT,
  sent_text TEXT, sent_due_at TEXT,
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
--
-- match_confidence and platform_post_id are the provider's provenance for the figures, added by C79
-- and nullable on purpose. They say how the provider matched this record to the platform's content
-- and what the platform's own id for that content is; they say nothing about how accurate the four
-- counts are, and neither column has a default. A row written before they existed stays NULL, which
-- reads as "the provider said nothing" -- the same answer a fresh row gets when the provider sends
-- nothing, and the only honest one while docs/post-bridge-api-surface.md §14 records the live match
-- values as unverified. match_confidence holds a short lower-case token or nothing at all; the shape
-- rule is analyticsMatchStorable in shared/publish-analytics.ts and it is enforced on the way in.
CREATE TABLE IF NOT EXISTS signal_post_metrics (
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  provider_account_id INTEGER NOT NULL,
  post_result_id TEXT NOT NULL, analytics_id TEXT NOT NULL, platform TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  share_url TEXT, provider_synced_at TEXT, synced_at TEXT NOT NULL,
  match_confidence TEXT, platform_post_id TEXT,
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
-- Legacy Post Bridge inventory. It stays frozen after its additive migration into
-- signal_provider_inventory_posts; current inventory reads and writes use the provider-qualified
-- replacement below.
--
-- provider_post_id is the primary key because it is the provider's stable identity for a post --
-- C73 verified that every listed row carries an id and that a deleted post is absent from a later
-- complete read (docs/post-bridge-api-surface.md section 14, question 4), which together are what
-- make a generation replaceable by id and absence readable as deletion.
--
-- No raw response and no unbounded caption. caption_excerpt is bounded by
-- providerInventoryCaptionExcerpt because a row exists to answer "is this one of mine", not to hold
-- a copy of content the provider owns; provider_url is NULL unless the provider supplied an address,
-- and nothing here invents one.
--
-- account_ids is a JSON array, which is the one place in the Signal schema that packs ids into a
-- column on purpose. The normalized-join rule is about labels a person maintains -- tags,
-- categories, campaigns -- where a rename is one write and a lookup has to be joinable. This is
-- neither: it is somebody else's record of somebody else's post, replaced whole on every refresh,
-- never filtered on, and never renamed. A join table would be a second generation to keep in step
-- with this one, which is exactly the mixed-generation state the card refuses. It is the same
-- reasoning signal_publications.sent_channels is stored under.
--
-- Nothing here is ever written by a failed refresh. Every page is read before the first statement
-- runs, and the replacement -- delete the ids the provider no longer lists, upsert the rest, stamp
-- snapshot_at -- is one transaction, so a refusal leaves the whole prior generation in place rather
-- than half of a new one.
CREATE TABLE IF NOT EXISTS signal_provider_posts (
  provider_post_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  scheduled_instant TEXT,
  caption_excerpt TEXT NOT NULL,
  account_ids TEXT NOT NULL DEFAULT '[]',
  provider_url TEXT,
  snapshot_at TEXT NOT NULL
);
-- Provider-qualified replacement for signal_provider_posts. The legacy table stays in the schema
-- because migrations are additive; backfillProviderInventory moves its rows here idempotently and
-- every current read/write uses this table. A Buffer post id may therefore equal a Post Bridge post
-- id without either row shadowing the other.
CREATE TABLE IF NOT EXISTS signal_buffer_channels (
  channel_id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  platform TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  handle TEXT NOT NULL DEFAULT '',
  is_disconnected INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  is_queue_paused INTEGER NOT NULL DEFAULT 0,
  unavailable TEXT,
  snapshot_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_provider_inventory_posts (
  provider TEXT NOT NULL,
  provider_post_id TEXT NOT NULL,
  state TEXT NOT NULL,
  scheduled_instant TEXT,
  caption_excerpt TEXT NOT NULL,
  account_refs TEXT NOT NULL DEFAULT '[]',
  provider_url TEXT,
  snapshot_at TEXT NOT NULL,
  PRIMARY KEY(provider, provider_post_id)
);
-- What the provider reports for one platform over one of its own windows: a second, cheaper
-- question than the per-delivery figures, stored separately because it answers something different.
--
-- This table never replaces signal_post_metrics and is never read in its place. Those rows answer
-- "what did this delivery get", asked by post_result_id, and are refreshed per post; these answer
-- "what does the provider report for this platform over this window", asked by platform and
-- timeframe, and are replaced as one generation. A window row is not a better copy of a metrics row
-- -- the two can legitimately disagree, because the provider chose which deliveries the window names
-- and this app chose which deliveries the per-post refresh asked about.
--
-- Keyed (platform, timeframe, post_result_id) because that is what one row is: the provider's reading
-- for one delivery inside one window of one platform. post_result_id is the provider's own identity
-- for the delivery and is NOT NULL -- the wire parser refuses a page carrying a row without one,
-- because docs/post-bridge-api-surface.md section 14 records the response grain as unverified and a
-- row that cannot be attributed might be an account aggregate rather than a delivery.
--
-- No foreign key to signal_publication_targets, deliberately. A row the provider named that no local
-- delivery claims is ordinary and is kept: it is counted as unmapped, shown as unmapped, and never
-- added into an account total. A foreign key would delete exactly the rows that carry that
-- information, and the join is by post_result_id at read time instead
-- (idx_signal_publication_targets_result already exists for it).
--
-- Nothing here is ever written by a failed refresh. Every page is read before the first statement
-- runs, and the replacement -- delete this platform/timeframe generation, insert the new one, stamp
-- refreshed_at -- is one transaction, so a refusal leaves the whole prior snapshot in place rather
-- than half of a new one. refreshed_at is this app's own clock for the generation; provider_synced_at
-- is the provider's own last_synced_at for the row, and one being fresh does not make the other
-- fresh. match_confidence and platform_post_id are provenance under exactly the rules the
-- per-delivery table states, read by the same shared function, and neither has a default.
CREATE TABLE IF NOT EXISTS signal_analytics_window_metrics (
  platform TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  post_result_id TEXT NOT NULL,
  analytics_id TEXT NOT NULL,
  row_platform TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  provider_synced_at TEXT, match_confidence TEXT, platform_post_id TEXT,
  refreshed_at TEXT NOT NULL,
  PRIMARY KEY(platform, timeframe, post_result_id)
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
-- Lifecycle filter for planner / calendar / queue lists that default to active plans only.
CREATE INDEX IF NOT EXISTS idx_signal_posts_lifecycle ON signal_posts(lifecycle);
-- Imports resolve an alias by its unique pair. This reverse index serves post deletion and any
-- later inspection of the identities one post is known by.
CREATE INDEX IF NOT EXISTS idx_signal_post_import_aliases_post
  ON signal_post_import_aliases(post_id);
CREATE INDEX IF NOT EXISTS idx_signal_post_channels_channel ON signal_post_channels(channel);
-- The campaign side of the join: what a campaign's deletion has to detach, what its post count
-- counts, and what the segmented analytics read walks. The post side is the primary key's prefix.
CREATE INDEX IF NOT EXISTS idx_signal_post_campaigns_campaign
  ON signal_post_campaigns(campaign_id);
-- One layer per platform and one per account, enforced over the coalesced key because the platform
-- layer's account_id is NULL and SQLite's PRIMARY KEY would not have refused a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_post_variants_layer
  ON signal_post_variants(post_id, platform, COALESCE(account_id, -1));
-- One row per role per layer, over the coalesced key for the same reason the layer index is.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_post_variant_media_role
  ON signal_post_variant_media(post_id, platform, COALESCE(account_id, -1), role);
-- One selection per account per channel. account_id is NOT NULL here, unlike the variant layers,
-- so an ordinary unique index is the whole rule.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_post_publish_targets_choice
  ON signal_post_publish_targets(post_id, channel, provider_account_id);
CREATE INDEX IF NOT EXISTS idx_signal_post_publish_targets_post
  ON signal_post_publish_targets(post_id);
CREATE INDEX IF NOT EXISTS idx_signal_provider_accounts_platform
  ON signal_provider_accounts(provider, platform, id);
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
-- The inventory panel and the orphan alert both read the generation in schedule order, soonest
-- first, and a workspace can hold a page of it. The primary key answers the replacement's own
-- lookups, so this is the only other access path there is.
CREATE INDEX IF NOT EXISTS idx_signal_provider_posts_scheduled
  ON signal_provider_posts(scheduled_instant);
CREATE INDEX IF NOT EXISTS idx_signal_provider_inventory_scheduled
  ON signal_provider_inventory_posts(provider, scheduled_instant);
`;

/**
 * The cross-field rule on `signal_post_media` and `signal_post_variant_media`, in the strongest
 * form SQLite can be given *additively*.
 *
 * A CHECK constraint would be the natural home, and the fresh-install schema above carries the ones
 * a single column can hold. It cannot be the whole answer: a cross-column CHECK has to be a table
 * constraint, SQLite adds table constraints only by rebuilding the table, and
 * `applyAdditiveMigrations` is additive by design. Worse, `PRAGMA table_info` does not report CHECK
 * constraints at all, so even the column-level ones above are dropped on the `ALTER TABLE` path — a
 * database migrated into these columns would have no constraint whatsoever.
 *
 * A trigger has neither problem. `CREATE TRIGGER IF NOT EXISTS` is additive, it reaches a migrated
 * database and a fresh one identically, and it can see every column at once. These say exactly what
 * `signalPostMediaIssue` in `shared/signal-media.ts` says, restated here rather than imported
 * because this module is the schema and imports nothing from `shared/` -- and stated at all because
 * a rule enforced only at the Zod boundary is a rule the next writer of an INSERT walks around.
 *
 * The predicate is built once and spent on both tables rather than typed out four times. C76 added
 * the second table, and a copy of this condition that had drifted by one column would be a
 * discriminated reference that is discriminated in one place and not the other.
 *
 * They run after the migration, for the same reason the indexes do: the columns have to exist.
 * Existing rows are untouched -- a migrated URL row has `source='URL'` from the column default and
 * NULL in every Drive column, which is precisely the first branch.
 */
const MEDIA_SOURCE_MESSAGE =
  'a URL reference carries no Drive fields, and a DRIVE reference needs an id, a name, a MIME type, a positive size, and at least one version signal.';

const mediaSourceRule = `(
  (NEW.source = 'URL'
    AND NEW.drive_file_id IS NULL AND NEW.drive_name IS NULL AND NEW.mime_type IS NULL
    AND NEW.size_bytes IS NULL AND NEW.drive_version IS NULL AND NEW.drive_modified_at IS NULL
    AND NEW.drive_checksum IS NULL AND NEW.drive_verified_at IS NULL)
  OR (NEW.source = 'DRIVE'
    AND TRIM(COALESCE(NEW.drive_file_id, '')) <> ''
    AND TRIM(COALESCE(NEW.drive_name, '')) <> ''
    AND TRIM(COALESCE(NEW.mime_type, '')) <> ''
    AND NEW.size_bytes IS NOT NULL AND NEW.size_bytes > 0
    AND (NEW.drive_version IS NOT NULL OR NEW.drive_modified_at IS NOT NULL
         OR NEW.drive_checksum IS NOT NULL))
)`;

const mediaSourceTriggers = (table: string) =>
  (['INSERT', 'UPDATE'] as const)
    .map(
      (event) => `
CREATE TRIGGER IF NOT EXISTS ${table}_source_${event.toLowerCase()}
BEFORE ${event} ON ${table} FOR EACH ROW WHEN NOT ${mediaSourceRule}
BEGIN
  SELECT RAISE(ABORT, '${table}: ${MEDIA_SOURCE_MESSAGE}');
END;`,
    )
    .join('');

export const triggerSchema = `${mediaSourceTriggers('signal_post_media')}${mediaSourceTriggers(
  'signal_post_variant_media',
)}
`;

const providerAccountTriggers = `
CREATE TRIGGER IF NOT EXISTS signal_provider_accounts_delete_restrict
BEFORE DELETE ON signal_provider_accounts FOR EACH ROW WHEN
  EXISTS (SELECT 1 FROM signal_post_publish_targets WHERE provider_account_id=OLD.id)
  OR EXISTS (SELECT 1 FROM signal_publication_targets WHERE provider_account_id=OLD.id)
  OR EXISTS (SELECT 1 FROM signal_post_metrics WHERE provider_account_id=OLD.id)
  OR EXISTS (SELECT 1 FROM signal_post_metric_days WHERE provider_account_id=OLD.id)
  OR EXISTS (SELECT 1 FROM signal_post_variants WHERE account_id=OLD.id)
  OR EXISTS (SELECT 1 FROM signal_post_variant_media WHERE account_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'signal_provider_accounts: referenced account history cannot be deleted.');
END;
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
 * Relaxes `signal_publications.scheduled_instant` from NOT NULL to nullable so Publish now rows
 * can record the absence of a scheduled instant. SQLite cannot drop NOT NULL through `ALTER TABLE`,
 * so an existing table is rebuilt once when the live column still carries the constraint.
 */
export function relaxPublicationScheduledInstant(db: Db): boolean {
  const column = tableInfo(db, 'signal_publications').find(
    (entry) => entry.name === 'scheduled_instant',
  );
  if (!column?.notnull) return false;
  transaction(db, () => {
    db.exec(`CREATE TABLE signal_publications_scheduled_instant_migration (
      id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE RESTRICT,
      state TEXT NOT NULL, provider TEXT NOT NULL, provider_post_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, scheduled_instant TEXT, timezone TEXT NOT NULL,
      sent_caption TEXT NOT NULL, sent_channels TEXT NOT NULL, error TEXT,
      sent_media TEXT, sent_configurations TEXT,
      sent_media_sources TEXT, sent_provider_media_ids TEXT,
      sent_account_configurations TEXT,
      checked_at TEXT, check_attempts INTEGER NOT NULL DEFAULT 0,
      checked_state TEXT, prior_state TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    db.exec(`INSERT INTO signal_publications_scheduled_instant_migration
      SELECT id, post_id, state, provider, provider_post_id, idempotency_key, scheduled_instant,
             timezone, sent_caption, sent_channels, error, sent_media, sent_configurations,
             sent_media_sources, sent_provider_media_ids, sent_account_configurations,
             checked_at, check_attempts, checked_state, prior_state, created_at, updated_at
        FROM signal_publications`);
    db.exec('DROP TABLE signal_publications');
    db.exec(
      'ALTER TABLE signal_publications_scheduled_instant_migration RENAME TO signal_publications',
    );
  });
  return true;
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

/**
 * Moves the legacy `cover_image_url` and `thumbnail_url` values on `signal_post_variants` into
 * `signal_post_variant_media` role rows, once, and returns how many it moved.
 *
 * ## Why it moves rather than copies
 *
 * C76's rule is one writable source of truth. A copy would leave two columns and two rows saying
 * what a layer's cover is, and the next edit would have to keep both — which is the state this
 * migration exists to end. So each value becomes a `URL` role row and the column it came from is
 * set to NULL **in the same transaction**: after this, the columns are frozen in the strict sense
 * that they hold nothing and nothing writes them.
 *
 * That is also what makes it idempotent in the only way that matters. A second run finds no
 * non-null legacy value and writes nothing, and — more to the point — a role a person deliberately
 * removed after the migration is **not** resurrected, because the column it would have come back
 * from is empty. Guarding on "the layer has no role row yet" instead would have re-added it on the
 * next boot.
 *
 * `INSERT OR IGNORE` covers the one case where both could exist: a database that already carries a
 * role row for that layer and role, written by this release, keeps the row it has and the legacy
 * value is still cleared. The stored row is the newer statement of the two by construction.
 *
 * Runs on every boot, for the same reason `backfillProjectActivity` and `backfillSignalCampaigns`
 * do: the table is created by one statement and filled by another, and a crash between them would
 * otherwise strand those values for good.
 */
export function backfillSignalVariantRoleMedia(db: Db): number {
  const pending = db
    .prepare(
      `SELECT post_id, platform, account_id, cover_image_url, thumbnail_url, updated_at
         FROM signal_post_variants
        WHERE (cover_image_url IS NOT NULL AND TRIM(cover_image_url) <> '')
           OR (thumbnail_url IS NOT NULL AND TRIM(thumbnail_url) <> '')`,
    )
    .all() as unknown as {
    post_id: string;
    platform: string;
    account_id: number | null;
    cover_image_url: string | null;
    thumbnail_url: string | null;
    updated_at: string;
  }[];
  if (pending.length === 0) return 0;

  return transaction(db, () => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO signal_post_variant_media(
         post_id, platform, account_id, role, url, source, updated_at
       ) VALUES(?,?,?,?,?, 'URL', ?)`,
    );
    const clear = db.prepare(
      `UPDATE signal_post_variants SET cover_image_url=NULL, thumbnail_url=NULL
        WHERE post_id=? AND platform=? AND account_id IS ?`,
    );
    let moved = 0;
    for (const layer of pending) {
      for (const [role, url] of [
        ['COVER_IMAGE', layer.cover_image_url],
        ['THUMBNAIL', layer.thumbnail_url],
      ] as const) {
        const value = url?.trim();
        if (!value) continue;
        insert.run(layer.post_id, layer.platform, layer.account_id, role, value, layer.updated_at);
        moved += 1;
      }
      clear.run(layer.post_id, layer.platform, layer.account_id);
    }
    return moved;
  });
}

const LEGACY_PROVIDER = 'post-bridge';
const MIGRATED_AT = '1970-01-01T00:00:00.000Z';

/** Provider platform for a legacy Signal channel, without importing shared code into the schema. */
const legacyPlatformFor = (channel: string): string =>
  ({
    fb: 'facebook',
    ig: 'instagram',
    in: 'linkedin',
    tt: 'tiktok',
    yt: 'youtube',
    th: 'threads',
    x: 'twitter',
    bs: 'bluesky',
  })[channel] ?? channel;

/**
 * Gives every legacy numeric account a provider-qualified identity without moving any join key.
 *
 * The transaction inserts each Post Bridge row at its historical numeric id. A conflicting partial
 * migration is refused rather than guessed at, so startup cannot expose a database where one
 * surrogate means two providers. Running again verifies the same rows and writes nothing.
 */
export function backfillProviderAccounts(db: Db): number {
  const referenced = db
    .prepare(
      `SELECT provider_account_id AS id FROM signal_post_publish_targets
       UNION SELECT provider_account_id FROM signal_publication_targets
       UNION SELECT provider_account_id FROM signal_post_metrics
       UNION SELECT provider_account_id FROM signal_post_metric_days
       UNION SELECT account_id FROM signal_post_variants WHERE account_id IS NOT NULL
       UNION SELECT account_id FROM signal_post_variant_media WHERE account_id IS NOT NULL
       ORDER BY id`,
    )
    .all() as { id: number }[];
  const ids = new Set(referenced.map((row) => row.id));
  for (const row of db.prepare('SELECT account_ids FROM signal_provider_posts').all() as {
    account_ids: string;
  }[]) {
    try {
      const values: unknown = JSON.parse(row.account_ids);
      if (Array.isArray(values))
        for (const value of values)
          if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ids.add(value);
    } catch {
      // A malformed legacy inventory is still copied as an empty account list by the inventory
      // migration. It must not make a valid delivery migration guess at an identity.
    }
  }
  if (!ids.size) return 0;

  return transaction(db, () => {
    const byId = db.prepare(
      'SELECT provider, provider_account_ref FROM signal_provider_accounts WHERE id=?',
    );
    const byIdentity = db.prepare(
      'SELECT id FROM signal_provider_accounts WHERE provider=? AND provider_account_ref=?',
    );
    const latestDelivery = db.prepare(
      `SELECT t.channel, t.handle, p.updated_at
         FROM signal_publication_targets t
         JOIN signal_publications p ON p.id=t.publication_id
        WHERE t.provider_account_id=?
        ORDER BY p.updated_at DESC, p.id DESC LIMIT 1`,
    );
    const planned = db.prepare(
      `SELECT channel, created_at FROM signal_post_publish_targets
        WHERE provider_account_id=? ORDER BY created_at DESC, post_id DESC LIMIT 1`,
    );
    const variant = db.prepare(
      `SELECT platform, updated_at FROM signal_post_variants
        WHERE account_id=? ORDER BY updated_at DESC, post_id DESC LIMIT 1`,
    );
    const insert = db.prepare(
      `INSERT INTO signal_provider_accounts(
         id,provider,provider_account_ref,platform,display_name,handle,
         resolved_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    let added = 0;
    for (const id of [...ids].sort((left, right) => left - right)) {
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error(`Cannot migrate provider account surrogate ${String(id)}.`);
      const ref = String(id);
      const existing = byId.get(id) as
        { provider: string; provider_account_ref: string } | undefined;
      if (existing) {
        // A row already at this id is already resolved, whichever path resolved it. Only a
        // *legacy* row is this backfill's own prior work, so only a legacy row is checked for
        // self-consistency; a modern row — Buffer, or a Post Bridge account resolved through
        // `resolveProviderAccounts` with a non-numeric ref — was never this backfill's to make
        // and is not evidence of a partial migration.
        if (existing.provider === LEGACY_PROVIDER && existing.provider_account_ref !== ref)
          throw new Error(`Provider account surrogate ${id} already names another identity.`);
        continue;
      }
      const duplicate = byIdentity.get(LEGACY_PROVIDER, ref) as { id: number } | undefined;
      if (duplicate)
        throw new Error(
          `Post Bridge account ${ref} already uses surrogate ${duplicate.id}, not legacy id ${id}.`,
        );
      const delivery = latestDelivery.get(id) as
        { channel: string; handle: string; updated_at: string } | undefined;
      const choice = planned.get(id) as { channel: string; created_at: string } | undefined;
      const layer = variant.get(id) as { platform: string; updated_at: string } | undefined;
      const platform = delivery
        ? legacyPlatformFor(delivery.channel)
        : choice
          ? legacyPlatformFor(choice.channel)
          : (layer?.platform ?? 'unknown');
      const timestamp =
        delivery?.updated_at ?? choice?.created_at ?? layer?.updated_at ?? MIGRATED_AT;
      insert.run(
        id,
        LEGACY_PROVIDER,
        ref,
        platform,
        delivery?.handle ?? '',
        delivery?.handle ?? '',
        timestamp,
        timestamp,
        timestamp,
      );
      added += 1;
    }
    return added;
  });
}

/** Moves the legacy Post Bridge inventory into the provider-qualified table, idempotently. */
export function backfillProviderInventory(db: Db): number {
  const legacy = db.prepare('SELECT * FROM signal_provider_posts').all() as {
    provider_post_id: string;
    state: string;
    scheduled_instant: string | null;
    caption_excerpt: string;
    account_ids: string;
    provider_url: string | null;
    snapshot_at: string;
  }[];
  if (!legacy.length) return 0;
  return transaction(db, () => {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO signal_provider_inventory_posts(
         provider,provider_post_id,state,scheduled_instant,caption_excerpt,
         account_refs,provider_url,snapshot_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    let added = 0;
    for (const row of legacy) {
      let refs: string[] = [];
      try {
        const values: unknown = JSON.parse(row.account_ids);
        if (Array.isArray(values))
          refs = values.flatMap((value) =>
            typeof value === 'string' || typeof value === 'number' ? [String(value)] : [],
          );
      } catch {
        refs = [];
      }
      added += Number(
        insert.run(
          LEGACY_PROVIDER,
          row.provider_post_id,
          row.state,
          row.scheduled_instant,
          row.caption_excerpt,
          JSON.stringify(refs),
          row.provider_url,
          row.snapshot_at,
        ).changes,
      );
    }
    return added;
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
  relaxPublicationScheduledInstant(db);
  backfillProjectActivity(db);
  backfillSignalCampaigns(db);
  backfillProviderAccounts(db);
  backfillProviderInventory(db);
  db.exec(indexSchema);
  db.exec(triggerSchema);
  db.exec(providerAccountTriggers);
  // After the index and the triggers, and deliberately: the role rows it writes go through the
  // same uniqueness and the same cross-field rule every later write does, so the migration cannot
  // put a row in that an ordinary INSERT would have been refused.
  backfillSignalVariantRoleMedia(db);
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
