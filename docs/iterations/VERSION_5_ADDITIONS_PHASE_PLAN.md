# Version 5 Additions Phase Plan

Prepared: 18 August 2026  
Written against: `main` `4fb0197`, `package.json` 4.3.0 - every code citation below was checked at that commit  
Scope: the additions identified after the initial Version 5 feasibility study, plus the approved Post Bridge and Buffer-inspired usability work.

## Executive plan

This is a 16-card phase delivered through five serialized waves. Each card remains one branch and one draft pull request with its own changelog fragment. Post Bridge remains the only publishing provider; Buffer is a usability reference rather than a second schedule or delivery path.

**Filed 18 August 2026 as #183-#198, cards C56-C71**, on the Command Center v5 board
(`PVT_kwHOEs58Js4BgQHL`), across five new milestones. Version 5 ended at C55/#181, so this phase
continues at C56. Every branch name below carries its real issue number, so a branch can be cut
without looking anything up: `AGENTS.md` names branches `<type>/<issue>-<slug>`.

The waves keep the repository's numeric milestone sequence, which ended at Wave 5. Wave A below is
milestone Wave 6, and so on through Wave E as Wave 10.

| Plan | Card | Issue | Branch type | Labels | Milestone |
|---|---|---|---|---|---|
| A1 | C56 | #183 | `fix` | `tier-2-ui` `size-l` | Wave 6 |
| A2 | C57 | #184 | `fix` | `tier-2-ui` `size-m` | Wave 6 |
| A3 | C58 | #185 | `feat` | `tier-2-ui` `size-l` | Wave 6 |
| A4 | C59 | #186 | `docs` | `docs` `size-l` | Wave 6 |
| A5 | C60 | #187 | `feat` | `enhancement` `size-xl` | Wave 6 |
| B1 | C61 | #188 | `feat` | `enhancement` `size-xl` | Wave 7 |
| B2 | C62 | #189 | `feat` | `tier-3-schema` `size-xxl` | Wave 7 |
| B3 | C63 | #190 | `feat` | `enhancement` `size-l` | Wave 7 |
| B4 | C64 | #191 | `feat` | `enhancement` `size-l` | Wave 7 |
| C1 | C65 | #192 | `feat` | `tier-3-schema` `size-xxl` | Wave 8 |
| C2 | C66 | #193 | `feat` | `tier-3-schema` `size-xxl` `blocked` | Wave 8 |
| C3 | C67 | #194 | `feat` | `enhancement` `size-xl` | Wave 8 |
| D1 | C68 | #195 | `feat` | `tier-3-schema` `size-xxl` | Wave 9 |
| D2 | C69 | #196 | `feat` | `tier-3-schema` `size-xxl` `blocked` | Wave 9 |
| E1 | C70 | #197 | `feat` | `tier-3-schema` `size-xxl` | Wave 10 |
| E2 | C71 | #198 | `feat` | `tier-3-schema` `size-xxl` | Wave 10 |

`C2`/#193 and `D2`/#196 are filed `blocked`: each carries an open question at the top of its issue
body that must be answered before the card starts.

## Settled product rules

- Remote media loads only after the user selects **Show preview**.
- **Planning status** remains user-owned; **Delivery** appears beside it.
- Consume every analytics capability Post Bridge exposes. Unsupported channels say **Not available from this provider** rather than showing zero.
- Persistent client import identity uses `(source_namespace, external_id)`.
- Multi-select filters use OR within a dimension and AND between dimensions.
- Signal remains the only authoritative schedule.
- Editing Signal never silently modifies a submitted provider post.

## Wave A - Layout, navigation, and visual clarity

| Card | Size | Depends on |
|---|---:|---|
| A1. Independent Settings columns | S-M | - |
| A2. Intrinsic project spacing | S | - |
| A3. Accessible channel treatments | S | - |
| A4. Default-view and URL-state convention | M-L | - |
| A5. Multi-select Status filters | M | A4 |

### A1. Independent Settings columns (`fix`)

`.settings-layout` is already a two-column grid with `align-items: start` (`client/src/styles.css`),
and `e2e/settings-card-height.spec.ts` guards it: C32 (#134) removed the stretching card. What remains
is grid row coupling, not stretch. This card replaces the shared row track with two independent
desktop column stacks so content in one column does not determine the vertical position of cards in
the other.

Acceptance criteria:

- Cards move upward when preceding content in their own column shrinks.
- Drive states, validation messages, and long branding or category content do not create gaps in the neighboring column.
- Mobile has one intentional reading order.
- Keyboard and screen-reader order match the visual order.
- `e2e/settings-card-height.spec.ts` still passes, or its replacement asserts the same promise.

### A2. Intrinsic project spacing (`fix`)

Combine the two project-spacing requests into one card.

Acceptance criteria:

- Project Detail maintains spacing between categories and actions.
- Project tiles maintain spacing between categories, progress, and actions.
- Spacing works with zero, one, or multiple wrapping categories.
- No absolute positioning, fixed card heights, or `margin-top: auto`.
- Tests cover short and long descriptions, zero tasks, and a full task count.

### A3. Accessible channel treatments (`feat`)

Add centralized channel visual tokens to Signal channel selectors and tiles.

Acceptance criteria:

- Each channel receives a surface, border, and text treatment.
- Text or initials always identify the channel; color is never the only signal.
- Neutral fallback tokens exist.
- Every combination passes WCAG AA for small text.
- No externally hosted logos or new trademarked assets.

### A4. Default-view and URL-state convention (`docs`)

Document and apply a consistent state policy by page type.

Rules:

- Collections default to live records and meaningful recency.
- Workflow boards retain canonical workflow order.
- Time views open the current period.
- Context browsers honor explicit URL selection, then a valid remembered selection, then a deterministic fallback.
- Durable filters, selections, and sorts belong in the URL.
- Transient text search may remain local.
- Apply the convention to Projects client and sort state and any explicit live or archived selection gaps.

The convention is written to `docs/view-state-convention.md` and summarized in one `AGENTS.md` line,
in this card branch. It gates A5 and every later card that puts durable state in a URL; it does not
gate A1, A2, or A3, which change layout and color and hold no state.

### A5. Multi-select Status filters (`feat`)

Extend Client, Project, Priority, Task type, and Focus filters to multi-select. Tags are already
multi-select, but they narrow with AND - every selected tag must be present
(`client/src/components/Kanban.tsx`). Decide on this card whether tags keep AND or move to the OR rule
below, and say which in the changelog fragment; do not change it silently.

Acceptance criteria:

- OR within a dimension: `High OR Urgent`.
- AND between dimensions: selected priorities AND task types AND clients.
- Checkbox popovers or accessible combobox panels replace native multi-select controls.
- The existing Status board keys are reused: `client`, `project`, `priority`, `type`, `filter`, and
  `tags` (`client/src/components/Kanban.tsx`). URLs encode values deterministically.
- A bookmarked single-value URL such as `?priority=HIGH` still resolves after the change.
- Back and Forward navigation and reload preserve selections.
- Invalid project selections are removed when their client is deselected.
- Controls show a compact summary and **Clear all**.
- Special values such as **No type** are preserved.

Milestone E2E: deep-link into a multi-filtered Status board, change selections, reload, and navigate Back.

## Wave B - Provider-aware composition

| Card | Size | Depends on |
|---|---:|---|
| B1. Provider capability contract and preflight | M | - |
| B2. Platform content variants and on-demand preview | L | B1 |
| B3. Channel selection presets | S-M | A3 |
| B4. Duplicate post and suggest next slot | S-M | A4 |

### B1. Provider capability contract and preflight (`feat`)

There is no shared capability model yet: `PLATFORM_CAPABILITIES` lives in `server/publish/plan.ts`,
and `shared/publish.ts` carries only publication states and preview shapes. This card moves the table
into `shared/`, types it, and expands it, so the server and UI apply the same provider rules from one
definition.

Model:

- Caption and media limits.
- Supported media combinations.
- Automatic versus manual-finish availability.
- Stories, reels, carousels, and standard posts.
- Platform and account content overrides.
- First comments.
- Titles and descriptions.
- Cover images and thumbnails.
- Synthetic-media disclosure.
- Provider draft support.

Acceptance criteria:

- Preview reports refusals and warnings per target account.
- Failures explain what must change.
- No real provider call occurs during preflight.
- Provider limitations remain centralized outside React.
- Unknown capabilities fail closed.
- Tests cover every channel in `SIGNAL_CHANNELS`, including `blog`, which no provider reaches and which
  must report **Not available from this provider** rather than failing closed as an unknown capability.
- `docs/publishing-integration.md` is updated with the supported contract.

### B2. Platform content variants and on-demand preview (`feat`)

Add the following inheritance model:

```text
base content
  -> platform override
    -> account override
```

Initial fields:

- Platform and account caption overrides.
- YouTube title.
- X first comment.
- YouTube synthetic-media disclosure.
- Supported story or reel placement.
- Platform-specific media selection.
- Supported cover or thumbnail configuration.

Preview behavior:

- Nothing remote loads automatically.
- **Show preview** displays one tab per target account.
- Each tab shows effective text, media order, platform options, local time, provider instant, warnings, and delivery mode.
- Images use constrained thumbnails.
- Video requires explicit play and never autoplays.
- Broken media receives a usable fallback.
- Browser requests use `referrerPolicy="no-referrer"`.
- The server never fetches preview URLs, avoiding a new SSRF surface. This continues the rule already
  recorded on `signal_post_media` in `server/db.ts`: the app never uploads, downloads, or proxies media.

Milestone E2E: create platform overrides, request the preview, verify target-specific output, and confirm publication without contacting a real provider.

### B3. Channel selection presets (`feat`)

Create local Signal presets for commonly selected channel groups.

Examples:

- All GHD channels.
- Visual channels.
- Professional channels.
- Short-form video.
- Client-specific distribution.

Acceptance criteria:

- Selecting a preset populates target channels.
- Users may add or remove channels afterward.
- Presets store stable channel identifiers.
- Missing channels are visibly excluded rather than silently substituted.
- Provider groups are not synchronized or treated as authoritative.

### B4. Duplicate post and suggest next slot (`feat`)

Add **Duplicate to unscheduled queue** and **Suggest next open slot**.

Acceptance criteria:

- Duplication copies content, media, campaigns, and provider options but not publication or delivery records.
- The duplicate receives a new ID and a null date and time.
- Suggested slots are computed from the Signal schedule.
- A suggested slot is not saved until the user confirms it.
- No recurring provider queue or second schedule is introduced.
- Conflicts are recalculated immediately before save.

## Wave C - Delivery control and operational clarity

| Card | Size | Depends on |
|---|---:|---|
| C1. Planning and delivery status separation | M-L | B1 |
| C2. Update, reschedule, and cancel provider posts | L | C1, B2 |
| C3. Queue-health alerts | M | C1 |

### C1. Planning and delivery status separation (`feat`)

Keep existing Signal planning values under the label **Planning status**. Display a separate **Delivery** section per publication target.

Delivery has two orthogonal axes, and the schema must keep them apart.

Mode, which is new:

- Automatic publishing.
- Provider draft.
- Manual finish required.
- Unsupported.

State, which already exists as `PUBLICATION_STATES` in `shared/publish.ts`: `SUBMITTING`,
`SUBMITTED`, `CONFIRMED`, `PARTIAL`, `FAILED`, `UNCONFIRMED`, `CANCELLED`. This card adds no values to
that union; it decides which of them the UI groups and how each is labelled.

Acceptance criteria:

- Delivery is shown beside planning status.
- Bounded reconciliation uses widening intervals and a visible last-checked time.
- Manual refresh remains available.
- Manual-finish records explain what must be completed in the native application.
- Users can mark a manual delivery complete.
- Provider results never automatically write `SignalPost.status = PUBLISHED`.
- Partial multi-account success remains visible per target.

### C2. Update, reschedule, and cancel provider posts (`feat`)

Add explicit remote lifecycle controls for scheduled or draft provider posts.

**Prerequisite, to be answered before this card is filed.** `PublishProvider` is `listTargets`,
`submit`, `check`, and `cancel` today (`server/publish/provider.ts`); there is no update path, and no
source in this plan establishes that Post Bridge has one. Confirm it against the API reference. If it
does, this card adds interface methods and mock coverage for them. If it does not, both update actions
become cancel-and-resubmit, and the criteria below on idempotency, `provider_post_id`, and any retained
permalink change with them. Do not size this card until that is settled.

Actions:

- **Update provider content**.
- **Update provider schedule**.
- **Cancel provider post**.
- **Restore from Signal and resubmit**.

Acceptance criteria:

- A Signal edit produces **Provider update required**; it does not mutate the provider automatically.
- Every action has a no-write diff preview.
- Confirmation data includes the provider record and expected current state.
- Commit rejects a stale preview.
- Published posts cannot use the scheduled or draft cancellation path.
- Provider writes are idempotent where possible.
- Partial outcomes are retained and retryable.
- Every external operation records a redacted `integration_events` entry in the same transaction as its local publication update.
- Provider credentials and raw responses never reach the browser or integration log.

Milestone E2E: submit a scheduled post, edit Signal, preview the provider difference, confirm rescheduling, and reconcile the mocked provider.

### C3. Queue-health alerts (`feat`)

Add an in-app Signal health summary.

Alert conditions:

- Failed or partially delivered post.
- Post approaching its scheduled time without confirmed submission.
- Manual-finish post awaiting completion.
- Provider state changed since the last check.
- Channel has no future scheduled content within a configurable window.
- Analytics synchronization is rate-limited or stale.

Acceptance criteria:

- Alerts link directly to the affected post.
- Status color is paired with text and iconography.
- Acknowledging an alert does not alter planning or delivery state.
- Alert derivation is deterministic and tested outside React.
- Email and push-notification services remain out of scope.

## Wave D - Analytics and campaign context

| Card | Size | Depends on |
|---|---:|---|
| D1. Provider result identity and analytics ingestion | L | C1 |
| D2. Signal campaigns and segmented analytics | M-L | D1 |

### D1. Provider result identity and analytics ingestion (`feat`)

Persist each Post Bridge `post_result_id` on the corresponding publication target, then add a read-oriented analytics service.

Suggested schema. `signal_publication_targets` is keyed `(publication_id, provider_account_id)` and has
no id column, so the identity is an additive column on it and the snapshots are their own tables:

```text
signal_publication_targets.post_result_id
signal_post_metrics       -- current totals per target
signal_post_metric_days   -- normalized daily snapshots, when the provider supplies them
```

`server/db.ts` migrates additively, so a new column and new tables are compatible with an existing
database.

Acceptance criteria:

- Reconciliation captures provider result identity per target.
- Sync uses every analytics platform currently exposed by Post Bridge.
- Unsupported channels show **Not available from this provider**, never zero.
- Store current totals and normalized daily snapshots when supplied.
- Initial metrics include provider-reported views, likes, comments, and shares.
- UI shows the last-synchronized time.
- On-demand refresh is the default.
- Rate limits and `429` responses use bounded backoff.
- A failed refresh cannot overwrite the last known successful values.
- Analytics methods remain separate from Signal's read-only schedule provider.

### D2. Signal campaigns and segmented analytics (`feat`)

Buffer calls this concept tags, but repository terminology reserves tags for tasks. Model the feature as Signal campaigns.

**`signal_posts.campaign` already exists** - one nullable free-text column per post, described in
`shared/signal.ts` as the campaign and week a post belongs to, edited in the Signal form, validated in
`server/signal/service.ts`, and populated by `server/signal/archive.ts` from `campaign-archive.json`.
Before this card is filed it must state how that column becomes the join:

1. Whether existing values are backfilled into `signal_campaigns` under the shared normalization rule,
   and what a duplicate spelling resolves to.
2. Whether the column is then left in place or removed. `server/db.ts` is additive by design, so
   removing it is its own migration and its own decision.
3. What the archive importer writes afterward, and whether re-running it stays idempotent.

Suggested schema:

```text
signal_campaigns
signal_post_campaigns
```

Acceptance criteria:

- Campaign names use the shared case-insensitive normalization rule.
- A post can belong to multiple campaigns.
- Renaming a campaign is one write.
- Deleting a campaign detaches it and never deletes a post.
- Analytics filter by campaign, channel, account, and date range.
- Multiple selected campaigns use OR semantics.
- Show totals and a compact daily trend.
- Existing unclassified posts remain visible under **No campaign**.

Milestone E2E: publish mocked posts in two campaigns, ingest analytics, and verify campaign and date filtering.

## Wave E - Import identity and merge refinement

| Card | Size | Depends on |
|---|---:|---|
| E1. Persistent client import identity | M-L | - |
| E2. Client merge field selection | M-L | E1 |

### E1. Persistent client import identity (`feat`)

Add:

```sql
CREATE TABLE IF NOT EXISTS client_import_aliases (
  source_namespace TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  client_id        TEXT NOT NULL REFERENCES clients(id),
  created_at       TEXT NOT NULL,
  UNIQUE (source_namespace, external_id)
);

-- A merge reads every alias pointing at the client being merged away, for the same reason
-- idx_client_merges_surviving exists.
CREATE INDEX IF NOT EXISTS idx_client_import_aliases_client
  ON client_import_aliases(client_id)
```

Namespace:

```text
campaign-playbook:<stable-source-uuid>
```

Resolution rules:

1. Resolve an exact `(source_namespace, external_id)` match.
2. If absent, apply existing natural-name and merged-name matching.
3. If identity and name resolve to different clients, reject preview with no writes.
4. A confirmed natural-name match attaches the identity in the import transaction.
5. Routine imports never silently retarget an established identity.
6. Client merge retargets every import alias to the survivor.
7. One client may carry multiple source identities.

Additional scope:

- Add optional `client_import_id` and source namespace metadata to the workbook format.
- Keep `client_key` for within-workbook relationships.
- Update validation, receipts, sample workbooks, migrations, and `docs/campaign-playbook-import-format.md`.
- Rule 6 lands in `server/client-merge.ts`: `commitClientMerge` rebuilds its plan inside the transaction
  and rejects a stale hash, so retargeting aliases changes what that plan covers and what the hash must
  include.
- Preserve preview and commit replanning and transactional import behavior.

### E2. Client merge field selection (`feat`)

Extend the shipped basic merge rather than replacing it.

Preview each mergeable client field with:

- **Keep destination** - default.
- **Use source**.
- **Custom value**.

Acceptance criteria:

- Choices cover exactly these columns: `name`, `contact_name`, `email`, `phone`, `website`, `notes`.
  `status`, `slug`, and every `drive_*` column are excluded.
- The card settles what happens to `slug` when **Use source** is chosen for `name`. `slug` is `UNIQUE`
  and name-derived, so leaving it yields a survivor whose slug no longer matches its name, and
  regenerating it changes an existing URL. State the answer; do not leave it to the implementer.
- Blank versus nonblank values never change the default implicitly.
- Confirmation hash includes every selected value.
- Commit recomputes and rejects stale previews.
- Projects move atomically as they do now.
- Existing merged-name aliases and new import aliases retarget to the survivor.
- Source remains archived.
- Drive IDs, folders, files, and hierarchy remain untouched.
- No integration event is written because client merge is a local operation.
- Project, task, and other entity merging remain out of scope.
- No undo claim is made without a tested reverse transaction.

Milestone E2E: import a source-identified client, merge it with selected field values, re-import the old identity, and verify resolution to the survivor.

## Release order

```text
Wave A -> Wave B -> Wave C -> Wave D
                 \
                  -> Wave E may begin after E1 design approval
```

Wave E can run alongside late delivery work, but E2 must follow E1. Analytics must not begin before provider result identities are durable.

## Phase boundaries

Explicitly out of scope:

- Buffer as a second publishing provider.
- AI-generated captions.
- Comment and community management or saved replies.
- Team permissions and approval roles.
- Provider-independent media upload or storage.
- Automatic remote mutation following a local edit.
- Automatic analytics refresh on every page load.
- Merging projects, tasks, or other entity types.
- Email, SMS, or mobile push infrastructure.

## Delivery requirements

- One card per branch and pull request.
- Draft pull requests retain one issue-specific changelog fragment and do not claim a version.
- External inputs are validated with Zod.
- Provider tests use mocks and never contact Post Bridge or Drive.
- Each wave or milestone adds at least one browser-critical E2E workflow.
- Required gates include coverage, typecheck, lint, format check, production build, and E2E.
- Coverage thresholds are the measured figures, not targets: raise one when a card genuinely covers
  more, and never lower one to make a branch pass.
- Cards are filed with issue numbers before any branch is cut. This phase is filed: C56-C71, #183-#198.
- Release finalization follows the repository's serialized version-assignment process.

## External references

- [Post Bridge API reference](https://api.post-bridge.com/reference)
- [Post Bridge platform captions](https://support.post-bridge.com/getting-started/how-to-customize-captions-for-different-social-media-platforms)
- [Post Bridge account groups](https://support.post-bridge.com/social-media-connections/how-to-group-accounts-for-faster-posting)
- [Post Bridge platform limits](https://support.post-bridge.com/media-limits-and-processing/post-bridge-platform-limits-and-restrictions)
- [Post Bridge TikTok drafts](https://support.post-bridge.com/social-media-scheduling/save-tiktok-posts-as-drafts-via-post-bridge)
- [Buffer publishing overview](https://support.buffer.com/article/600-getting-started-with-buffers-publishing-features)
- [Buffer scheduling](https://support.buffer.com/article/642-scheduling-posts)
- [Buffer notifications](https://support.buffer.com/article/506-enabling-notifications-in-buffer)
- [Buffer campaign tags](https://support.buffer.com/article/585-creating-and-managing-tags)
