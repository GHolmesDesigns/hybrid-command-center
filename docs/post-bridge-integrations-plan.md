# Post Bridge Integrations — Development Plan

**Prepared** 20 August 2026
**Reviewed and corrected** 20 August 2026, before card filing
**Written against** `main` `f3e9f0d`, `package.json` 4.4.0 — every repository claim below
was re-checked against this commit
**Source** `docs/post-bridge-api-surface.md` (the research note), `docs/publishing-integration.md`
(the decision record), `docs/social-media-publisher-artifact.md`, and the dated official provider
sources in §4
**Convention** `AGENTS.md` — one card per branch, `<type>/<issue>-<slug>`, one version bump per
merged card, first close in a milestone takes the minor

Eleven cards, **C72–C82**, continuing the numbering from C71 (#198). Issue numbers are not assigned
here: the next free number was **≥ #215** at `f3e9f0d`, and the branch names below carry `<issue>` as
a placeholder to be substituted at filing.

The research note is a findings document and overturns nothing. This plan is the decision layer
between it and the code: what gets built, in what order, and what each card is allowed to change.

---

## 0. Decisions taken before writing this

Four questions were settled on 20 August 2026. They are recorded here because three close options
the research note left open, and one introduces a deliberately narrow exception to the current
media boundary.

**1. The server may hold a user-selected Drive file's bytes in flight, and only in the confirmed
publishing path.** Post Bridge's `create-upload-url` flow is adopted with Google Drive as the byte
source. The server reads one file by ID through the Drive API, streams it directly to the provider's
HTTPS upload URL immediately before a confirmed submit, update, or restore-and-resubmit, and
persists no bytes. **The Drive file never has to be shared publicly.**

This is not a weakening of the Files module. `AGENTS.md`, `shared/drive.ts`, and
`server/drive/browse.ts` continue to promise that Files only browses a project's approved folders and
offers no upload, download, move, rename, or delete. The new byte path lives in
`server/drive/media.ts`, is unavailable to Files, and is callable only from the publish service after
the user confirms the exact plan. The broader statements in `server/db.ts`,
`shared/signal.ts`, `server/app.ts`, and `docs/publishing-integration.md` are narrowed to:
**this app stores no media files, serves no media bytes, and holds no media bytes at rest; the
confirmed publishing path may stream one selected Drive file to the provider.**

The confirmation is about bytes, not merely a file ID. A Drive media row records a version
fingerprint — file ID, name, MIME type, size, Drive version or modified timestamp, and checksum when
Drive supplies one. The preview hash covers that fingerprint. Submit re-reads metadata immediately
before opening the byte stream and refuses a stale confirmation if the file changed, disappeared,
became inaccessible, or no longer satisfies the recorded type and size rules.

Why this rather than public Drive links: the reference this app stores for a Drive item is the
`webViewLink` (`server/drive/google.ts`), which serves an HTML viewer page rather than the file.
Making a folder public would fix neither that nor the missing file extension used by today's
`signalMediaKind` classifier.

**2. Every behavior that removes a refusal or spends an unverified provider field is probed before
implementation.** C73 verifies the exact upload contract, `account_configurations` and same-platform
account policy, post-list pagination, analytics filter semantics and response grain,
`match_confidence` values, YouTube/Instagram media-role fields, and the three platform fields in
C81. A field appearing in OpenAPI proves vocabulary, not working behavior or policy. An
inconclusive result blocks its dependent behavior; a negative result records a will-not-build
decision. No implementation card guesses.

**3. Provider posts this app did not create surface as a queue-health alert.** Read-only. No
adoption: linking an orphan to a Signal post would fabricate a publication row with no idempotency
key and no sent snapshot, which is precisely the unknown state
`docs/publishing-integration.md` §7.2 refuses to backfill.

**4. Platform fields are scoped to channels Signal already has and only to behavior C73 verifies.**
The candidates are YouTube `contains_synthetic_media` and the two TikTok disclosure toggles.
Facebook story placement is already emitted by the generic story path and needs regression coverage,
not a new production feature. Google Business `cta_action_type` still needs a Signal channel that
`SIGNAL_CHANNEL_PLATFORM` deliberately does not invent; it is recorded as deferred in C82.

### Smaller calls made while writing this, each reversible

| # | Call | Alternative that was not taken |
| --- | --- | --- |
| a | A Drive reference is added by **pasting the share link**; the server parses and resolves the file ID | A Drive picker in the composer, which needs a new Signal-specific browsing scope |
| b | Metadata is resolved on paste, can be explicitly rechecked in the composer, and is always revalidated at confirmed submit | A Drive call during preview, which would make preview depend on an external service |
| c | A post mixing a Drive file and a public URL **refuses at preflight** | Fetching arbitrary public URLs into the server |
| d | The live probe is committed under `scripts/` but its request building, guards, teardown, and redaction are tested with an injected HTTP transport | An untestable one-off or any automated test that reaches the live service |
| e | Provider inventory refresh reads every page before one atomic snapshot replacement; a failed page leaves the prior generation untouched | Incremental writes that leave a half-current inventory |
| f | Provider-specific request builders and upload orchestration are testable without a network call | Treating `v8 ignore file` as a permanent reason the riskiest wire shapes cannot be tested |
| g | YouTube's `syntheticMediaDisclosure` moves `IN_CAPTION` → `PROVIDER_FIELD` only after C73 and C81 verify the provider accepts and applies the field | Removing caption disclosure on the strength of OpenAPI alone |

---

## 1. Card index

| # | Card | Type | Size | Wave | Depends on |
| --- | --- | --- | --- | --- | --- |
| C72 | The findings, reviewed plan, and media-boundary decision land in the record | `docs` | M | A | — |
| C73 | Safely probe the live API claims that gate implementation | `chore` | XL | A | C72 |
| C74 | A Signal media reference can be a version-bound Drive file | `feat` | XXL | B | C72 |
| C75 | Media streams to the provider once, with bounded and testable failure semantics | `feat` | XXL | B | C73, C74 |
| C76 | Verified thumbnails, cover images, and LinkedIn documents | `feat` | XL | B | C73, C75 |
| C77 | Explicit same-platform targets and verified account configurations | `feat` | XXL | C | C73, C75 |
| C78 | Posts in Post Bridge that this app did not make | `feat` | XL | D | C73 |
| C79 | A figure says how the provider matched it | `feat` | M | E | C73 |
| C80 | Provider-filtered analytics over a verified window and known delivery set | `feat` | XL | E | C73 |
| C81 | Verified platform disclosure fields | `feat` | L | E | C73 |
| C82 | What stays unbuilt, why, and what would reopen it | `docs` | S | E | every preceding card resolved |

Sizes are the repository's label scale, not development days: `size-s` under 1 hour,
`size-m` 1–3, `size-l` 4–8, `size-xl` 8–12, `size-xxl` a day or more.

### Waves, milestones, and end-to-end coverage

These waves are dependency groups, **not GitHub milestones**. Do not create a code-free Wave A
milestone. At filing time, place the cards in one implementation milestone or split them only so
every resulting milestone includes at least one `e2e/` spec, as `AGENTS.md` requires.

| Wave | Cards | Theme | Browser coverage |
| --- | --- | --- | --- |
| A — Establish the contract | C72, C73 | Land the sources and replace claims with dated facts | none; these cards join an implementation milestone |
| B — Media | C74, C75, C76 | Version-bound Drive media and verified media roles | `e2e/signal-drive-media.spec.ts` |
| C — Account overrides | C77 | Explicit targets plus provider-verified per-account content | extend `e2e/signal-content-variants.spec.ts` |
| D — Orphans | C78 | See what else is in the provider | `e2e/signal-provider-inventory.spec.ts` |
| E — Fields and figures | C79, C80, C81, C82 | Verified fields and provider reads | extend `e2e/signal-analytics.spec.ts` |

Wave A is not optional and is not parallel with cards that spend C73's findings. C74 may start
beside C73 because it adds no provider call; C75 and every conditional provider behavior wait.

### Dependency graph

```text
C72 ─┬─ C73 ─┬─ C75 (with C74) ─┬─ C76
     │       │                  └─ C77
     │       ├─ C78
     │       └─ C79, C80, C81
     └─ C74 ── C75
                                      every result resolved ── C82
```

---

## 2. The cards

### C72 — The findings, reviewed plan, and media-boundary decision land in the record

**Type / branch:** `docs/<issue>-post-bridge-surface-record`
**Size:** M · **Labels:** `docs` `size-m`
**Depends on:** nothing. **Blocks everything.**

#### Problem

`docs/post-bridge-api-surface.md` and this reviewed plan are outside `main`, so the repository
does not yet contain the sources the implementation cards spend. The media decision also contradicts
several broad comments while the Files-module rule must remain unchanged. A behavior card landing
before those distinctions are canonical would leave two answers and no reliable source of truth.

#### Scope

- Identify the exact reviewed sources before copying: the Dropbox file IDs/revisions or an explicit
  source branch and commit. Record those identifiers in the PR description. If either source has
  moved since review, stop and re-review the diff rather than importing a different document under
  the same name.
- Land the findings as `docs/post-bridge-api-surface.md` and this reviewed plan as
  `docs/post-bridge-integrations-plan.md`. The findings remain a dated research note; this plan is
  sequencing, not a second runtime contract.
- Cross-reference both repository files from `docs/publishing-integration.md` only after both paths
  exist. Relative links in the repository copy may target `../server/...`; card bodies copied to
  GitHub use backticked repository paths or immutable GitHub blob links rather than relative Markdown
  links that resolve outside the repository.
- Preserve the Files-module rule in `AGENTS.md`, `shared/drive.ts`, and
  `server/drive/browse.ts` exactly: Files stays project-scoped and offers no download or other
  mutation. Add a separate Signal-publishing paragraph that names `server/drive/media.ts` as the
  only byte path and requires confirmed-submit scope, no at-rest storage, and no Drive write.
- Update every broad statement found by repository search, including the `signal_post_media`
  comment in `server/db.ts`, `shared/signal.ts`, the CSP explanation in `server/app.ts`,
  and `docs/publishing-integration.md` §3. Do not maintain a hand-written count: the acceptance
  check is that the search finds no global “never uploads/downloads/proxies media” claim outside the
  still-valid Files boundary.
- Record the provider media lifecycle as a design constraint: a provider media ID is ephemeral, is
  never a durable Signal reference, and is recreated on submit, update, and restore-and-resubmit.
  The vendor's 24-hour and deletion behavior remains **documented but unverified** until C73 records
  live evidence.
- Record `account_configurations`, media-role fields, analytics filters, and platform disclosure
  fields as pending C73. The current fail-closed capability values remain authoritative until their
  implementation cards land.

#### Out of scope — do not build here

- Runtime behavior, schema, provider calls, or capability-table values.
- Weakening the Files boundary or adding a byte method to the Files browsing surface.
- Flipping `accountContentOverride` or any other pending capability.

#### Acceptance criteria

- [ ] The exact reviewed findings and plan are in `docs/` with their source revisions recorded.
- [ ] The decision record links to both paths, and every link in the repository copies resolves.
- [ ] The Files-module rule is unchanged and a separate publish-media boundary is explicit.
- [ ] A repository-wide search finds no stale global media claim, including `server/app.ts`.
- [ ] Ephemeral provider media and every pending provider claim are recorded without treating
      OpenAPI or vendor prose as live proof.
- [ ] No runtime behavior or capability value changed.

#### Verification

`npm run format:check` and `git diff --check`. Review the repository-wide media-language search
in the PR evidence. No runtime tests are required because runtime behavior does not change.

---

### C73 — Safely probe the live API claims that gate implementation

**Type / branch:** `chore/<issue>-post-bridge-live-probe`
**Size:** XL · **Labels:** `chore` `size-xl`
**Depends on:** C72. **Blocks C75, C76, C77, C78, C79, C80, C81.**

#### Problem

The dependent cards currently spend fields read from OpenAPI, while the vendor's current support
material conflicts with at least two of those readings: same-platform duplicate-content policy and
YouTube custom thumbnails. A live probe is necessary, but it is also a write against connected
social accounts. “Use `--yes`” alone is not a safety boundary, and “leave nothing behind” is not
truthful where uploaded media has no delete endpoint and expires later.

#### Scope

- Commit `scripts/probe-post-bridge.ts` plus focused tests around a provider-neutral, injected HTTP
  transport. Tests cover request serialization, required arguments, response parsing, redaction, and
  `finally` teardown without reaching Post Bridge. The live adapter may remain excluded from coverage;
  the contract-building logic may not.
- The live mode refuses to run unless all of these are supplied:
  `POST_BRIDGE_API_KEY`, `--yes`, an explicit future `--scheduled-at` at least 48 hours away,
  explicit provider account IDs, and a unique `--probe-label`. It lists the selected accounts and
  planned mutations before the final confirmation. No default account and no “first matching”
  behavior exists.
- Human stop conditions:
  - stop if there are not disposable or explicitly approved connected accounts for the platform;
  - stop if the selected accounts contain client/customer production content whose policy could be
    affected;
  - stop if a scheduled probe cannot be read back before testing update;
  - stop and clean up immediately on any unexpected processing/publishing state;
  - never use a customer asset, intentionally trigger a `429`, or leave a post scheduled.
- Enforce a hard maximum of 50 live HTTP requests for one probe run, including cleanup and
  verification. Refuse before the next call when the budget is exhausted; do not increase it without
  a reviewed plan revision.
- Use committed, harmless fixtures within the smallest documented size bounds. The script records
  fixture hashes so the evidence proves what was uploaded without logging bytes, signed upload URLs,
  API keys, raw responses, captions from existing posts, or account credentials.
- What it answers, in order:
  1. **`account_configurations` and policy** — on explicitly approved same-platform accounts, create a
     scheduled post with materially different captions and fixture media where required, read it
     back, repeat through `PATCH`, and record provider acceptance, field persistence, and any
     duplicate-content refusal. A positive API response does not erase a documented platform-policy
     restriction; C77 carries the verified rule into preflight.
  2. **Upload flow and lifecycle** — verify request/response field names, signed `PUT` headers,
     content-length behavior, accepted MIME values, `media` versus `media_urls`, HTTPS/redirect
     behavior, and what `describe` returns. Record current count/size/duration limits and whether a
     media-delete endpoint exists. If uploaded media cannot be deleted, inventory its provider ID
     and verify expiry in a dated follow-up before claiming the lifecycle verified.
  3. **Media roles** — verify scheduled-post acceptance and read-back for YouTube `thumbnail`,
     Instagram `cover_image`, and LinkedIn PDF `document_title`. Record the official-support
     contradiction for YouTube. C76 stays blocked unless the exact role is verified; actual platform
     delivery remains C76's manual QA.
  4. **`GET /v1/posts`** — establish the complete pagination token, repeatable filter encoding,
     stable identity fields, disappearance/deletion behavior, and the shape of a provider-UI post.
     A provider-UI fixture is a named human precondition, not something the API script pretends it
     created.
  5. **Analytics** — establish pagination, `platform` and `timeframe` encoding, whether timeframe
     selects posts or measurement days, the response grain, how rows map to `post_result_id` and
     account, and actual `match_confidence` values. Do not infer an account aggregate from a list
     of delivery rows.
  6. **Platform fields** — verify read-back for YouTube
     `contains_synthetic_media` and TikTok `disclose_branded_content` /
     `disclose_your_brand` on explicitly approved accounts. Confirm Facebook story placement
     remains accepted through the already-shipped generic path.
  7. **Rate-limit evidence** — record `429` headers only if one occurs naturally. The probe has a
     strict request budget and never creates load merely to discover a limit.
- Append a dated result matrix to `docs/post-bridge-api-surface.md`: **verified**,
  **verified with policy constraint**, **negative**, or **still unverified**, with the evidence and
  dependent-card disposition. Never silently convert “still unverified” into permission to build.

#### Out of scope — do not build here

- Runtime application behavior in `server/`, `shared/`, or `client/`.
- Closing, rewriting, or filing dependent GitHub cards automatically. The result matrix supplies the
  disposition; issue changes require their own authorization.
- Publishing a probe post, using real campaign media, probing arbitrary accounts, or load-testing
  rate limits.

#### Acceptance criteria

- [ ] Unit tests prove guard, request, parsing, redaction, request-budget, and teardown behavior with
      no real-network call.
- [ ] Live mode requires every key, argument, explicit account ID, and human stop condition above.
- [ ] Every created post is deleted in `finally` and independently absent from a complete post
      inventory afterward.
- [ ] Undeletable uploaded media is inventoried without secrets and its expiry is either verified in
      a follow-up or left honestly **still unverified**.
- [ ] Every gated claim has one result-matrix state and an explicit effect on C75–C81.
- [ ] No key, signed URL, token, customer content, or raw response is committed or logged.
- [ ] Negative and inconclusive results leave current fail-closed capability values unchanged.

#### Verification

`npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and
`git diff --check`. One owner-run live session plus any required dated expiry follow-up; commit only
the redacted result matrix, never the raw transcript.

---

### C74 — A Signal media reference can be a version-bound Drive file

**Type / branch:** `feat/<issue>-signal-drive-media`
**Size:** XXL · **Labels:** `tier-3-schema` `size-xxl`
**Depends on:** C72. **Blocks C75.**

#### Problem

Media on a post is a public `https:` URL and nothing else, classified from its pathname.
A Drive share link addresses an HTML viewer page and carries no usable extension. More importantly,
a file ID is not evidence of the bytes the user previewed: Drive may replace a file's content under
the same ID. Wave B needs a discriminated source and a version fingerprint without introducing a
Drive call into preview.

#### Scope

- Add `source TEXT NOT NULL DEFAULT 'URL' CHECK(source IN ('URL','DRIVE'))` plus nullable
  `drive_file_id`, `drive_name`, `mime_type`, `size_bytes`, `drive_version`,
  `drive_modified_at`, and `drive_checksum` columns to `signal_post_media`. Existing rows
  become `URL` with every Drive field null. A `DRIVE` row must carry ID, name, MIME, size,
  and at least one version signal; enforce the cross-field rule at the Zod/service boundary and with
  the strongest additive SQLite checks available.
- Keep the existing non-null `url` column for backward compatibility and display: URL rows store
  the public URL; Drive rows store Drive's canonical `webViewLink`. No code treats a Drive row's
  `url` as provider-fetchable media.
- Add `server/drive/media.ts` beside `browse.ts`. It resolves one user-supplied Drive file ID
  to canonical metadata and version evidence. It is a separate capability boundary; Files continues
  to receive only its browsing vocabulary and cannot call this path.
- Accept the documented Drive link forms only after URL parsing and host validation. Reject folder
  links, shortcuts that cannot be resolved to one file, Google-native documents without downloadable
  bytes, missing/invalid size, non-finite values, and a file outside C73's verified MIME and size
  limits. Never accept a raw unvalidated arbitrary ID from the browser.
- Resolve on paste and store the canonical metadata. The composer displays source, name, MIME, size,
  last verification time, and an explicit **Recheck Drive file** action. Recheck replaces the
  fingerprint only through the ordinary Signal edit transaction, which updates the post and
  invalidates any open publish preview.
- Preview performs no Drive or provider call. `signalMediaKind` reads stored MIME for Drive rows
  and the URL pathname for URL rows. The plan hash covers the complete discriminated media
  descriptor and version fingerprint, not only the display URL.
- A failed explicit recheck marks the reference unresolved in the composer and keeps the last
  metadata visible beside the reason; it never silently removes or rewrites the row. C75 performs
  the mandatory final revalidation at submit.
- Add the media-source fields to the shared Signal types, API response/input Zod schemas, service,
  row reader, editor, and fixtures from one shared validation rule.

#### Out of scope — do not build here

- Reading any bytes. This card resolves metadata and version evidence; C75 streams the file.
- Any change to `submit`, `update`, `PublishRequest`, or the adapter.
- A Drive picker. Pasting a link is the whole input surface (§0, call **a**).
- Making anything public. The resolution is authenticated and the file stays private.
- Relaxing Files folder scoping or exposing a general file-by-ID/download route to the browser.

#### Acceptance criteria

- [ ] The additive migration preserves every URL row and enforces the discriminated source contract,
      verified against a copy of a real `command-center.db`.
- [ ] Accepted link forms canonicalize to one file ID; raw IDs, wrong hosts, folders, shortcuts,
      Google-native files, unsupported MIME, and out-of-bounds sizes refuse with specific messages.
- [ ] A Drive video preflights from stored MIME without a Drive call, and the plan hash changes when
      any source or version-fingerprint field changes.
- [ ] Paste and explicit recheck use one validation rule; a failed recheck remains visible and never
      silently drops media.
- [ ] The browser receives metadata but no bytes, token, checksum used as a credential, or arbitrary
      file-read endpoint.
- [ ] Files remains project-scoped and unchanged; this card makes no byte read and no Drive write.
- [ ] Tests use the mock Drive provider and prove that preview makes no external call.

#### Verification

`npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build`, and `npm run db:migrate` against a copy of a real
database. No real Drive call.

---

### C75 — Media streams to the provider once, with bounded and testable failure semantics

**Type / branch:** `feat/<issue>-provider-media-upload`
**Size:** XXL · **Labels:** `tier-3-schema` `size-xxl`
**Depends on:** C74 and C73. **Blocks C76 and C77.**

#### Problem

The adapter sends `media_urls`, so every asset must be publicly reachable. A Drive file is not.
The upload path moves private customer bytes across two external boundaries and can fail after some
provider assets exist but before a post exists. The card therefore owns version revalidation,
resource limits, transport policy, durable evidence, and exact outcome semantics—not only a new
request field.

#### Scope

- Add a narrow byte capability in `server/drive/media.ts`. It opens exactly one C74-recorded file
  as a bounded stream and returns current metadata. It is not exposed through `browse.ts`, the
  Files service, or an HTTP download route.
- Before any byte read, re-resolve metadata and compare the complete C74 fingerprint. A mismatch,
  missing checksum/version evidence, access loss, changed MIME, or changed/out-of-bounds size refuses
  with `409` and requires a new composer recheck and preview. The plan hash is rebuilt before this
  comparison; neither check substitutes for the other.
- Enforce the limits C73 verified, including per-file, per-kind, item-count, total-size, and video
  duration/aspect constraints where the provider actually exposes reliable metadata. Reject before
  download where possible. Count bytes while streaming and abort if Drive sends more than declared.
- `PublishProvider.uploadMedia` accepts a provider-neutral
  `{ name, mimeType, sizeBytes, body }` source. It imports no Drive type and receives no Drive ID.
  The publish service orchestrates Drive; `PostBridgeProvider` alone translates to
  `create-upload-url`, signed `PUT`, and provider media ID.
- Validate upload URLs as HTTPS, reject credentials/fragments, use C73's verified host/redirect
  policy, set explicit connect/body timeouts with abort propagation, and never log the signed URL,
  authorization headers, response body, media bytes, or Drive token. Stream directly; no temp file,
  full-buffer read, cache, or retry after an ambiguous body transfer.
- Extract pure Post Bridge request builders and response parsers, or inject the HTTP transport, so
  upload, create, update, and account/platform configuration wire shapes are unit-tested without a
  live service. `post-bridge.ts` may stay excluded from coverage only if the risky pure logic is
  covered elsewhere.
- Make `PublishRequest` a discriminated union carrying **either** `mediaUrls` or
  `mediaIds`, never both. A URL-only post serializes identically to today's request. A mixed-source
  post refuses at preview, naming the items and offering the two valid resolutions; the server never
  fetches an arbitrary public URL.
- Upload immediately before create/update/resubmit and never persist a media ID as a reusable Signal
  reference. Re-upload every time. Do not claim 24-hour cleanup as fact unless C73 verified it; report
  provider-created leftovers as ephemeral assets with the verified or documented expiry state.
- Preserve legacy evidence additively:
  - leave `sent_media` as the nullable JSON URL snapshot older rows and current reconciliation
    already understand;
  - add nullable, versioned `sent_media_sources` containing discriminated URL or Drive source
    snapshots, including the confirmed Drive fingerprint;
  - add nullable `sent_provider_media_ids` for the exact ephemeral IDs handed to the provider.
  Update shared types, row readers, migrations, and §7.2 so an old NULL remains unknown and no object
  array is parsed as the old `string[]`.
- Define reconciliation explicitly. Where `describe` returns comparable provider media IDs,
  compare them. Where published/expired media is no longer comparable, show **media comparison
  unavailable** and refuse the schedule-only action that requires proof content is unchanged; never
  invent equality from the Drive source snapshot.
- Sequence and record outcomes:
  - Replan, verify hash, revalidate every fingerprint, then upload.
  - If no provider asset landed, write no publication row and one `FAILURE` integration event.
  - If some assets landed and no post request was made, write no publication row and one `PARTIAL`
    event naming the count that landed and the verified/documented cleanup expectation.
  - After every asset succeeds, insert `SUBMITTING` with all snapshots, then call the post
    endpoint. From that point current `FAILED` / `UNCONFIRMED` semantics apply.
  - Update and restore retain their existing publication and two-operation history. An upload
    refusal does not alter provider content; each attempted integration writes one event with the
    correct outcome in the same transaction as its local state change.
- Extend `MockPublishProvider` and the mock media reader with bounded streams, call logs,
  short/long-body failures, aborts, partial uploads, and fingerprint changes. No automated test
  reaches Drive or Post Bridge.

#### Out of scope — do not build here

- Thumbnails and cover images. They need a `media_id` and they are C76.
- Per-account media. It needs `account_configurations` and is named in C77.
- Uploading a public URL's bytes, or any server-side fetch of a non-Drive address.
- Persisting bytes anywhere, including a temp file. A platform/runtime that cannot stream is a stop
  condition and a new reviewed decision, not an implementation improvisation.

#### Acceptance criteria

- [ ] URL-only request serialization is byte-for-byte compatible and covered without live HTTP.
- [ ] Drive-only media revalidates the preview-bound fingerprint, streams within every bound, sends
      `media` IDs, and sends no `media_urls`.
- [ ] Changed metadata/content, excess bytes, timeout, redirect, bad upload URL, mixed sources, and
      unsupported limits all fail closed with specific tests.
- [ ] No Drive type crosses into the provider adapter; Files cannot reach the byte capability.
- [ ] Every submit, update, and resubmit re-uploads; no provider media ID is reused.
- [ ] Zero-upload, partial-upload, complete-upload/provider-failure, and ambiguous-post outcomes
      produce the specified publication and `integration_events` states.
- [ ] Legacy `sent_media` rows still read honestly; the new snapshots are versioned and nullable.
- [ ] Reconciliation never treats expired/unavailable media evidence as equality.
- [ ] The Drive file is never made public or written, and no bytes, tokens, signed URLs, or secrets
      enter disk, SQLite, logs, or errors.
- [ ] `e2e/signal-drive-media.spec.ts`: a post with a Drive asset previews, submits against the mock
      provider with an injected mock Drive (`AppOptions.drive`), and shows delivery.
- [ ] Provider wire-shape logic is covered without contacting the vendor.

#### Verification

`npm test`, `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`,
`npm run lint`, `npm run format:check`, and `npm run build`. One owner-run manual QA
submission with an approved fixture after the automated wire tests pass; verify the provider has no
unexpected scheduled post or unexplained media artifact afterward.

---

### C76 — Verified thumbnails, cover images, and LinkedIn documents

**Type / branch:** `feat/<issue>-provider-thumbnails`
**Size:** XL · **Labels:** `tier-3-schema` `size-xl`
**Depends on:** C73 and C75. **Each provider role is conditional on C73 verifying it.**

#### Problem

The variant editor already collects cover and thumbnail URL strings, but a Drive-backed role needs
the same discriminated source and version evidence as post media. OpenAPI names provider media-ID
fields, while current Post Bridge support material says custom external YouTube thumbnails are not
available. This card may spend only the roles C73 verified and must not force a Drive object into a
column whose contract is “URL string.”

#### Scope

- Add normalized `signal_post_variant_media` rows keyed by
  `(post_id, platform, account_id, role)` where role is `COVER_IMAGE` or `THUMBNAIL`.
  Each row uses the same URL/Drive source contract, metadata, fingerprint, and validation functions
  as C74. Keep `cover_image_url` and `thumbnail_url` as legacy nullable URL columns; backfill
  them once into normalized URL rows and never maintain two writable sources.
- Update variant read/write transactions, Zod input, shared types, confirmation hash, source
  selection UI, explicit Drive recheck, and stale-file behavior. A variant-role edit updates the
  post's `updated_at` so an open publish confirmation becomes stale.
- Upload each role through C75's bounded path immediately before the post media. Keep provider
  request mapping in the tested provider-specific builder.
- For each role:
  - **Instagram `cover_image`:** implement only if C73 verified scheduled-post acceptance and
    read-back. Manual QA verifies actual delivery.
  - **YouTube `thumbnail`:** implement only if C73 resolves the conflict between OpenAPI and
    current provider support guidance positively. A negative or inconclusive result records
    will-not-build and leaves `thumbnail: false`.
  - **LinkedIn PDF:** this is not a separate role row; verify the ordinary C75 PDF media plus existing
    `document_title` path end to end.
- Flip `coverImage` / `thumbnail` only for positively verified roles. Update
  `docs/publishing-integration.md` in the same branch. Keep warnings for every unsupported or
  unverified role.
- Apply C75's fingerprint, size, timeout, partial-upload, snapshot, and reconciliation rules to role
  uploads. A main-media success followed by role-upload failure submits nothing and reports the
  complete partial asset count.

#### Out of scope — do not build here

- TikTok `video_cover_timestamp_ms` and Pinterest's cover fields. They are §8 items on platforms
  whose other fields are C81 or unbuilt.
- Inventing a role from OpenAPI when C73 did not verify its behavior.
- Overloading the legacy URL columns with Drive IDs or provider media IDs.

#### Acceptance criteria

- [ ] The normalized migration backfills legacy URLs once, is idempotent, and leaves one writable
      source of truth.
- [ ] Every role is version-bound, hashed, revalidated, bounded, snapshotted, and reconciled under
      C74/C75's rules.
- [ ] An Instagram reel with a verified Drive cover delivers it as a provider media ID.
- [ ] A YouTube thumbnail is either verified and delivered or explicitly left unsupported; there is
      no unconditional acceptance criterion that contradicts current provider guidance.
- [ ] A LinkedIn PDF publishes as a document post with its title.
- [ ] Role warnings fire everywhere the provider role is negative, unverified, or absent.
- [ ] Capability table, UI, tested request builder, and §3.2 agree exactly.

#### Verification

`npm test`, `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm run build`, and `npm run db:migrate`
against a real-database copy. Manual QA for Instagram cover, LinkedIn PDF, and YouTube only if its
role was positively verified.

---

### C77 — Explicit same-platform targets and verified account configurations

**Type / branch:** `feat/<issue>-account-configurations`
**Size:** XXL · **Labels:** `tier-3-schema` `size-xxl`
**Depends on:** C73 and C75. **Will-not-build if C73 is negative; remains blocked if inconclusive.**
**Gate outcome: positive as of 2026-08-21 — the card is unblocked and not yet built. See below.**

#### Problem

The current planner deliberately resolves each Signal channel to exactly one provider account and
refuses zero or several (`server/publish/plan.ts`, `resolveTarget`). Account variants exist only
after that one account resolves. Therefore `account_configurations` cannot be enabled by flipping a
capability flag: the app first needs an explicit, durable target choice, a preview/report shape that
can show several accounts, and a provider-policy rule for same-platform content. C73 decides whether
the provider field and policy make that capability safe at all.

#### Scope

- **Negative or inconclusive gate:** if C73 does not positively verify
  `account_configurations` and a safe same-platform rule, make no runtime change. Record the
  result and proposed issue disposition; do not close or mutate GitHub state without separate
  authorization.
- Add `signal_post_publish_targets(post_id, channel, provider_account_id, created_at)` with
  additive, idempotent schema and uniqueness over one selected account per post/channel/account.
  It stores an explicit user choice, not a copied provider account record. No rows means today's
  exactly-one resolver and behavior remain unchanged.
- In the on-demand publish preview, list connected accounts and let the user explicitly select
  targets per Signal channel. Persist the selection through a local Signal service route with Zod
  validation. Reject an ID that is disconnected, belongs to another platform, or is not in the
  provider list read for that preview. Signal target edits write no `integration_events` row.
- Refactor planning from one report per channel to one channel with ordered target reports, or an
  equivalent shape that preserves channel grouping while naming every account. Never collapse two
  account refusals into a platform-level sentence. Default/no-selection output stays byte-for-byte
  compatible for the existing one-account case.
- Resolve base → platform → account separately for every selected account. The plan hash covers
  selected IDs, current provider target identity, all resolved account content, and both platform
  and account configurations. Editing a target or account variant invalidates an open confirmation.
- Apply the policy C73 verified. If the provider/platform prohibits identical or insufficiently
  distinct same-platform content, preflight refuses with the exact verified rule. Do not recommend
  filename or metadata tricks as a workaround.
- Flip `accountContentOverride` only for the positively verified platform/account matrix.
  Unverified platforms retain today's single-account refusal.
- Add `accountConfigurations` to the provider-neutral request and tested Post Bridge request
  builder. Emit only the vendor-verified account ID, caption, and media-ID fields. Titles, first
  comments, post kind, placement, and role media remain platform-level and keep explicit warnings.
- Per-account media is available only for all-Drive source selections that C75 uploaded to provider
  IDs. A public-URL account override refuses; it is never dropped or silently replaced with platform
  media. Account media uploads inherit C75's version, bounds, failure, snapshot, and event rules.
- Add a versioned `sent_account_configurations` snapshot rather than changing the JSON meaning
  of legacy `sent_configurations`. Reconciliation, local drift, update, and restore compare the
  exact selected target set and account fields. A migrated NULL remains unknown.
- Update `provider.ts` comments, `docs/publishing-integration.md` §3.1–§3.3 and §7.2,
  capability fixtures, shared types, composer/preview UI, and keyboard/focus behavior in the same
  branch.

#### Out of scope — do not build here

- Splitting one Signal post into several provider posts. Positively verified targets remain one
  provider request.
- Account-level titles, first comments, post shapes, placement, or role media.
- Enabling a platform or policy outcome C73 did not positively verify.

#### Acceptance criteria

- [ ] With no target rows, every existing exactly-one resolution and request remains unchanged.
- [ ] Explicit selections persist, display every account, and refuse disconnected, wrong-platform,
      stale, or unverified targets.
- [ ] Two positively verified same-platform accounts with policy-compliant distinct content submit
      in one request and each receives its own caption.
- [ ] The verified same-platform policy is a preflight rule with fixture coverage.
- [ ] Public-URL per-account media refuses; Drive per-account media uses C75 and never reuses IDs.
- [ ] Account-only unsupported fields remain platform-level with visible warnings.
- [ ] Plan and reconciliation hashes cover target IDs and account configurations; stale target or
      variant edits refuse.
- [ ] Legacy snapshots stay readable and NULL remains unknown.
- [ ] Capability table, provider comments, decision record, UI, and tested request builder agree.
- [ ] `e2e/signal-content-variants.spec.ts` covers the two-account case.

#### Verification

`npm test`, `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build`, and `npm run db:migrate` against a real-database
copy. Manual QA only against the explicitly approved accounts and policy shape C73 verified.

#### Gate outcome — inconclusive on 2026-08-21, positive later the same day

**The gate is inconclusive, so the scope above is unbuilt and the acceptance criteria stay
unchecked.** C73 ran on 2026-08-20 and `docs/post-bridge-api-surface.md` §14 question 1 records all
four `account_configurations` claims as **still unverified**, each against the same evidence: no
platform had two named accounts, so there was no same-platform pair to ask about. That is the run's
own precondition check in `scripts/probe-post-bridge/config.ts` refusing to pretend, not the provider
declining anything — which is why this is the *inconclusive* branch of the gate and not the
*negative* one. Will-not-build would need a refusal, and no refusal was collected.

Accordingly, and as the first scope bullet requires, **this card made no runtime change**: no schema,
no route, no planner refactor, no request field, no snapshot, no capability flip, no UI. What it
produced is this record and the corresponding entry in `docs/publishing-integration.md` §3.3, next to
the behaviour that stays true. `accountContentOverride` remains false on all ten platforms and
`shared/publish-capabilities.test.ts` already pins it there for every one of them, so the fail-closed
value needed no new guard to hold.

**Proposed disposition, for the owner to action — nothing here mutates GitHub state.** #220 stays
**open** and **blocked**, keeping its `tier-3-schema` and `size-xxl` labels and its Wave 12 —
Account overrides milestone; it is not closed and not relabelled will-not-build, because a card
blocked on missing evidence and a card the provider refused are different claims. The one thing that
unblocks it is a re-run of C73's question 1 under that card's existing safety rules — `--live`,
`--yes`, `--accounts-approved`, an instant at least 48 hours out, a fresh `--probe-label`, and two
explicitly approved accounts on one platform each named by `--account <platform>:<id>` — landing all
four claims positive in a new dated §14 matrix. A `verified with policy constraint` on the
same-platform claim is a positive outcome for this card and is what its preflight refusal would be
written from; it is not a reason to keep the card shut. If the owner would rather not connect a
second account on any one platform, the honest resolution is to move #220 to will-not-build and hand
it to C82 — but that is a decision about which accounts exist, not one this record can take.

Because Wave C holds only this card, the milestone currently has no `e2e/` spec to add and
`e2e/signal-content-variants.spec.ts` is untouched. Wave 12 cannot satisfy `AGENTS.md`'s
one-spec-per-milestone rule while its only card is blocked; folding #220 into a later implementation
milestone once it unblocks is the cheaper fix, and is the second thing for the owner to decide.

**Superseded the same day: the gate is now positive.** The owner re-ran C73's question 1 against two
owner-controlled Facebook pages, `85300` and `85301`, and `docs/post-bridge-api-surface.md` §15
records all four claims positive — acceptance, the list-of-objects encoding carrying `account_id`,
per-account `caption` surviving create and `PATCH`, and the same-platform question as **verified
with policy constraint**. The everything-above stands as the account of why the card waited; it is
no longer the account of what the card may do.

**#220 is therefore unblocked and buildable, and still unbuilt.** The scope and acceptance criteria
above apply unchanged, with three things the evidence now pins down: the request builder emits a
list of objects each carrying `account_id`; `accountContentOverride` may go true for **Facebook
only**, since no other platform has two connected accounts and none was probed; and the preflight
rule is written from the *policy constraint*, because the API accepted materially different
captions without complaint and the vendor's support-page restriction is therefore the only thing
standing between a user and a policy violation. The Wave 12 e2e question above is unchanged and
still the owner's to settle.

---

### C78 — Posts in Post Bridge that this app did not make

**Type / branch:** `feat/<issue>-provider-inventory`
**Size:** XL · **Labels:** `enhancement` `size-xl`
**Depends on:** C73.

#### Problem

`describe` answers *what does the provider say about this id*. Nothing answers *what else is in
there*. A post created in the Post Bridge UI, by a VA, or by an agent over their MCP server is
invisible here — and it is the thing most likely to collide with a scheduled slot this app believes
is empty.

#### Scope

- Add an additive `signal_provider_posts` snapshot table carrying provider ID, state, scheduled
  instant, safe caption excerpt, account IDs, provider URL where supplied, and `snapshot_at`.
  Provider ID is the stable key; store no raw response or unbounded caption.
- The person-pressed refresh reads every page using the exact C73 pagination contract **before any
  snapshot write**. Detect repeated cursors/offsets, enforce a page/row safety bound, and treat any
  missing/malformed/failed page as a failed refresh.
- A successful complete read replaces the prior generation in one transaction: delete rows absent
  from the new provider-ID set, upsert current rows, and write the one integration event. A failed
  read leaves every prior snapshot row untouched and writes only the failure event. There is no
  mixed-generation inventory and no old row that alerts forever merely because it disappeared.
- **Refreshed only when a person presses something.** No timer. The alert derives from stored rows,
  so `deriveQueueHealth` keeps its no-network property.
- A new alert kind `PROVIDER_ORPHAN`, severity `WATCH`, with its fingerprint over the provider ids
  and their states — so an orphan that gets published, or a new one appearing, is a new situation
  rather than a dismissed one. Kind, label, severity, and a fixture test beside the rule, as
  `AGENTS.md` requires.
- A read-only panel listing them: what the provider holds, when, to which accounts, and a link out to
  Post Bridge. Nothing in it writes.
- Add the explicit `signal.provider-inventory-refresh` operation to
  `shared/integration-log.ts`. Write exactly one `SUCCESS` or `FAILURE` event per
  person-pressed attempt. This refresh is deliberately all-or-nothing: pagination, normalization, or
  storage failure replaces nothing and is `FAILURE`. `PARTIAL` would be correct only if a
  future design intentionally persists some provider rows.

#### Out of scope — do not build here

- Adoption, linking, importing, or editing an orphan. Explicitly declined in §0.3.
- Cancelling or updating an orphan from this app.
- Any automatic refresh.

#### Acceptance criteria

- [ ] Multi-page, repeated-token, malformed-row, and page-failure fixtures prove that all reads
      finish before any snapshot write.
- [ ] A complete refresh atomically replaces the generation, including removing provider IDs no
      longer listed; a failed refresh leaves the complete prior generation unchanged.
- [ ] Every attempt writes exactly one typed/redacted integration event with honest outcome.
- [ ] A provider post with no local publication raises exactly one alert; one with a publication
      raises none.
- [ ] The alert acknowledges, and returns live when its fingerprint changes.
- [ ] `deriveQueueHealth` still makes no network call and still stores no alert.
- [ ] Pagination bounds and provider caption truncation are exercised against mocked responses.
- [ ] `e2e/signal-provider-inventory.spec.ts`: refresh, see an orphan, acknowledge it.

#### Verification

`npm test`, `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm run build`, and
`npm run db:migrate` against a copy of a real database.

---

### C79 — A figure says how the provider matched it

**Type / branch:** `feat/<issue>-analytics-match-confidence`
**Size:** M · **Labels:** `enhancement` `size-m`
**Depends on:** C73.

#### Problem

`AnalyticsDto` carries `match_confidence` and `platform_post_id` and this app drops them.
The name describes the provider's match between an analytics row and platform content, not the
statistical accuracy of the counts. Presenting it as “confidence in the figure” would overstate what
the provider said.

#### Scope

- C73 supplies the verified enum/nullable behavior. Read `match_confidence` without inventing a
  default. Preserve a future unknown value only when it matches `[a-z0-9_-]{1,40}` and render it
  as **Provider value: …**; omit and record a parser warning for any other shape. Never coerce an
  unknown value to the strongest known value.
- Add nullable `match_confidence` and `platform_post_id` to `signal_post_metrics`
  additively. Existing rows remain null.
- Surface them as provenance: **Provider match: Exact/High/...** and the platform post identity or
  link where safe. Pair text with any icon/color and explain that match quality does not qualify or
  discount the provider's counts.
- Update §16.3 and the provider-neutral analytics type, tested request parser, service transaction,
  row reader, and fixtures.

#### Out of scope — do not build here

- `duration`, `cover_image_url`, and `video_description`. Recorded in C82 as read and unused; none of
  them changes what a figure means.
- Any derived rate, ratio, or average. Still a card that decides what it means.

#### Acceptance criteria

- [ ] Verified match values and platform post IDs persist and round-trip from the tested parser.
- [ ] The UI describes match provenance rather than confidence in numeric accuracy.
- [ ] A record arriving without one shows nothing rather than a default.
- [ ] Unknown future values cannot appear as `Exact`.
- [ ] Existing figures are unaffected by the migration.

#### Verification

`npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build`, and `npm run db:migrate` against a
real-database copy.

---

### C80 — Provider-filtered analytics over a verified window and known delivery set

**Type / branch:** `feat/<issue>-analytics-timeframe`
**Size:** XL · **Labels:** `tier-3-schema` `size-xl`
**Depends on:** C73. **Blocked unless C73 verifies response grain and timeframe semantics.**

#### Problem

The existing analytics contract is per delivery result: `AnalyticsProvider.list` accepts
`post_result_id` values and returns one record per measured delivery. Adding `platform` and
`timeframe` filters does not itself produce an account aggregate, and “7d” may select posts rather
than measurement days. The card needs a verified provider read, a separate stored snapshot, an
explicit local derivation, and honest labels.

#### Scope

- C73 records whether `timeframe` filters post inclusion, measurement dates, or another provider
  meaning; exact pagination; and whether every row still carries `post_result_id`. Use that
  language in the UI. If the meaning remains unclear, do not build this card.
- Preserve `AnalyticsProvider.list(postResultIds)` exactly for per-post refresh. Add a separate
  provider-neutral `listWindow({ platform, timeframe, pageToken })` contract whose name and return
  type state that it returns provider rows, not an aggregate. Its Post Bridge request builder and
  pagination parser are unit-tested without live HTTP.
- Add `signal_analytics_window_metrics` keyed by
  `(platform, timeframe, post_result_id)` with analytics ID, four provider totals, optional
  provider sync/provenance fields, and local `refreshed_at`. Do not overwrite
  `signal_post_metrics`: current per-delivery totals and provider-filtered window rows answer
  different questions.
- A person presses **Refresh window**. Read every page before any write, enforce a page/row bound,
  then replace that platform/timeframe snapshot atomically. A failed or incomplete read leaves the
  last complete snapshot untouched. Opening or changing the selected tab/window makes no provider
  call and never invokes `analytics/sync`.
- Join rows to `signal_publication_targets` by verified `post_result_id`, then group by known
  provider account ID and platform. Unknown provider rows are counted as **unmapped** and are not
  attributed to an account.
- The one permitted derivation is explicit addition of the provider's own four counts over the named
  delivery rows in that snapshot—the same narrow arithmetic rule as campaign analytics. Every group
  reports `deliveries` and `measuredDeliveries`; no measured rows means no `totals` field.
  No rate, average, normalization, follower comparison, or invented zero.
- Add `signal.analytics-window-refresh` to the integration vocabulary and write exactly one
  redacted `SUCCESS` or `FAILURE` event per attempt in the snapshot transaction. The
  refresh is all-or-nothing: an invalid row or incomplete page preserves the prior snapshot. Unmapped
  but structurally valid rows are stored and counted, so they are not partial failure.
- The panel shows the provider's four verified windows and no others, the exact verified timeframe
  meaning, platform/account, mapped/unmapped count, measured/total deliveries, last complete refresh,
  and stale/error state.

#### Out of scope — do not build here

- Any arithmetic beyond addition over the displayed named delivery set.
- Replacing the per-delivery figures. This is a second, cheaper question, not a substitute.
- Calling `analytics/sync`, refreshing on view open, attributing an unmapped provider row, or
  presenting the provider filter as an account aggregate.

#### Acceptance criteria

- [ ] Per-post `AnalyticsProvider.list` and its stored metrics remain unchanged.
- [ ] Multi-page window reads complete before one atomic snapshot replacement; failure preserves the
      last complete snapshot.
- [ ] Opening, switching, and rereading the panel make no provider or sync call.
- [ ] Only verified provider windows appear, labeled with their verified meaning.
- [ ] Every displayed account total is an explicit sum over displayed, locally mapped delivery IDs
      with measured/total counts.
- [ ] Unmapped rows are visible as a count and never attributed; unsupported platforms and
      unmeasured groups carry no totals rather than zero.
- [ ] Exactly one typed/redacted integration event records each refresh attempt.
- [ ] `e2e/signal-analytics.spec.ts` covers stored read, person-pressed refresh, mapped aggregate,
      unmapped row, and failure preserving the prior snapshot.

#### Verification

`npm test`, `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build`, and `npm run db:migrate` against a
real-database copy.

---

### C81 — Verified platform disclosure fields

**Type / branch:** `feat/<issue>-platform-compliance-fields`
**Size:** L · **Labels:** `enhancement` `size-l`
**Depends on:** C73.

#### Problem

`signal_post_variants.disclose_synthetic_media` never reaches a provider field, and OpenAPI names
YouTube and TikTok disclosure controls. These are consequential platform inputs, but sending a flag
is not by itself a legal or policy compliance guarantee. The card implements only fields C73
verified and describes them as provider disclosure controls.

#### Scope

- If C73 positively verifies YouTube `contains_synthetic_media`, send it from the existing
  variant value and move YouTube `syntheticMediaDisclosure` from `IN_CAPTION` to
  `PROVIDER_FIELD`. Only then remove the appended disclosure sentence, recalculate the caption
  limit without it, and remove the old provider-field warning. Negative or inconclusive evidence
  leaves today's caption behavior intact.
- If C73 positively verifies them, add nullable
  `disclose_branded_content` and `disclose_your_brand` columns and shared variant fields for
  TikTok. Offer them for TikTok alone, preserve false versus unset, and validate API and form from
  the same capability rule.
- Extend the provider-neutral platform-configuration type and tested Post Bridge request builder;
  never spread raw variant records into a provider request.
- Facebook story placement requires **regression coverage only**. The existing generic planner
  already sets `story: true` for every supported story kind and the adapter already maps it to
  `placement: "story"`. Add a Facebook fixture proving that path; make no production change unless
  the test exposes a defect, in which case fix it as a separately explained defect within scope.
- Update `docs/publishing-integration.md` and user-facing help to state what each verified
  provider control does and does not guarantee. Never label a post “compliant” solely because a
  toggle was sent.

#### Out of scope — do not build here

- TikTok's `privacy_status`, `allow_comment`, `allow_duet`, `allow_stitch`, `draft`,
  `auto_add_music`, `is_aigc`, and `video_cover_timestamp_ms`; Instagram
  `collaborators`, `user_tags`, and trial-reel fields. Real, unused, and each one a separate
  product decision—recorded in C82.
- Google Business `cta_action_type` and `cta_url`. Blocked on a channel that does not exist.
- Any claim that these controls satisfy all platform, advertising, or legal obligations.

#### Acceptance criteria

- [ ] Every implemented field has positive C73 evidence; negative/inconclusive fields stay
      fail-closed and unchanged.
- [ ] If YouTube is verified, the provider flag is sent and the caption disclosure/limit changes
      exactly once; otherwise current caption behavior remains.
- [ ] Verified TikTok toggles preserve unset versus false, round-trip with Zod validation, and
      appear for TikTok alone.
- [ ] A regression test proves Facebook story placement already works without an unnecessary
      feature rewrite.
- [ ] Provider request-builder tests cover every implemented wire field without a live call.
- [ ] Capability table, §3.2, composer, API, and help text agree and make no compliance guarantee.

#### Verification

`npm test`, `npm run test:coverage`, `npm run test:e2e`, `npm run typecheck`, `npm run lint`,
`npm run format:check`, and `npm run build`. Manual QA of every positively verified field
against its explicitly approved account; none for negative or inconclusive fields.

---

### C82 — What stays unbuilt, and why

**Type / branch:** `docs/<issue>-post-bridge-declined`
**Size:** S · **Labels:** `docs` `size-s`
**Depends on:** every preceding card having a recorded resolution—merged, negative, or
will-not-build. A negative C73 result does not block documentation of that result.

#### Problem

The research note lists more than this plan builds. Without a record of what was declined and on what
grounds, the next reader re-litigates all of it — which is exactly what §10 of the note says about
`use_queue`, and the reason that paragraph exists.

#### Scope

Record, in `docs/publishing-integration.md`, each item as of a dated provider-contract snapshot,
with its reason, current disposition, and concrete trigger to revisit:

- **Their MCP server (§9).** Consuming it buys nothing; the REST client exists. The consequential
  direction is the opposite: an agent writing to Post Bridge bypasses `plan.ts`, the capability
  matrix, the preview, and the confirmation. The architecture-preserving alternative — exposing
  *Signal* over MCP so an agent plans into SQLite and the existing submit path stays the only road
  out — is recorded as the shape to build if agent-driven posting is ever wanted. **C78 is its
  prerequisite either way.**
- **`is_draft` on the wire.** Read already, never sent. A plausible backing for the manual-finish
  queue, and a decision nobody has made.
- **`processing_enabled`.** Real, default `true`, no reason here to set it false.
- **`use_queue`.** Already declined in §5.4; nothing found changes it. Recorded so it is not
  re-examined a third time.
- **Google Business, Pinterest, and Threads.** Reachable by the provider, no Signal channel, and a
  channel exists because content is planned for it. Adding one is a card of its own — schema,
  presets, treatments, composer, and every fixture that enumerates channels — not a field.
- **The remaining §8 fields**, listed by platform, as real and unused.
- **Any C73-negative media role or disclosure field**, including YouTube thumbnail if the current
  OpenAPI/support contradiction was not positively resolved. Revisit only on new provider evidence.
- **Mixed media sources in one post**, refused in C75, with the reason: resolving it means the server
  fetching arbitrary URLs.
- **`GET /v1/analytics/{id}`, `GET /v1/post-results/{id}`, `GET /v1/social-accounts/{id}`,
  `GET /v1/media`.** Marginal; the filtered lists already carry the rows.
- **No webhooks in the reviewed contract.** Polling and person-pressed refresh remain the current
  design. Revisit when a dated official API specification or support announcement adds a webhook
  contract; absence today is not a claim about every future provider version.

#### Out of scope — do not build here

- Runtime, schema, capability, provider, channel, MCP, or UI changes.
- Reopening a decision without the trigger recorded beside it.
- Describing an unverified provider field as supported or a time-sensitive provider limitation as
  permanent.

#### Acceptance criteria

- [ ] Every declined item carries a reason and the thing that would reopen it.
- [ ] The MCP entry names C78 as the prerequisite and Signal-over-MCP as the preserving shape.
- [ ] Every C73-negative/inconclusive item is represented and no positively shipped item is
      described as declined.
- [ ] Time-sensitive provider claims carry an as-of date and a provider-change revisit trigger.
- [ ] Nothing in the list contradicts the final code, capability table, or a card that shipped.

#### Verification

`npm run format:check`.

---

## 3. Risks

**C73 is a controlled live-account operation.** A scheduled probe can publish if cleanup fails, an
uploaded asset may lack a delete endpoint, and same-platform content may be restricted by provider
or platform policy. Explicit account IDs, disposable fixtures, a 48-hour horizon, request budgets,
`finally` teardown, post-run inventory, and human stop conditions are the safety boundary. A
negative or inconclusive result is useful output; it is never permission to improvise.

**C74/C75 move private bytes and must prove which bytes were confirmed.** A Drive ID can outlive its
content. Version/checksum evidence, plan-hash coverage, final metadata revalidation, byte counting,
timeouts, HTTPS/redirect policy, and no-at-rest storage are acceptance criteria. If the runtime
cannot stream under those rules, stop and revisit the decision.

**Provider assets can land without a post.** Zero, partial, complete, and ambiguous stages have
different publication and `integration_events` outcomes. The plan never calls a partial upload a
clean failure and never claims deletion or 24-hour expiry C73 did not verify.

**Provider-specific code is testable without contacting the provider.** Manual QA remains necessary
for actual provider behavior, but pure request builders, parsers, injected HTTP, stream failures,
and redaction are automated. `v8 ignore file` is not a permanent architecture constraint and a
green mock-service suite alone does not sign off the wire.

**C76 and C81 are conditional capabilities.** OpenAPI, current provider support material, and live
behavior may disagree. Capability values change only after positive C73 evidence, and every
implemented field receives manual QA. A negative YouTube thumbnail result is a resolved plan, not a
failed implementation.

**C77 changes target identity, not only text tailoring.** The current app refuses multiple
same-platform accounts. Explicit target persistence, per-account preview reports, stale-target
checks, policy-aware preflight, snapshots, and reconciliation are all in the card; this is why it is
XXL and depends on C75 for media IDs.

**C78/C80 consume complete provider lists.** Every page must be read before one atomic snapshot
replacement. A failed page keeps the prior generation. C80 labels the exact provider-verified
timeframe semantics and describes its account totals as local additions over named delivery rows,
not provider-supplied aggregates.

**Version bumps serialize.** Eleven cards, one version each, and `npm run check:version-bump` catches
a second card claiming a number the first took. Conditional/will-not-build cards take no version
until they actually ship repository changes. Wave B lands C74 → C75 → C76; C77 waits for C73 and
C75 regardless of review order.

## 4. Sources

- `docs/post-bridge-api-surface.md` — the findings this plan spends
- `docs/publishing-integration.md` — the decision record; §3.2, §4,
  §5.4, §7.2, §8, §9, §10, §16
- `docs/social-media-publisher-artifact.md` — the capability table's source
- `AGENTS.md` — branch, version, e2e, and integration-log rules every card above follows
- [Post Bridge API overview, access, and pricing](https://support.post-bridge.com/api/post-bridge-api-overview-access-and-pricing)
  — official entry point to the live API reference
- [Post Bridge same-platform duplicate-content restriction](https://support.post-bridge.com/faq/why-you-cannot-post-the-same-content-to-multiple-accounts-on-the-same-platform)
  — current policy evidence gating C73/C77
- [Post Bridge custom-thumbnail guidance](https://support.post-bridge.com/social-media-scheduling/setting-custom-thumbnails-for-videos)
  — current support evidence that conflicts with unconditional YouTube-thumbnail scope
- [Post Bridge platform and media limits](https://support.post-bridge.com/media-limits-and-processing/post-bridge-platform-limits-and-restrictions)
  — current public bounds C73 must verify for the connected plan/API
