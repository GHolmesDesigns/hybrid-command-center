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
| Signal | Time view | Current week | View and selected date/month when away from the default, `post` for an open post, `new` for the shared Add Post form, and `campaigns`, `channels`, `accounts`, `from`, and `to` for the campaign-figures filters |
| Files | Context browser | Explicit project, remembered project, then first live project | Project and folder selections |

Projects uses `live`, `archived`, and `all`; Clients uses its domain term `active` in place of
`live`. The default live/active value is omitted from the address; choosing Archived or All is
explicit.

Signal's campaign-figures filters are durable for the reason every filter is: a campaign comparison is worth
linking to, and a reload should land on the same answer. Each is omitted when it is the default — an empty
list means *no restriction*, so the unfiltered panel keeps a short address — and each is read defensively:
a campaign id the workspace no longer has simply matches nothing, and a date that is not a real day is
ignored rather than failing the page. `campaigns=none` is the reserved value for the posts carrying no
campaign, so **No campaign** can be asked for by name rather than only reached by clearing everything
else. They are the panel's own parameters and share the address with the planner's period, so clearing the
filters leaves the month exactly where it was.

Signal's `post` is a selection rather than a period: it names the post whose editor is open, so a
queue-health alert can link straight to the post it is about. It is read defensively like every other
parameter — a post the workspace no longer has reports itself and leaves the planner usable — and it
is dropped from the address when the editor closes, so the ordinary planner keeps a short one.

Signal's `new` is the shared Add Post creation state. Every entry point — the day-cell plus, the
queue **Add post** action, and the top navigation **Add post** action — writes the same parameter
and opens the same editor form. `new=1` starts an unscheduled draft; `new=YYYY-MM-DD` starts one
dated to that local calendar day, never an instant, so a cell's date survives every timezone. An
invalid value is ignored. Closing, saving, or opening an existing post drops `new` and leaves
month, view, and campaign-figure filters alone. When both `post` and `new` are present, `post`
wins so an alert link still opens the post it named.
