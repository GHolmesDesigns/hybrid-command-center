# Signal Import Format

Status: specified. The importer is **not** built here — see card C90 (#272). This document is the
format and the boundary decisions the Wave 16 importer cards are written against.

Schema version: `1`

Versioned example: [`docs/examples/signal-import-format.xlsx`](examples/signal-import-format.xlsx)

Sibling document: [`campaign-playbook-import-format.md`](campaign-playbook-import-format.md) — same
tab grammar, key discipline, and paste-as-tabs alternative; a different hierarchy and a different
`schema_version` gate.

## Purpose and format

A Signal import workbook is an XLSX file that describes planned Signal posts — copy, channels,
media, optional per-platform variants, and (once Wave 15 lands) publish targets — so a queue
authored outside this app can be previewed and written into `signal_posts` in one confirmed action
rather than retyped post by post.

The hierarchy is split across tabs rather than flattened into one table:

```text
SignalPost -> SignalMedia (ordered)
           \-> SignalVariant (optional, per platform/account layer)
           \-> SignalTarget (optional — reserved until C84/C87)
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
| `status` | `signal_posts.status` | No | Default `DRAFT`; use `DRAFT` or `SCHEDULED` only. `PUBLISHED` is refused — import writes planning rows, not delivery claims. |
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
version 1 workbooks must not include it**. A publish target names a provider-qualified account; that
identity is not settled until C84 (#258) gives accounts provider-neutral ids and C87 (#261)
confirms Buffer routing. Importing targets before then would bake a Post Bridge assumption into a
file format.

When the tab ships, it will be documented here in a `schema_version` bump. Until then, targets are
chosen in the app after import, as they are today.

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
label but is **not** importable; see [What import never does](#what-import-never-does).

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
The fingerprint returned there is written inside the confirm transaction. A file that changes
between dry run and confirm invalidates the plan hash and is refused, matching publish preflight.

**The rejected alternative:** public `https:` URLs only, with Drive attached by hand afterwards.
That would leave every row whose media lives in Drive unimportable and would recreate the drift
between the queue and Signal the import exists to prevent.

This is a deliberate, documented break from the playbook rule, not an accident. C90 implements it;
this card only states it.

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
- read or write Drive bytes, rename or move Drive files, or provision Drive folders;
- download arbitrary URLs to discover media.

Capability verdicts for what would happen **if** someone later published are C92's preview warnings,
not this format's columns.

## Dry-run preview and confirmation

Every import begins with a read-only dry run. Confirmation re-reads the file and re-plans against
the workspace as it stands at that moment. A file edited between the two is refused rather than
imported against the older preview.

The preview shows:

- counts that would be created, updated, and skipped;
- every validation error with sheet, row, column, and message;
- duplicate keys and unresolved references;
- Drive links that failed resolution, with the Drive error;
- identity disagreements and duplicate identity claims;
- the duplicate rule in the preview's own words.

Confirmation is enabled only for a clean preview. All SQLite writes occur in one transaction on
confirm. A database failure rolls back the entire import.

Drive links are resolved during the dry run only. The confirm transaction stores the fingerprint
from that run; it does not call Drive again.

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

## Importer behavior (forward reference)

C90 (#272) implements the importer against this document. Rules settled here that C90 must not
re-decide:

- Matched posts are **updated**, not duplicated, using the identity rules in C89.
- Unmatched rows are **created**.
- `schema_version` is read from a `Schema version` or `schema_version` label on a documentation tab.
  A workbook that declares nothing is assumed to be version 1.
- `TRUE`/`FALSE` typed as text is accepted for booleans where noted.
- Every import writes a receipt — created, updated, skipped, and failed counts with reasons — in the
  same spirit as the campaign playbook importer.

## What this wave leaves unbuilt

C93 (#275) records declined scope. At this format revision:

- **Export** — no path from Signal back to a workbook.
- **`[SignalTargets]`** — deferred until C84 and C87 land; see above.
- **Playbook union** — no Signal tabs inside the campaign playbook file; two documents, two schema
  versions.
- **Publishing and analytics** — named in [What import never does](#what-import-never-does).

## Examples

The versioned workbook [`examples/signal-import-format.xlsx`](examples/signal-import-format.xlsx)
contains a small queue: two scheduled posts with public and Drive media, one unscheduled draft, and
one variant override row. It demonstrates optional identity columns on one post so C89's worked
example can be traced from the file.

Formatting on example rows is documentary only and must not affect import behavior.
