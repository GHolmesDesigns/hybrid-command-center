# Campaign Playbook Import Format

Status: specification only. The Import module and importer are not implemented by this card.

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
- `OTHER`

## Conflict behavior

Schema version 1 is create-only. It never merges into an existing record or silently creates a duplicate.

The preview reports a conflict when it finds:

- a client with the same trimmed name, compared case-insensitively;
- a project under the resolved client with the same trimmed name, compared case-insensitively;
- a task under the resolved project with the same trimmed title, compared case-insensitively.

Archived clients and projects still count as conflicts and are not silently reused. Re-importing the same workbook is refused through the same natural-key checks.

## Dry-run preview and confirmation

Every import begins with a read-only dry run. The preview shows:

- the number of records that would be created from each tab;
- every error with sheet, row, column, and message;
- duplicate keys and duplicate natural keys;
- unresolved key references;
- self-dependencies, duplicate dependency pairs, and cycles;
- conflicts with existing records;
- the normalized order that will be stored.

Confirmation is enabled only for a clean preview. Nothing is written when any validation error or conflict remains.

After confirmation, all SQLite inserts occur in one transaction. A database failure rolls back the entire import. Client and project Drive provisioning starts only after the local transaction commits, using the existing retry-safe `PENDING` workflow. Import never renames, moves, deletes, or overwrites existing Drive files or folders.

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
