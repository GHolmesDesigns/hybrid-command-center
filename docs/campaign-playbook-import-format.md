# Campaign Playbook Import Format

Status: implemented. The Import module reads this format — see [Importer behavior](#importer-behavior)
for the two places the shipped importer settled a rule this specification left open, and for the
pasted text form the modal also accepts.

Schema version: `1`

Authoring source: [Campaign Playbook Import Format](https://docs.google.com/spreadsheets/d/1ZZfGhULg2bG5UIz6gDCIXcHXJeaAOgNB_NQ1dftoVOI/edit)

Versioned example: [`examples/campaign-playbook-import-format.xlsx`](examples/campaign-playbook-import-format.xlsx)

## Purpose and format

A Campaign Playbook is an XLSX workbook that describes clients, their projects, the projects' tasks, task checklist items, and task dependencies. A future importer can use it to preview and then create a complete campaign hierarchy in one confirmed action.

The hierarchy is split across tabs rather than flattened into one table:

```text
Client -> Project -> Task -> ChecklistItem
                         \-> Dependency -> prerequisite Task
```

Separate tabs avoid repeating parent metadata on every child row and allow validation errors to identify an exact sheet, row, and column. Strategy documents and campaign narratives remain ordinary project files; the workbook describes the execution records created in the app.

The required data tabs are `Clients`, `Projects`, `Tasks`, and `ChecklistItems`. `Dependencies` is optional and may be empty. `README`, `DataDictionary`, and `AllowedValues` are documentation tabs and are ignored by the importer.

## Workbook rules

- Sheet names and column headers are exact and case-sensitive. Unknown data tabs or columns are errors.
- Cells contain literal values only. Formulas, macros, merged data cells, and hidden data are rejected.
- Fully blank rows are ignored. A partially populated row is an error.
- Dates are literal `YYYY-MM-DD` calendar values. Excel date serials and timezone conversion are not allowed.
- Optional blank fields become `null` unless a default is documented below.
- `schema_version` is `1`. An importer must reject versions it does not support.

### Workbook-local keys

`client_key`, `project_key`, and `task_key` connect rows within one workbook. They are not SQLite IDs and do not need to match a key in another workbook or earlier import.

Keys are:

- required on the row that defines them;
- trimmed and case-sensitive;
- 1-64 characters;
- matched by `[A-Z][A-Z0-9_-]*`;
- unique within their defining tab.

References must match the defining key exactly. Duplicate keys and unresolved references are preview errors.

### Ordering

Workbook order values are positive, one-based integers. Duplicate values within one ordering scope are errors. Gaps are allowed and are normalized to zero-based storage while preserving sort order.

- `Projects.position`: workbook-wide.
- `Tasks.position`: within a project and status.
- `ChecklistItems.item_order`: within a task.

## Field mapping

### Clients

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `client_key` | Workbook reference only | Yes | Unique client key. |
| `name` | `clients.name` | Yes | Trimmed, 2-120 characters. |
| `contact_name` | `clients.contact_name` | No | Text. |
| `email` | `clients.email` | No | Valid email. |
| `phone` | `clients.phone` | No | Text; punctuation and a leading plus sign are preserved. |
| `website` | `clients.website` | No | Absolute URL. |
| `notes` | `clients.notes` | No | Literal text. |

New clients default to active. Drive identifiers and provisioning state are never supplied by a workbook.

### Projects

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `project_key` | Workbook reference only | Yes | Unique project key. |
| `client_key` | Resolves `projects.client_id` | Yes | Must reference `Clients.client_key`. |
| `name` | `projects.name` | Yes | Trimmed, 2-160 characters. |
| `status` | `projects.status` | No | Default `ACTIVE`; use an allowed value below. |
| `priority` | `projects.priority` | No | Default `MEDIUM`; use an allowed value below. |
| `start_date` | `projects.start_date` | No | Real `YYYY-MM-DD` date. |
| `target_deadline` | `projects.target_deadline` | No | Real `YYYY-MM-DD` date, not before `start_date`. |
| `description` | `projects.description` | No | Literal text. |
| `notes` | `projects.notes` | No | Literal text. |
| `position` | `projects.position` | No | Positive integer; default is the next position. |

### Tasks

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `task_key` | Workbook reference only | Yes | Unique task key. |
| `project_key` | Resolves `tasks.project_id` | Yes | Must reference `Projects.project_key`. |
| `title` | `tasks.title` | Yes | Trimmed, 2-200 characters. |
| `task_type` | `tasks.task_type` | No | Blank or an allowed task type below. |
| `status` | `tasks.status` | No | Default `BACKLOG`; use an allowed value below. |
| `priority` | `tasks.priority` | No | Default `MEDIUM`; use an allowed value below. |
| `start_date` | `tasks.start_date` | No | Real `YYYY-MM-DD` date. |
| `due_date` | `tasks.due_date` | No | Real `YYYY-MM-DD` date, not before `start_date`. |
| `description` | `tasks.description` | No | Literal text. |
| `notes` | `tasks.notes` | No | Literal text. |
| `position` | `tasks.position` | No | Positive integer; default is the next position in the project/status scope. |

A task imported as `COMPLETE` receives a `completed_at` timestamp when the user confirms the clean preview.

### ChecklistItems

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `task_key` | Resolves `checklist_items.task_id` | Yes | Must reference `Tasks.task_key`. |
| `item_order` | `checklist_items.position` | Yes | Positive integer, one-based within the task. |
| `title` | `checklist_items.text` | Yes | Trimmed, non-empty text. |
| `completed` | `checklist_items.completed` | No | Native Boolean `TRUE` or `FALSE`; default `FALSE`. |

### Dependencies

| Column | App target | Required when row exists | Format and rules |
| --- | --- | --- | --- |
| `task_key` | Resolves `task_dependencies.task_id` | Yes | Must reference `Tasks.task_key`. |
| `prerequisite_task_key` | Resolves `task_dependencies.dependency_id` | Yes | Must reference `Tasks.task_key` and cannot equal `task_key`. |

Duplicate dependency pairs and dependency cycles are errors. Cross-project dependencies are allowed when both tasks are present in the workbook.

## Allowed values

Project status:

- `PLANNING`
- `ACTIVE`
- `ON_HOLD`
- `COMPLETE`

Task status:

- `BACKLOG`
- `TODO`
- `IN_PROGRESS`
- `REVIEW`
- `COMPLETE`

Priority:

- `LOW`
- `MEDIUM`
- `HIGH`
- `URGENT`

Task type, matching issue #11 and `shared/types.ts`:

- `BLOG_POST`
- `VIDEO`
- `SOCIAL_POST`
- `GRAPHICS`
- `SCHEDULING`
- `QA_BRAND_PASS`
- `ADMIN`
- `DEV_WORK`
- `OTHER`

## Conflict behavior

Schema version 1 is create-only. It never merges into an existing record or silently creates a duplicate.

An existing record is matched — and the row that describes it is **skipped and reported**, not created twice — when the importer finds:

- a client with the same trimmed name, compared case-insensitively;
- a project under the resolved client with the same trimmed name, compared case-insensitively;
- a task under the resolved project with the same trimmed title, compared case-insensitively, **and the same `due_date`**, where two empty due dates count as the same and an empty one never matches a filled one.

A matched client or project is what its imported children attach to; a matched task keeps the checklist and dependencies it already has. Nothing about an existing record is edited, and no field of it is overwritten.

Archived clients and projects match too, and are neither revived nor rewritten. Re-importing the same workbook therefore creates nothing the second time.

Two rows of the *same* workbook that resolve to the same record are a different matter: they are ambiguous rather than already-imported, and are reported as errors.

### Merged clients are aliases

A client that was merged into another one (**Clients → Merge client**) keeps its own name in the
workspace, archived, while its projects belong to the surviving client. Client names are not
unique, so a playbook naming a merged client resolves in this order:

1. A client with that name that has **not** been merged away wins — the rule above, unchanged,
   archived clients included.
2. Otherwise, when every client of that name was merged away, the name resolves to the client
   they were merged into. The skip reports that rule by name, rather than the ordinary
   already-exists one, so the preview says which client the work will actually attach to.
3. A merged-away client is never itself the answer. New work is never created beneath a client
   whose portfolio has been moved somewhere else.

Resolution is always one hop: merging a surviving client again retargets the aliases that pointed
at it, so an old name follows the work to whichever client holds it now. The alias is the merged
client's live name — renaming it renames the alias with it.

## Importer behavior

Two rules were settled when the importer shipped (issue #72), and this section is the authority on them.

- **Duplicates are skipped, not refused.** The earlier draft of this document refused the whole import on a conflict. The shipped importer skips each matched row, reports it with the rule that matched, and imports the rest, which is what makes a re-import and a partly-extended playbook safe. Validation errors still refuse the whole import: nothing is written while any error remains.
- **A task matches on title *and* due date.** Title alone would silently drop a weekly task that repeats under one project with a different deadline each week.

Alongside those:

- `ChecklistItems` and `Dependencies` may be absent as well as empty; both mean "none".
- `TRUE`/`FALSE` typed as text is accepted for `completed` as well as a native boolean, because a spreadsheet column formatted as text is not a different intent. A number is refused: `1` and `0` are not what this column means.
- `schema_version` is read from a `Schema version` or `schema_version` label on a documentation tab. A workbook that declares nothing is assumed to be version 1; one that declares another version is refused.
- Stored order continues what the workspace already uses rather than restarting at zero: imported projects land after the existing tiles, and imported tasks land at the bottom of their status column, in workbook order.
- A task imported as `COMPLETE` is stamped completed at the moment the import is confirmed. The workbook carries no completion timestamp, and that moment is the only one the importer can honestly claim.
- A task type's default checklist seeds only a task the workbook left without checklist rows, exactly as [Task-template overlap](#task-template-overlap) describes.
- Every import writes a receipt — counts created, skipped, and failed, with every reason — which the Import page lists after the modal closes. Receipts are pruned to the most recent 50.
- **Nothing about an import touches Google Drive.** Imported clients and projects are stored disconnected and are provisioned the next time Drive is synced from Settings.

### The pasted text form

The import modal also accepts a playbook pasted as text, for a quick import and for the tabs a person is drafting by hand. It is the same tabs, the same columns, and the same rules, transcribed:

```text
[Clients]
client_key	name	contact_name	email	phone	website	notes
CLI-GHD	G.Holmes Designs	Dana Holmes	dana@example.com			Studio-owned

[Projects]
project_key	client_key	name	status	priority	start_date	target_deadline	description	notes	position
PRJ-6WOC	CLI-GHD	Six Weeks of Clarity	ACTIVE	URGENT	2026-03-01	2026-04-12			1
```

- Each tab is introduced by its name in square brackets, alone on its line.
- Cells are separated by tabs — what a spreadsheet copies out. Blank lines are ignored.
- Row numbers in error messages count from each tab's heading, matching the rows of that tab.
- Pasted cells carry no type, so `completed` is written `TRUE` or `FALSE` and order values as plain digits. Everything else is identical to the workbook.

## Dry-run preview and confirmation

Every import begins with a read-only dry run, and the confirmation re-reads the file and re-plans against the workspace as it stands at that moment, so the write is never decided by a preview the browser is holding. A file edited between the two is refused rather than imported against the older preview.

The preview shows:

- the number of records that would be created from each tab;
- every error with sheet, row, column, and message;
- duplicate keys and duplicate natural keys;
- unresolved key references;
- self-dependencies, duplicate dependency pairs, and cycles;
- the records already in the workspace that rows resolved to, with the rule that matched;
- the duplicate rule itself, in the preview's own words, so a wrong assumption about what counts as already imported is caught before the write rather than after it.

Confirmation is enabled only for a clean preview. Nothing is written while any validation error remains; matched records are skipped rather than blocking.

After confirmation, all SQLite inserts occur in one transaction. A database failure rolls back the entire import, and the receipt that records the failure is written outside that transaction so it survives the rollback. Import never creates, renames, moves, deletes, or overwrites a Drive file or folder; imported clients and projects are provisioned by the existing Drive sync in Settings when the user next runs it.

## Task-template overlap

Campaign playbooks and issue #16 share the existing task-plus-ordered-checklist representation:

- When a task has one or more imported `ChecklistItems`, those rows are authoritative and are imported exactly once. The task-type template is not additionally seeded.
- When a task has no imported checklist rows, the issue #16 static template may seed its default checklist from `task_type`.
- Editing a template later never changes tasks already created from an import.

This avoids a second checklist representation and prevents duplicate default items.

## Examples

The versioned workbook contains two different real campaign shapes:

- **Six Weeks of Clarity:** a studio-owned, weekly-cadence campaign. The committed sample fully enumerates all six weeks: 60 tasks, their ordered checklist items, and the within-week publish dependencies.
- **AdDrive Media:** a client engagement organized around website, explainer, recruitment-ad, and recurring-content deliverables rather than a weekly production loop.

Blue and pink row colors distinguish the examples for authors. Formatting is documentary only and must not affect import behavior.
