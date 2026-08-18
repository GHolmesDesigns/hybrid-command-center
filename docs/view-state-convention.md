# Default views and URL state

Views should open predictably, survive reloads where that matters, and produce useful links without
turning every keystroke into navigation history. Use these rules when adding or changing a view.

## Page-type defaults

- **Collections** open on live records, ordered by meaningful recency. Archived records remain
  explicitly reachable. If a collection offers live, archived, or all scopes, store a non-default
  scope in `visibility`; the absent/default value means live.
- **Workflow boards** retain the canonical workflow order defined by the domain. Filtering a board
  must not reorder its columns or stages.
- **Time views** open the current period. A URL may select another supported period or presentation
  such as week or month; invalid values fall back to the current period and default presentation.
- **Context browsers** first honour a valid explicit URL selection, then a valid remembered
  selection, then a deterministic fallback such as the first browsable record. A child selection
  is cleared when its parent context changes.

## What belongs in the URL

Put durable filters, selections, scopes, sorts, and time periods in query parameters. They must
survive reload, be bookmarkable, and participate in browser Back and Forward navigation. Preserve
unrelated parameters when one control changes. Omit a parameter when its value is the documented
default so the ordinary view keeps a short, stable address.

Transient text search may remain component-local. It represents typing within the current visit,
so it need not create history entries or become part of a shared link unless a feature explicitly
defines search as durable.

Read parameters defensively. Supported values apply as written; missing or invalid values fall back
to the documented default without making the page fail. Existing URLs keep resolving even when they
contain an unknown or retired value.

## Current views

| View | Page type | Default | Durable URL state |
| --- | --- | --- | --- |
| Clients | Collection | Active clients | `visibility` for archived or all |
| Projects | Collection | Live projects by recent activity | `visibility`, `client`, `sort`, and `categories` |
| Status | Workflow board | Canonical task-status order | Project, client, priority, type, focus, and tag filters |
| Calendar | Time view | Current week | View and selected date/month when away from the default |
| Signal | Time view | Current week | View and selected date/month when away from the default |
| Files | Context browser | Explicit project, remembered project, then first live project | Project and folder selections |

Projects uses `live`, `archived`, and `all`; Clients uses its domain term `active` in place of
`live`. The default live/active value is omitted from the address; choosing Archived or All is
explicit.
