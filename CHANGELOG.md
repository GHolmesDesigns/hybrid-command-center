# Changelog

All notable changes to Hybrid Command Center are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases before 3.0.0 were not recorded in this file; `git log` is authoritative for them.
The version a card ships as is decided at merge time — see the bump rule in `AGENTS.md`.

## [4.5.0] - 2026-08-20

### Changed

- **The rule about media has been narrowed, and nothing in the app behaves differently yet.** The
  older claim — Command Center never uploads, downloads, or proxies media — has been replaced
  everywhere it appeared with the claim that is actually being kept: **this app stores no media
  files, serves no media bytes, and holds no media bytes at rest.** Referencing, storing, and
  serving are still refused.
- One narrow exception has been decided and is **not built**: when you confirm a submit, the server
  may stream a single media file you selected from Drive straight to the publisher, keeping no copy
  and writing nothing back to Drive. Until that work lands there is no path in this app that moves
  a media file at all.
- **Files has not changed and is not part of that exception.** Drive browsing stays read-only and
  scoped to a project's own folders, with no upload, download, move, rename, or delete — exactly as
  before.
- The Signal composer's media hint now reads "Signal stores the references, not the files", and the
  user manual says the file is never copied here rather than promising it will never be read.
  Previewing a post still contacts nothing: the preview has never fetched a media file on the
  server and that does not change.

### Added

- Two documents behind the publishing work now live in the repository:
  `docs/post-bridge-api-surface.md`, a dated research note recording what the provider's API
  actually offers, and `docs/post-bridge-integrations-plan.md`, the reviewed sequencing for what to
  do about it. `docs/publishing-integration.md` links both and remains the record that decides how
  publishing behaves.
- The decision record now states plainly that a publisher-side media id is temporary — recreated
  every time a post is submitted, updated, or resubmitted, never a lasting reference — and that the
  vendor's expiry timing is documented but has not been verified against the live service.
- Every other capability the research note found is recorded as unverified, so the publishing
  capability table keeps refusing what it refuses today until each one is checked in turn.

### Breaking changes

None. No feature, screen, endpoint, stored value, or publishing capability changed in this release.

## [4.4.0] - 2026-08-18

### Added

- The Signal editor now shows **Delivery** beside the planning status, with one row for every
  account a post was sent to. Each row says how that delivery gets there — automatic publishing, a
  provider draft, a finish you have to do in the platform's own app, or nothing at all because no
  provider reaches that channel — and how far it actually got, in words rather than stored codes.
  When two accounts go out and one of them fails, both say so and the failure names its reason
  beside the account it belongs to.
- A delivery that needs you to finish it somewhere else now says which application to open and what
  is waiting in it, and **Mark … finished** records that you did. That records the delivery only:
  it never touches the post's own status.
- Blog now appears in Delivery instead of being left out, saying plainly that nothing was sent and
  pointing at **Mark published**, which is still the way to record that you posted it yourself.

### Changed

- The editor's **Status** field is now labelled **Planning status**. The three values are unchanged
  and it is still yours alone: nothing the provider reports has ever written it, and now the page
  says so.
- Delivery is checked with the provider on its own once a post's scheduled time has passed, waiting
  longer between each check and stopping after six rather than asking for ever. The section shows
  when it last checked and when it will next, and **Refresh delivery** still asks immediately —
  including after the automatic checks have stopped.

### Breaking changes

None. Existing publication records keep their delivery route recorded as automatic publishing,
which is what every connected platform does today, and no post's status changes.

## [4.3.2] - 2026-08-18

### Added

- Signal post editors now offer **Duplicate to unscheduled queue**. The copy keeps the original
  content, media, campaign, channels, format, CTA, and posting time, and lands in the queue as a
  new draft with no date. Publication and delivery history stay on the original.
- **Suggest next open slot** reads the Signal schedule and proposes the next date at that post's
  time that no other post already occupies. The suggestion is shown until you confirm it; occupancy
  is checked again at that moment, and a taken cell is refused rather than double-booked.

### Breaking changes

None.

## [4.3.1] - 2026-08-18

### Added

- **One post can now read differently on every channel.** Signal's editor has a **Per-platform
  content** section with a panel for each platform the post's channels reach. A platform starts from
  the post and keeps only what you change: a short caption for X with the link as a first comment, a
  longer one for LinkedIn, a real title for YouTube instead of the caption standing in for it. An
  account override can sit over a platform's, edited from that account's own preview tab. Clearing a
  field restores the post's own content rather than sending nothing.
- **You are offered only the fields the provider will actually carry.** X has a first comment,
  YouTube has a title, Instagram and Facebook have a story placement, and no platform offers a chosen
  cover image or thumbnail because none accepts one. The same rule that hides a control refuses it if
  it arrives another way, so the form and the API never disagree about what is possible.
- **Per-platform media selection**, chosen from the media the post already carries and in the post's
  order. Choosing none is allowed: that is a platform that receives the text alone.
- **A synthetic-media disclosure** you can turn on per platform. No platform gives this provider a
  disclosure field, so the disclosure is written into the caption — and the character count and the
  caption limit are both measured against the caption you will actually send, so a disclosure that
  pushes X past 280 characters is refused before the send rather than after.
- **A preview that shows each target separately, and only when you ask for it.** **Show preview** is
  the only thing that loads anything from the internet or contacts the provider. It opens with every
  channel's verdict in one list, then one tab per target account: the exact text that account
  receives, a note beside any value an override decided, the title and first comment, the media in
  that target's order, the post's date and time in the configured zone beside the instant the
  provider is given, whether the provider sends it or hands it to the platform's app to finish, and
  that target's own warnings and refusals.
- Preview media is shown small, because a preview is for checking the order and the crop. **A video
  never starts on its own** — it takes a second, deliberate press and then arrives with ordinary
  controls. Media that cannot be shown says so and still offers its address, rather than leaving a
  gap.

### Changed

- Two limits the provider imposes are now stated as refusals rather than discovered afterwards. It
  sends one set of media per submission, so channels given different media are refused and named;
  and it carries one set of content per platform, so an account override is delivered as its
  platform's content, which the preview says on the target it applies to.
- A caption limit, a media count, and a post shape are now checked against what a platform will
  actually receive rather than against the post, so an override that breaks a limit is caught in the
  preview.
- Media selected for a platform that the post no longer carries is left out and reported, never
  silently sent.
- Previewing is held back until per-platform content is saved, the same way it already waited for the
  post itself. **Preview publishing** is now called **Show preview**.
- Editing a platform's content between previewing and confirming refuses the confirmation, exactly as
  editing the post already did.
- The publishing preview renders media in your browser, so production responses now allow media from
  an `https:` host — the same allowance a sidebar logo already had for images. Nothing is fetched by
  the server: Command Center still never uploads, downloads, or proxies a media file, and responses
  carry `Referrer-Policy: no-referrer` so a media host is never told which page asked for it.

### Breaking changes

None. A post with no per-platform content is planned, previewed, and submitted exactly as before.

## [4.3.0] - 2026-08-16

### Added

- **Merge one client into another.** When the same client ended up in the list twice, **Merge
  client** on the duplicate's page moves every one of its projects — with their tasks,
  checklists, dependencies, categories, ordering, dates, and Drive links unchanged — to the
  client you are keeping, in one all-or-nothing step. A summary names both clients and lists
  every project that will move, including archived and completed ones, before anything is
  written; if that summary goes out of date while it is on screen, the merge is refused and the
  current one is shown to confirm again.
- The duplicate is archived and records where its work went, rather than being deleted. Its own
  contact details and notes stay readable on it and are never combined with the client you kept,
  whose details win. Its client page links to the survivor, and its card in the Clients list
  shows a merged badge in place of the Unarchive button.
- A merged client's name becomes an alias: a later campaign playbook naming it attaches to the
  client its work went to, instead of recreating projects beneath the archived duplicate. A
  client of that name that was never merged still wins, and the import preview names which rule
  matched.

### Changed

- Google Drive is untouched by a merge — no folder is moved, renamed, created, or deleted, so
  every project's files still open where they always did and the duplicate's own client folder
  stays in Drive. A later **Sync to Folder** will create a folder for a project that never had
  one under the client you kept.
- A merged client can no longer be unarchived, chosen as the destination of another merge, or
  handed a project back by editing one — any of those would quietly undo the merge. Editing a
  project's client is now held to the same rule as creating one: the client has to be active.
- There is no undo. Recover from a database backup if a merge was a mistake.

### Breaking changes

- None.

## [4.2.2] - 2026-08-14

### Added

- Add an explicit preview-and-confirm Post Bridge publishing flow for scheduled Signal posts, with configured-timezone conversion, account and media preflight, durable per-target delivery records, and safe handling of ambiguous submissions.

### Breaking changes

- None.

## [4.2.1] - 2026-08-13

### Added

- Signal posts can now keep, reorder, and display ordered public media URL references without
  uploading, downloading, or storing the files themselves.

### Breaking changes

- None.

## [4.2.0] - 2026-08-13

### Changed

- Reconciled the publishing decision record with the proven social-media publisher, including the
  seven-channel media prerequisite, provider boundaries, preflight rules, and account safety rule.

### Breaking changes

- None.

## [4.1.10] - 2026-08-13

### Changed

- Contributors no longer claim a version number while a card is under review. A branch keeps its
  pull request in draft and describes what it changed in `changes/<issue>.md`; the person merging
  it assigns the version and folds that text into this file at merge time, when the number is
  finally knowable. Concurrent cards stop colliding over the same four release files, and no card
  needs a follow-up commit to renegotiate a number another card took first.
- The version-bump check runs on `main` and on pull requests that are ready for review. Draft pull
  requests are exempt by design, which is what lets a card defer its number. Every other quality
  gate runs exactly as it did.
- Dependency-update branches follow the same path. They no longer need a hand-added bump commit to
  go green.

### Breaking changes

- None. Nothing in the running application changed; this is a contributor workflow change.

## [4.1.9] - 2026-08-13

### Changed

- The Status board now lives at `/status`. The nav item, breadcrumb, dashboard tiles, and every
  in-app link that opened the board point there. `/kanban` still works: it redirects to `/status`
  and keeps whatever query string it had, so an old bookmark filtered to today still opens today's
  board.

### Fixed

- Calendar links to a task's board no longer append a `task` query parameter the board never
  read. They keep the project filter only. Opening a specific task from the calendar is left for
  a later card rather than half-wired through a dead parameter.

### Notes

- CSS class names (`.kanban-board`, `.kanban-column`, `.kanban-card`) stay as they are. Renaming
  them would double the diff and churn e2e selectors without changing anything a user sees.

### Breaking changes

None. `/kanban` remains as a redirect.

## [4.1.8] - 2026-08-13

### Fixed

- The version-bump gate's own test no longer times out under a full suite run. Each case now
  has a file-scoped budget that matches starting a real Git repository and a real Node child,
  and the shared initial commit is copied per case instead of rebuilt ten times. The suite-wide
  default timeout is unchanged.

### Breaking changes

None.

## [4.1.7] - 2026-08-13

### Fixed

- A Signal day cell no longer grows to fit the longest post in it. Every cell in the month is
  one height, so a thousand-character campaign post can no longer stretch its day and the whole
  of that week's row with it. A cell holding more than fits scrolls on its own.

### Added

- A post longer than its cell shows its opening, ending in an ellipsis, with **Show more**
  underneath. **Show more** opens the rest of that post where it sits and moves nothing else on
  the page; **Show less** puts the opening back. It is a separate control from the post itself,
  reachable and labelled on its own, so revealing the text and opening the editor can no longer
  be mistaken for each other. Queue items are still shown whole — the queue is a column of its
  own with no day beside it to stretch.

### Breaking changes

None.

## [4.1.6] - 2026-08-13

### Added

- The client and project named on a task's detail panel are now links to those detail pages.
  Following one closes the task panel and moves focus to the heading of the page it opened, so
  the journey from a task to the work around it no longer means closing the panel and finding
  the record by hand. A name whose record no longer exists stays plain text rather than
  offering a link that would lead nowhere.

### Breaking changes

None.

## [4.1.5] - 2026-08-13

### Added

- The Import page offers the sample playbook. **Download sample playbook**, beside **Import a
  playbook** at the top of the page, saves the filled-in workbook — every tab, in order, with its
  columns already named — so a first import starts from a working file instead of from a column
  list. Until now that workbook shipped with the application but nothing served it, and the page
  could only name the folder it was in.

### Changed

- The Import page's note about the format now points at the download rather than only at the
  format document.

### Breaking changes

None.

## [4.1.4] - 2026-08-13

### Changed

- Task details now presents Checklist, Notes, Tags, and Dependencies in that order, putting
  progress and working text ahead of labels while keeping Dependencies last. The sections'
  content and behaviour are unchanged.

### Breaking changes

None.

## [4.1.3] - 2026-08-13

### Added

- The Status board filters by task type. The new control offers every type, plus **No type** for
  the tasks that carry none — untyped work predates the field and is normal, so it is findable
  rather than merely not excluded. The type narrows the board alongside the client, project,
  priority, focus, tag, and search filters rather than replacing any of them.

### Changed

- The task type and priority selections are now carried in the page address, as the client,
  project, focus, and tag selections already were. Priority was the last filter that reset on a
  reload; a filtered board now reloads and shares as a link exactly as it was left. The filter
  bar also wraps onto a second line at narrow widths instead of running off the side of its card.

### Breaking changes

None.

## [4.1.2] - 2026-08-13

### Added

- Tasks can now be classified as Dev Work from the task form. The type appears on task cards
  and task details, is accepted by campaign playbook imports, and does not add a default
  checklist because development workflows vary by task. Existing typed and untyped tasks are
  unchanged.

### Breaking changes

None.

## [4.1.1] - 2026-08-13

### Fixed

- The Google Drive card on Settings no longer runs on into several hundred pixels of blank
  white space. It was being stretched to the height of the two cards beside it, so it stood
  more than a thousand pixels taller than the content it held; it now ends where its content
  ends, in every Drive state — credentials missing, disconnected, connected without a root
  folder, and connected with one set. Every other Settings card sizes to its content in the
  same way, which also closes the shorter gap that sat under Local timezone. Settings is
  around 400px shorter to scroll at desktop width, and the single-column layout below 1100px
  is unchanged.

### Breaking changes

None.

## [4.1.0] - 2026-08-13

### Fixed

- The Description and Notes labels on Task details no longer sit flush against the box you
  type into. Both inline editors now leave 10px between the label and its textarea, so the
  field reads as a labelled field rather than as one block of text. Every other form in the
  app — Settings, Task, Project, Client, and the Signal editor — is unchanged.

### Breaking changes

None.

## [4.0.0] - 2026-08-13

A version-only major bump. The application code, HTTP API, database schema, and
configuration are byte-for-byte unchanged from 3.1.3.

### Changed

- `package.json`, both `package-lock.json` version fields, and `APP_VERSION` in
  `shared/branding.ts` moved to `4.0.0`. `server/version-consistency.test.ts` holds all
  four to the same value, and `npm run check:version-bump` gates the result in CI.
- The version the sidebar foot, the Settings pane, and `GET /api/branding` report now reads
  `v4.0.0`.

### Added

- This changelog.

### Breaking changes

None. Nothing was removed, renamed, or given different behaviour, so no upgrade step
applies: the major digit was raised on request rather than to signal an incompatibility.
Semantic Versioning reserves the major position for incompatible API changes, so a future
reader should not infer one from this release.

## [3.1.3] - 2026-08-12

### Fixed

- The server refuses a non-loopback bind while nothing authenticates, rather than exposing
  an unauthenticated instance by a `HOST` change alone.

## [3.1.2]

### Changed

- The import and Drive routes carry request budgets.

## [3.1.1]

### Added

- CI measures coverage and holds each project to its own floor.
- Drive scope exposure and revocation are documented.

## [3.1.0]

### Added

- A private single-instance cloud shape is recommended for Infra 2, in `docs/cloud-hosting.md`.

## [3.0.3]

### Added

- Backups carry a retention count, and the restore rehearsal carries a schedule.

## [3.0.2]

### Added

- Supply-chain gates in CI.

## [3.0.1]

### Fixed

- The branding reset waits to reach the form before it resolves.

## [3.0.0]

### Added

- The Signal planner: `signal_posts` is the only store of planned content, read through
  `SignalProvider`, which has no write method by construction.
