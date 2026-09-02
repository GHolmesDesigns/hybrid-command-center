# Reports v1 plan

Status: implementation plan for issue [#455](https://github.com/GHolmesDesigns/hybrid-command-center/issues/455).

This note defines the first Reports surface. It does not implement a route, query, UI, export, or
provider integration. A later implementation card must treat this document as its contract.

## Boundary

Reports v1 is a read-only view of the local SQLite workspace. A report request may execute
`SELECT` statements and may use SQLite's aggregate functions, joins, grouping, and ordering. It
must not call Drive, Signal, Post Bridge, Buffer, Calendar, or any other provider, and it must not
write SQLite rows, refresh integrations, acknowledge alerts, or alter workspace state.

The report may read the stored provider figures in `signal_post_metrics` and
`signal_post_metric_days` only as already-stored data if the implementation card explicitly includes
the delivery-figures report below. It must not refresh them. It must not introduce a new metric:
rates, ratios, averages, percentages, rankings, or per-post/per-follower normalisation are out of
scope. The only permitted analytics arithmetic is the existing provider-total addition and
`postMetricDayDeltas` subtraction described by `shared/publish-analytics.ts`; the first
implementation should omit analytics figures unless that existing contract is needed.

Archived records remain valid historical data, but the default report scope follows the dashboard's
active-work rule: exclude archived clients and projects and exclude tasks that are not active work.
The implementation card must use the existing repository/domain status vocabulary rather than
recreating status rules in React. An explicit `visibility=all` option may be added only if the
card defines its historical meaning and makes it clear that the numbers are not current-work
numbers.

## Surface and address

Reports should be a top-level `/reports` route, linked from the primary navigation. Use a page
rather than a modal: reports need a stable address, reload behavior, browser Back/Forward behavior,
and a link an operator can hand to someone else. The page may contain compact report cards, but
the route owns loading, empty, and error states.

The first implementation should support these durable query parameters:

- `from` and `to`: inclusive `YYYY-MM-DD` bounds for reports that have a date dimension;
- `client`: one client id;
- `project`: one project id, valid only within the selected client;
- `visibility`: `active` by default, with any broader scope explicitly documented by the card.

Missing or invalid values use the documented default, following
[`docs/view-state-convention.md`](view-state-convention.md). The client selection is cleared when
it no longer exists, and the project selection is cleared when it no longer belongs to that
client. Parameters are omitted when they equal the default. The route must preserve unrelated
parameters when one control changes. There is no transient text-search parameter in v1.

Example shared link:

`/reports?from=2026-09-01&to=2026-09-30&client=<client-id>&project=<project-id>`

## V1 aggregates

Each card below is one operator question and one SQL result shape. The implementation may combine
the statements into one read service, but it must keep the result fields and inclusion rules
explicit. Every count is a count of rows or distinct ids named in the source column; none is a
derived rate.

### 1. Workspace inventory

**Question:** “How much active work is in this workspace, and how much planned Signal content is
there?”

**Sources:** `clients`, `projects`, `tasks`, and `signal_posts`.

Return counts for:

- active clients;
- active projects;
- active, non-complete tasks;
- active Signal posts with a date;
- active Signal posts without a date (the unscheduled queue).

Client and project scope is applied through `clients.status` and `projects.status`; tasks are
counted only when they belong to an in-scope project and client. Signal posts are filtered by their
own lifecycle and are not inferred from task/project activity. The date range, when present,
applies to `signal_posts.date` and does not turn an undated post into a dated one.

### 2. Task status and deadline buckets

**Question:** “What work is open, completed, overdue, or due soon in the selected scope?”

**Sources:** `tasks`, joined to `projects` and `clients`.

Return two grouped result sets:

1. task count by the stored `tasks.status`;
2. non-complete task count by one mutually exclusive due bucket:
   `OVERDUE`, `TODAY`, `NEXT_7_DAYS`, `LATER`, or `NO_DUE_DATE`.

The due bucket is evaluated against one server-supplied local report date, validated at the HTTP
boundary. It is not an instant and must not be computed from a Signal post's date/time pair.
Completed tasks are retained in the status breakdown but excluded from deadline buckets, matching
the dashboard's existing rule. The implementation must define the boundary between `TODAY` and
`NEXT_7_DAYS` in the card and reuse the shared deadline rule where possible.

### 3. Project workload

**Question:** “Which active projects contain the most open work, and which clients own it?”

**Sources:** `clients`, `projects`, and `tasks`.

Return one row per in-scope project with its client id/name, project id/name, and:

- total tasks in the selected scope;
- non-complete task count;
- complete task count.

This is a grouped count, not a ranking metric. The API may order rows by client name, project name,
and id for deterministic output; it must not label the order “highest priority” or derive a score.
Projects with zero tasks remain present through a `LEFT JOIN`, because “no tasks” answers a
different question from “project absent.”

### 4. Signal schedule volume

**Question:** “How much planned content is scheduled, unscheduled, or in each stored planning
status over the selected period?”

**Sources:** `signal_posts`, optionally joined to `signal_post_channels`,
`signal_post_campaigns`, and `signal_campaigns`.

Return:

- post count by stored `signal_posts.status`;
- scheduled post count by `signal_posts.date`;
- unscheduled queue count;
- post count by channel;
- post count by campaign, with a final `No campaign` group for posts with no campaign join.

Posts are counted distinctly by `signal_posts.id`. A post carrying multiple campaigns may appear
in each selected campaign group, so the response must not add campaign rows to claim a workspace
total. The top-level scheduled/unscheduled and status counts count each post once. Lifecycle
filtering follows the Signal read contract; a retired post is not silently presented as active
planned content.

The channel and campaign breakdowns are schedule counts only. They do not read provider inventory,
publication outcomes, analytics windows, or live accounts, and they do not claim that content was
delivered.

### Deferred: stored delivery figures

A later card may add a fifth report for “what stored provider figures exist for selected
deliveries,” but it must first define the user question, the treatment of
`AVAILABLE`/`AWAITING_SYNC`/`NOT_AVAILABLE`, and whether campaign segmentation is wanted. If it is
added, it must use the existing measured-delivery distinction and only add provider totals over
deliveries. It must never display missing figures as zero or call an analytics refresh.

## Query and performance contract

The report service must aggregate in SQLite before returning rows. It must not call
`listClients`, `listProjects`, `listActiveTasks`, `hydrateTask`, or an equivalent per-row
hydration path and then filter, group, or slice in JavaScript. In particular, `LIMIT`/`OFFSET` or
any report-card row limit must be applied in SQL after the grouping/order required by that result.
This is the same failure mode identified as SW-1 in
[`VERSION_5B_FEASIBILITY_REPORT.md`](iterations/VERSION_5B_FEASIBILITY_REPORT.md): an apparently
bounded response must not perform unbounded work first.

The implementation card must:

- use bound parameters for every user value and constant SQL identifiers only;
- use `EXPLAIN QUERY PLAN` while designing the queries and add only indexes justified by measured
  access paths;
- return bounded result sets (initial target: at most 500 grouped project/status/date rows per
  request) and document the refusal or pagination behavior above that bound;
- select only fields needed by the report, never `SELECT *` or raw provider response JSON;
- run all report statements in one read operation/connection without opening a transaction that
  implies a write;
- measure the SQL path on a fixture with at least 10,000 tasks and 10,000 Signal posts before
  implementation review. The target is one bounded request completing in under 250 ms on the
  supported local SQLite environment; if the fixture misses that target, the card must record the
  query plan and a revised bound/index decision rather than hiding the cost behind hydration.

The implementation must preserve the database's active read behavior under concurrent writes
(WAL/busy-timeout configuration already belongs to `server/db.ts`). A query failure returns a
visible report error and leaves no partially assembled “successful” report response.

## Implementation-card checklist

The separate implementation card should include:

1. a read-only report query module under `server/` with Zod validation for the route query;
2. a response type in `shared/`, with counts and grouped rows represented explicitly;
3. the `/reports` page, navigation entry, URL-state handling, loading, empty, and error states;
4. focused SQLite integration tests proving counts, distinct post behavior, active/archive scope,
   date boundaries, no-campaign grouping, zero-task projects, and no writes/provider calls;
5. a Playwright spec covering a shared filtered URL, reload, and the visible report result;
6. query-plan/performance evidence for the bounded fixture and the full required quality gates.

No report implementation should modify this plan's boundary by adding exports, provider refresh,
new analytics metrics, or a second copy of domain rules without a separately reviewed card.
