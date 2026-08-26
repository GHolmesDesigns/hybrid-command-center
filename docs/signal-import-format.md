# Signal Import Format

Status: implemented by C90 (#272). This document is the format and the boundary decisions the Wave
16 importer is built against.

Schema version: `1`

Versioned example: [`docs/examples/signal-import-format.xlsx`](examples/signal-import-format.xlsx)

Sibling document: [`campaign-playbook-import-format.md`](campaign-playbook-import-format.md) — same
tab grammar, key discipline, and paste-as-tabs alternative; a different hierarchy and a different
`schema_version` gate.

## Purpose and format

A Signal import workbook is an XLSX file that describes planned Signal posts — copy, channels,
media, optional per-platform variants, and (in a later schema version) publish targets — so a queue
authored outside this app can be previewed and written into `signal_posts` in one confirmed action
rather than retyped post by post.

The hierarchy is split across tabs rather than flattened into one table:

```text
SignalPost -> SignalMedia (ordered)
           \-> SignalVariant (optional, per platform/account layer)
           \-> SignalTarget (optional — reserved; see C93)
```

Separate tabs keep parent metadata from repeating on every child row and let validation name an
exact sheet, row, and column. A campaign playbook and a Signal queue are different things with
different lifetimes, so this format lives in its own file with its own `schema_version`; it is not
an extension of the campaign playbook workbook.

The required data tabs are `[SignalPosts]` and `[SignalMedia]`. `[SignalVariants]` is optional and
may be empty. `[SignalTargets]` is **reserved** for a later schema version: see
[Publish targets tab — deferred](#publish-targets-tab--deferred). `README`, `DataDictionary`, and
`AllowedValues` are documentation tabs and are ignored by the importer.

## Workbook rules

- Sheet names and column headers are exact and case-sensitive. Unknown data tabs or columns are errors.
- A column marked **optional** below may be absent from its tab, and blank on any row. Present, it
  is validated exactly like a required one. Nothing else is optional: every other documented column
  has to be there, even where every cell under it is blank.
- Cells contain literal values only. Formulas, macros, merged data cells, and hidden data are
  rejected.
- Fully blank rows are ignored. A partially populated row is an error.
- Dates are literal `YYYY-MM-DD` calendar values. Excel date serials and timezone conversion are not
  allowed.
- Times are literal `HH:MM` values in 24-hour form. Excel time serials are not allowed.
- Optional blank fields become `null` or the documented default unless stated otherwise.
- `schema_version` is `1`. An importer must reject versions it does not support.

### Workbook-local keys

`post_key` connects rows within one workbook. It is not a SQLite id and does not need to match a key
in another workbook or an earlier import.

Keys are:

- required on the `SignalPosts` row that defines them;
- trimmed and case-sensitive;
- 1-64 characters;
- matched by `[A-Z][A-Z0-9_-]*` — the same pattern the campaign playbook uses for `client_key`,
  `project_key`, and `task_key`;
- unique within `[SignalPosts]`.

References from `[SignalMedia]`, `[SignalVariants]`, and (when it ships) `[SignalTargets]` must
match a `post_key` exactly. Duplicate keys and unresolved references are preview errors.

### Ordering

`media_order` on `[SignalMedia]` is a positive, one-based integer within a post. Duplicate values
for the same `post_key` are errors. Gaps are allowed; the importer normalizes to zero-based storage
while preserving order.

`position` on `[SignalPosts]` orders the unscheduled queue only. It is meaningful when `date` is
blank and is ignored once a post has a date, matching `signal_posts.position` today.

## Field mapping

### SignalPosts

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `post_key` | Workbook reference only | Yes | Unique post key. |
| `text` | `signal_posts.text` | Yes | Trimmed, 1-20,000 characters. The copy itself, not a title. |
| `channels` | `signal_post_channels.channel` | No | Zero or more channel codes from [Allowed channel codes](#allowed-channel-codes), separated by `\|`. Duplicates are removed. Default none. |
| `date` | `signal_posts.date` | No | Real `YYYY-MM-DD` date, or blank for the unscheduled queue. Default blank. |
| `time` | `signal_posts.time` | No | `HH:MM` 24-hour label. Default `09:00` (`SIGNAL_DEFAULT_TIME`). |
| `format` | `signal_posts.format` | No | Default `TEXT`; use an allowed [format](#allowed-formats) value. |
| `status` | `signal_posts.status` | No | Default `DRAFT`; use `DRAFT` or `SCHEDULED` only. `PUBLISHED` is refused — import writes planning rows, not delivery claims. Lifecycle stays `ACTIVE` and delivery provenance stays `IN_SIGNAL` on every imported row — import does not retire plans and does not invent Outside of Signal. |
| `campaigns` | `signal_post_campaigns` join | No | Zero or more campaign names from the shared workspace list, separated by `\|`. Names are trimmed, matched case-insensitively, and created when new inside the import transaction — the same rule `signalPostInput` uses today. Default none (**No campaign**). At most 12 names per post. |
| `cta` | `signal_posts.cta` | No | Default `NONE`; use an allowed [CTA](#allowed-ctas) value. |
| `position` | `signal_posts.position` | No | Non-negative integer for queue ordering when `date` is blank. Default is the next queue position at commit time. |
| `post_import_source` | `signal_post_import_aliases.source_namespace` | Optional pair | UUID of the authoring source. Must appear together with `post_import_id`; one without the other is an error. See [Post identity and duplicates](#post-identity-and-duplicates). |
| `post_import_id` | `signal_post_import_aliases.external_id` | Optional pair | Opaque id at that source. Trimmed, 1-200 characters, compared exactly. |

Media for a post is **not** listed on this tab. It lives on `[SignalMedia]` so one post can carry
many ordered references without repeating the post row.

### SignalMedia

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `post_key` | Resolves the post | Yes | Must reference `SignalPosts.post_key`. |
| `media_order` | `signal_post_media.position` | Yes | Positive integer, one-based within the post. |
| `source` | `signal_post_media.source` | Yes | `URL` or `DRIVE` — the same discriminant `signalPostMediaIssue` enforces. |
| `url` | `signal_post_media.url` | Yes | For `URL`: a public `https:` URL. For `DRIVE`: a Google Drive **file link** (`drive.google.com` or `docs.google.com`), never a bare file id. |

No other columns are accepted on a media row. Drive name, MIME type, size, and version fingerprint
are **never** supplied by the workbook; they are whatever Drive returns when the importer resolves
the link in the dry run (see [Drive boundary](#drive-boundary-deliberate-departure-from-the-playbook-rule)).

At most 20 media rows may reference one `post_key`, matching `signalPostInput`.

### SignalVariants

Optional per-platform overrides, modelled on `signalVariantsInput` / `signal_post_variants` and
`signal_post_variant_media`. A row defines one layer: a `platform` plus an optional `account_id`.

| Column | App target | Required | Format and rules |
| --- | --- | --- | --- |
| `post_key` | Resolves the post | Yes | Must reference `SignalPosts.post_key`. |
| `platform` | `signal_post_variants.platform` | Yes | A [publish platform key](#allowed-publish-platform-keys). |
| `account_id` | `signal_post_variants.account_id` | No | Positive integer provider account id for an account layer, or blank for the platform-wide layer. |
| `caption` | variant caption override | No | Text, at most 20,000 characters. Absent means inherit the post. |
| `media_urls` | `signal_post_variants.media_urls` | No | Zero or more public `https:` URLs naming items from the post's media, separated by `\|`. Absent means inherit; an empty cell with the column present means deliberately send none. |
| `post_kind` | variant post kind | No | One of `POST`, `CAROUSEL`, `REEL`, `STORY`. |
| `title` | variant title | No | Text, at most 500 characters. |
| `first_comment` | variant first comment | No | Text, at most 20,000 characters. |
| `disclose_synthetic_media` | variant disclosure flag | No | Native Boolean `TRUE` or `FALSE`, or blank for unset. |
| `cover_image` | `COVER` role media | No | Public `https:` URL or Drive file link — same rules as `[SignalMedia]`. |
| `thumbnail` | `THUMBNAIL` role media | No | Public `https:` URL or Drive file link — same rules as `[SignalMedia]`. |

Duplicate `(post_key, platform, account_id)` triples are errors. The whole variant set for a post is
a replacement at commit time, not a patch.

### Publish targets tab — deferred

`[SignalTargets]` is named in this specification so C90–C92 can cite one document, but **schema
version 1 workbooks must not include it**. A publish target names a provider-qualified account.
C84 (#258) and C87 (#261) settled that identity and Buffer routing — the reason this wave was
sequenced after Wave 15 — but Wave 16 still did not ship the tab. Importing targets before those
identities existed would have baked a Post Bridge assumption into a file format; leaving them out
afterward kept schema version 1 to content, media, and variants, with targets chosen in the app
after import.

When the tab ships, it will be documented here in a `schema_version` bump. Until then, targets are
chosen in the app after import, as they are today. See
[What this wave leaves unbuilt](#what-this-wave-leaves-unbuilt-why-and-what-would-reopen-it).

## Allowed values

Values below are the shipped vocabulary in `shared/signal.ts`, `shared/publish-capabilities.ts`, and
`server/signal/service.ts` (`signalPostInput`). An importer must not invent aliases.

### Allowed channel codes

| Code | Channel |
| --- | --- |
| `blog` | Blog |
| `bsky` | Bluesky |
| `fb` | Facebook |
| `ig` | Instagram |
| `li` | LinkedIn |
| `th` | Threads |
| `tt` | TikTok |
| `x` | X |
| `yt` | YouTube |

### Allowed formats

`BLOG_POST`, `WHITEBOARD_VIDEO`, `INFOGRAPHIC`, `VIDEO`, `IMAGE`, `CAROUSEL`, `REEL`, `ARTICLE`,
`QUOTE_CARD`, `TEXT`, `STORY`

### Allowed statuses

`DRAFT`, `SCHEDULED` — planning states only. `PUBLISHED` exists in the app as a user-declared
planning claim and is refused on import; see [What import never does](#what-import-never-does).
Lifecycle `RETIRED` and provenance `OUTSIDE_SIGNAL` are not planning statuses and are not set by
import: every imported row lands as an active in-Signal plan.

### Allowed CTAs

`NONE`, `SOFT`, `CONVERSION`

### Allowed publish platform keys

For `[SignalVariants].platform` only:

`twitter`, `facebook`, `linkedin`, `bluesky`, `instagram`, `tiktok`, `youtube`, `pinterest`,
`threads`, `google_business`

These are `PUBLISH_PLATFORMS`, not `SIGNAL_CHANNELS`. The mapping from a channel code to a platform
key is `SIGNAL_CHANNEL_PLATFORM` in `shared/publish-capabilities.ts` (`blog` maps to no platform).

### Allowed media sources

`URL`, `DRIVE`

## Drive boundary — deliberate departure from the playbook rule

The campaign playbook's strongest property is that **nothing about an import touches Google Drive**.
Imported clients and projects are stored disconnected and are provisioned later from Settings.

A Signal importer cannot keep that rule when the queue carries Instagram reels, carousels, and
Drive-hosted masters — which is most of the reason to import at all. A Drive reference is not a URL
a provider can fetch; binding one means reading Drive's name, MIME type, size, and at least one
version fingerprint so the stored row is evidence of the bytes someone previewed.

**The decision this format records:** Drive resolution happens in the **dry run**, read-only, with no
bytes read and no Drive writes — the same call `POST /api/signal/drive-media/resolve` makes today.
The fingerprint returned there is written inside the confirm transaction. Confirmation **re-resolves**
each Drive reference immediately before the write and refuses when a fingerprint moved — a file
replaced under the same id between preview and confirm is exactly the case the fingerprint exists
for, matching publish preflight. The campaign playbook importer's dry run still does not contact
Drive.

**The rejected alternative:** public `https:` URLs only, with Drive attached by hand afterwards.
That would leave every row whose media lives in Drive unimportable and would recreate the drift
between the queue and Signal the import exists to prevent.

This is a deliberate, documented break from the playbook rule, not an accident. C91 (#273)
implements it; C88 only stated it and C90 wired the dry-run shell that this card completes.

## Post identity and duplicates

Duplicate detection is specified here; the mechanism lives in C89 (#271).

A post is the **same post** across imports when:

1. **Identity, when the workbook carries it.** `post_import_source` and `post_import_id` resolve to
   the post they were recorded against, whatever the row now says about date or copy. Namespace is
   `signal-import:<post_import_source>` with a UUID source, for the same reason client identity uses
   a UUID in the playbook.
2. **Otherwise the fallback.** When the workbook carries no identity, or carries a valid identity
   that has not been recorded yet, resolution checks scheduled date (blank matches blank only) plus
   trimmed text compared case-insensitively. This is a weak key and the importer must say so. A row
   with no identity may be matched by it, but can never gain an identity the workbook did not name.
3. **Disagreement is refused.** Identity resolving to one post and the fallback to another rejects
   the **whole** import with both posts named — the same refusal rule client identity uses.
4. **A confirmed fallback match carrying a new identity records that identity** in the same
   transaction, so the next import resolves by the pair. A plain fallback match records nothing.

Two rows of one workbook claiming the same identity, or the same fallback key, are preview errors.

Re-import after an edit to the copy updates the matched post; it does not create a twin beside it.
That is the problem C89 solves; this section is what C90's skip/update rules cite.

## What import never does

Import writes **planning rows** in SQLite. It is the read/write split from
`docs/publishing-integration.md` §1 pointed the other way: the publisher reads the schedule through
`SignalProvider` and never writes `signal_posts`; the importer writes `signal_posts` and never
touches the publishing path.

An importer must **never**:

- submit, update, reschedule, or cancel a provider post;
- create a `signal_publications` row or a publication target;
- write delivery or analytics state;
- call Post Bridge, Buffer, or any publishing provider;
- set `signal_posts.status` to `PUBLISHED`;
- set `signal_posts.lifecycle` to `RETIRED` or `delivery_provenance` to `OUTSIDE_SIGNAL`
  (those are explicit in-app decisions, not import claims);
- read or write Drive bytes, rename or move Drive files, or provision Drive folders;
- download arbitrary URLs to discover media.

Capability verdicts for what would happen **if** someone later published are preview warnings from
the shared publish capability contract (`shared/publish-capabilities.ts`). They **inform and never
refuse**: a caption over Bluesky's hard limit still imports. Validation errors still refuse the
whole import. Durable findings (limits, media bounds, unreachable channels) are distinguished from
momentary ones (no connected account today). Connected accounts are read from the local store; the
preview never calls a publishing provider. Verdicts are carried into the receipt.

## Dry-run preview and confirmation

Every import begins with a read-only dry run. Confirmation re-reads the file and re-plans against
the workspace as it stands at that moment. A file edited between the two is refused rather than
imported against the older preview.

The preview shows:

- counts that would be created, updated, and skipped;
- every validation error with sheet, row, column, and message;
- duplicate keys and unresolved references;
- each `[SignalMedia]` row with what Drive said when it resolved — name, MIME type, size, and
  resolution time — or a row-level Drive error in Drive's own words;
- a prominent stop when fewer Drive files resolved than the workbook named;
- identity disagreements and duplicate identity claims;
- the duplicate rule in the preview's own words;
- a capability summary (how many posts import clean vs carry a warning) and per-row, per-channel
  findings — over caption limit, media required or out of bounds, unreachable channel, and missing
  connected account — labelled as about the content or about right now.

Confirmation is enabled only for a clean preview, and only when every required Drive reference
resolved. All SQLite writes occur in one transaction on confirm. A database failure rolls back the
entire import.

Drive links are resolved during the dry run. Confirmation re-resolves each bound Drive reference
and refuses when a fingerprint moved; the transaction then stores the fingerprint the preview
showed. A format refusal that needs no Drive round-trip — a `URL` row on a Drive host, a forged or
mistyped Drive link — never contacts Drive. One unresolvable file errors its own row and leaves the
rest of the workbook's plan intact.

## The pasted text form

The import UI will accept the same tabs pasted as text, for the same reason the campaign playbook
does:

```text
[SignalPosts]
post_key	text	channels	date	time	format	status	campaigns	cta
POST-001	Clarity as competitive advantage	ig\|li	2026-08-26	13:00	REEL	SCHEDULED	Clarity Campaign — Wk1: The Problem	NONE

[SignalMedia]
post_key	media_order	source	url
POST-001	1	DRIVE	https://drive.google.com/file/d/abc123/view
```

- Each tab is introduced by its name in square brackets, alone on its line.
- Cells are separated by tabs.
- `\|` separates list values in a single cell.
- Row numbers in error messages count from each tab's heading.

## Importer behavior

C90 (#272) shipped the dry-run / confirm shell, including `[SignalVariants]`; C91 (#273) completes
Drive media on `[SignalMedia]` and the same read-only resolution on variant `cover_image` /
`thumbnail` roles. Rules settled here that the importer must not re-decide:

- Matched posts are **updated**, not duplicated, using the identity rules in C89.
- Unmatched rows are **created**.
- An import that names media **replaces** that post's media rather than appending to it, in workbook
  `media_order`.
- `schema_version` is read from a `Schema version` or `schema_version` label on a documentation tab.
  A workbook that declares nothing is assumed to be version 1.
- `TRUE`/`FALSE` typed as text is accepted for booleans where noted.
- Every import writes a receipt — created, updated, skipped, and failed counts with reasons — in the
  same spirit as the campaign playbook importer.

## What this wave leaves unbuilt, why, and what would reopen it

A wave that ships its cards and stops leaves the next reader to work out whether the rest was
rejected, forgotten, or blocked. This section is that record for Signal import — the same job
[`publishing-integration.md`](publishing-integration.md) §17 does for the Post Bridge integrations
plan.

**Every entry has three parts: what it is, why it is not built, and the concrete thing that would
reopen it.** Naming the reopening condition is enough; this section does not decide whether the
unbuilt pieces should be built.

### Wave 16 card resolutions

Every preceding card in this wave has a recorded resolution — none negative, none will-not-build,
none deferred:

| Card | Issue | Resolution |
| --- | --- | --- |
| C88 — The Signal import format, and the Drive boundary it has to break | #270 | Merged |
| C89 — A Signal post's identity survives an edit to its copy | #271 | Merged |
| C90 — Dry run, confirmation, and one transaction | #272 | Merged |
| C91 — Drive media resolved in the preview, written with the post | #273 | Merged |
| C92 — Capability verdicts in the preview, as warnings | #274 | Merged |

### What the card's own list would misread as unbuilt

C93's issue named `[SignalVariants]` and media on variant layers among the unbuilt pieces. Checking
each entry against the shipped importer rather than transcribing the card found both already land:

- **`[SignalVariants]`.** Optional per-platform / per-account layers — caption, media URL selection,
  post kind, title, first comment, disclosure — import through C90 (#272). The format's
  [SignalVariants](#signalvariants) table is the vocabulary; the composer remains the place a person
  finishes a layer by hand when the workbook did not carry one.
- **Variant `cover_image` and `thumbnail` roles.** Public URLs and Drive file links on those columns
  resolve under the same read-only Drive rule as `[SignalMedia]`. C91 (#273)'s card text left variant
  role media to C93; the importer shipped the resolution anyway, and a register that quietly
  reclassified working behaviour as unbuilt would be worse than no register.

Those two are **not** in the unbuilt list below.

### The `[SignalTargets]` tab

**What.** Explicit per-account publish targets in the workbook — which provider account each post
should send to — so a queue authored outside the app can carry the same target selection the planner
holds today.

**Why not built.** A target names an account, and an account is only unambiguous once it is
provider-qualified. That is why this wave was sequenced after Wave 15: C84 (#258) and C87 (#261)
had to land first, or importing targets would bake a Post Bridge assumption into a file format. Those
cards merged; schema version 1 still omits the tab so the first import release stays content, media,
and variants, with targets chosen in the app after import.

**Revisit when** a `schema_version` bump documents `[SignalTargets]` here and the importer writes
provider-qualified target selections without contacting a publishing provider.

### Export

**What.** Signal posts written back out to this workbook format, so the round trip closes and the
authoring source stops being the only place a queue can be edited.

**Why not built.** Wanted, and deliberately out of Wave 16 — C88 named it and left it. Leaving it
unnamed would make the absence look like an oversight.

**Revisit when** a card takes export as its scope: the same tabs, the same identity columns, and a
receipt that says what was written out.

### Scheduling intelligence

**What.** Suggesting, shifting, or resolving collisions among the dates a workbook carries — for
example packing undated rows into next-open slots, or refusing two posts that share a channel's
preferred hour.

**Why not built.** The importer takes the dates and times the workbook gives it. The planner already
offers a next-open-slot suggestion, and that stays a person's press. Import's job is to land the
queue as authored, not to replan it.

**Revisit when** a card decides the importer may propose schedule changes in the preview and require
confirmation of those proposals — separate from validating that a date or time is well-formed.

### Playbook union

**What.** Signal tabs inside the campaign playbook workbook, so one file carries both a campaign's
execution records and its content queue.

**Why not built.** A campaign's projects and its Signal posts have different lifetimes and different
`schema_version` gates. C88 declined the union: two documents, two files, two versions.

**Revisit when** a card deliberately merges the formats and owns the combined version gate — not as
a side effect of making import "one place."

### Anything that publishes — permanent boundary

**What.** Submit, update, reschedule, or cancel a provider post; create a publication or target;
write delivery or analytics state; call Post Bridge, Buffer, or any publishing provider; set
`signal_posts.status` to `PUBLISHED`.

**Why not built.** Restated from [What import never does](#what-import-never-does) and from C88:
import writes **planning rows** only. This is a permanent boundary, not a first-release limitation.
The same read/write split [`publishing-integration.md`](publishing-integration.md) §1 draws for the
publisher, pointed the other way, is what keeps an import from becoming an unreviewed send.

**Revisit when** never under this format. A path that publishes is a different product surface and
needs its own confirmation story; it is not a widening of import.

### Deliberate departures from the playbook importer

Two Wave 16 decisions look like omissions against
[`campaign-playbook-import-format.md`](campaign-playbook-import-format.md) unless their reasoning is
kept beside the unbuilt list. Both are shipped behaviour, not unfinished work.

**Matched-by-identity rows update rather than skip (C90 / #272).** The playbook importer is
create-only: a task already created has been worked on, and an import must not overwrite that work.
A Signal post matched by **identity** is the same post the author edited at the source, and the
point of re-import is to bring that edit in. Fallback matches (date + text, no identity) stay
skipped and reported — a weak key is not evidence enough to overwrite. An update rewrites the
content the workbook is authoritative for and never touches delivery state, publications, queue
`position`, or per-account target selection.

**Capability verdicts inform rather than refuse (C92 / #274).** The playbook importer has no publish
capability surface. Signal import previews caption limits, media bounds, unreachable channels, and
missing connected accounts from the shared publish capability contract, and still commits the row.
A caption over Bluesky's hard limit imports with a warning; only validation errors refuse the whole
import. The alternative — refuse on every capability finding — would make import a second publish
gate and would block landing a queue that the composer is meant to finish.

## Examples

The versioned workbook [`examples/signal-import-format.xlsx`](examples/signal-import-format.xlsx)
contains a small queue: two scheduled posts with public and Drive media, one unscheduled draft, and
one variant override row. It demonstrates optional identity columns on one post so C89's worked
example can be traced from the file.

Formatting on example rows is documentary only and must not affect import behavior.
