# Published Deletion — Decision Record

Status: **decided, not implemented.** This document settles what “delete a published post” can mean
in Hybrid Command Center — the vocabulary, provider evidence, invariants, and which operations
may be built. It adds no application code, makes no live provider call, and does not change runtime
behaviour.

Card: C106 (#305). Wave 20 — provider lifecycle. **Release prerequisite:** version 5.0.0 complete.
Builds on the publication model in [`publishing-integration.md`](publishing-integration.md) §6–§7
and §7.2, Buffer lifecycle rules in §2.1–§2.2, and dated probe evidence in
[`post-bridge-api-surface.md`](post-bridge-api-surface.md) §14 and
[`publishing-integration.md`](publishing-integration.md) §2.2.

**Nothing in this card treats a generic HTTP `DELETE` as proof that live social content comes
down.** Each operation is named, bounded by dated contract or probe evidence, and offered only
where that evidence is positive.

---

## 1. The decision

**“Delete” in the planner today conflates three incompatible intents.** They are separated here
into three operations with distinct names, confirmation rules, and provider boundaries:

| # | Operation (user-facing name) | What it does | Live on platform? |
| --- | --- | --- | --- |
| 1 | **Withdraw provider submission** (*Cancel provider post* in the reconcile panel) | Removes a **scheduled or draft** remote post the provider still holds | No — not yet published |
| 2 | **Retire local Signal plan** (*Retire plan* — new; replaces the conflated **Delete**) | Hides the post from ordinary planning views while **keeping** publication history, integration events, and per-target remote ids | Unchanged — does not touch the platform |
| 3 | **Remove from live platform** (*Unpublish* — **will not build**) | Deletes content already live on Instagram, TikTok, X, etc. | Yes — would unpublish |

Six rules follow:

1. **One destructive control must not stand for all three.** The planner’s single **Delete** button
   and `DELETE /api/signal/posts/:id`, which today runs `cancelLiveForPost` then hard-deletes the
   row, are **legacy conflation** to be replaced under C107 (#306).
2. **Withdrawal is a provider write with confirmation.** It uses the existing reconcile path:
   read remote state, build `reconcileHash`, refuse stale or ineligible states, confirm, then
   `DELETE` (Post Bridge) or `deletePost` (Buffer) per target. One `integration_events` row per
   successful withdrawal; partial multi-target outcomes stay per target.
3. **Retiring a plan is local and irreversible in the UI sense.** It sets a **lifecycle** outcome
   (C107) rather than `DELETE FROM signal_posts`. Publication rows, targets, metrics, and the
   integration log stay append-only. Drive files are never renamed, moved, trashed, or edited as a
   side effect.
4. **Live removal is declined until positively evidenced per provider and per platform state.**
   Neither Post Bridge nor Buffer has dated proof that deleting a **published/sent** remote post
   removes content from the social network. Direct platform APIs are not integrated.
5. **Planning status stays three-valued.** `DRAFT` / `SCHEDULED` / `PUBLISHED` remains the user’s
   claim about the plan’s progress. **Deleted** is a lifecycle outcome; **Outside of Signal** is
   provenance — neither belongs on the status select (C107).
6. **MCP and automation inherit the same split.** `signal_delete_post` (named in
   [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) §9) may retire a local plan only;
   provider withdraw stays UI-confirmed until a future security card says otherwise.

---

## 2. Vocabulary and user intent

### 2.1 Withdraw provider submission

**Intent:** “Stop this from going out” or “Take it out of the provider queue.”

**Scope:**

- Post Bridge: `DELETE /v1/posts/{id}` when the remote record is **scheduled or draft** only.
- Buffer: `deletePost` when `Post.allowedActions` includes `deletePost` for that exact remote id.
- Multi-target Buffer publications: each channel is a separate remote post; withdrawal is **per
  target**, and a partial outcome is reported honestly (`PARTIAL` on the integration log when some
  targets withdraw and some refuse).

**Not in scope:** Removing content already live on a social network. The reconcile panel already
names this **Cancel provider post**; keep that label in provider contexts and use **Withdraw
provider submission** in planner-level copy where the audience may not know “provider.”

### 2.2 Retire local Signal plan

**Intent:** “Remove this from my schedule / planner” while keeping audit history.

**Scope:**

- Set `signal_posts.lifecycle = 'RETIRED'` (exact column name and filter behaviour are C107’s).
- Row remains in SQLite; publications, targets, metrics, and integration events stay linked.
- Default planner, calendar, and queue-health views **exclude** retired plans unless the operator
  explicitly shows them (same pattern as archived clients).
- Confirmation names what is **not** happening: retiring does not withdraw a live submission and
  does not unpublish platform content.

**Refused without a separate withdraw when:** a publication is in `SUBMITTING`, `SUBMITTED`, or
`UNCONFIRMED` — the operator must withdraw or reconcile first, or retire only after the
publication reaches a terminal state (`CONFIRMED`, `PARTIAL`, `FAILED`, `CANCELLED`).

### 2.3 Remove from live platform (declined)

**Intent:** “Delete this from Instagram / TikTok / YouTube / X.”

**Verdict:** **Will not build** on current evidence. The app stores no direct platform OAuth for
Facebook, Instagram, TikTok, YouTube, LinkedIn, Threads, Bluesky, or Pinterest. The only remote
writes go through Post Bridge and Buffer, and both providers’ delete operations are evidenced only
**before** publish (§3).

**Operator guidance (copy only, no API):** when content is already live, removal happens in the
platform’s own application or business suite. The planner may link to a stored permalink when one
exists; it must not imply the app can pull the post down.

---

## 3. Provider capability inventory

Evidence classes match the repository rule: **verified**, **negative**, **still unverified**.
OpenAPI or GraphQL schema vocabulary alone is **documentation**, not permission to build, until a
dated §14 or §2.2 matrix records live behaviour.

### 3.1 Post Bridge

| State (provider) | `DELETE /v1/posts/{id}` | Evidence | App disposition |
| --- | --- | --- | --- |
| `scheduled`, draft (`is_draft`) | Accepted in probe teardown | **verified** — 3 created, 3 deleted, inventory absent ([`post-bridge-api-surface.md`](post-bridge-api-surface.md) §14 teardown) | **Withdraw** — existing `PublishProvider.cancel` |
| `processing` | Refused — ambiguous send in flight | **verified** — contract + app refusal ([`publishing-integration.md`](publishing-integration.md) §7.2, §8) | **Refuse** — no gamble |
| `posted` | `400` — “Can only delete scheduled or draft posts.” | **verified** — OpenAPI + app pre-refusal ([`publishing-integration.md`](publishing-integration.md) §7.2) | **Will not build unpublish** |
| `failed` | Nothing to withdraw | **verified** — restore path skips `DELETE` ([`publishing-integration.md`](publishing-integration.md) §7.2) | Local release only |

**No inference rule:** a successful `DELETE` on a scheduled Post Bridge post proves the **queue
entry** is gone, not that a previously published post on the same account was affected.

### 3.2 Buffer

| State (provider) | `deletePost` | Evidence | App disposition |
| --- | --- | --- | --- |
| `scheduled` (customScheduled, pre-send) | Returned deleted id; complete paginated read proved absence | **verified** — TikTok image-backed probe 23 Aug 2026 ([`publishing-integration.md`](publishing-integration.md) §2.2) | **Withdraw** when `allowedActions` includes `deletePost` |
| `draft`, `needs_approval`, `error` | Documented mutation; not live-probed in C83 | **still unverified** | **Refuse until probed** — offer only where `allowedActions` says so after a fresh read |
| `sending` | Not probed | **still unverified** | **Refuse** — same rule as Post Bridge `processing` |
| `sent` | Not probed — probe deleted before publish | **still unverified** | **Will not build unpublish** — absence of evidence is not permission |

**No inference rule:** `deletePost` returning an id is not cleanup proof; the adapter already
requires absence from a complete paginated read on probe teardown. Production code must keep that
discipline for withdraw, and must not treat `sent` delete as available without a dated matrix row.

### 3.3 Direct platform (no integration)

| Route | Capability | Evidence | App disposition |
| --- | --- | --- | --- |
| Native platform APIs (Meta, TikTok, Google, etc.) | Not present in this codebase | N/A | **Out of scope** — no card without a provider boundary and OAuth model |
| Manual posting outside Signal | Operator publishes without a publication row | Described in [`social-media-publisher-artifact.md`](social-media-publisher-artifact.md) §10 | **Outside-of-Signal provenance** (C107) — not a delete operation |
| Legacy Social Media Publisher page | Remove on draft/scheduled Post Bridge only; “never had the power to pull a post off Instagram or X” | **verified** — artifact behaviour ([`social-media-publisher-artifact.md`](social-media-publisher-artifact.md) §8) | Confirms §2.3 — unpublish is not assumed |

---

## 4. Invariants (non-negotiable)

These survive every operation this decision enables:

| Invariant | Rule |
| --- | --- |
| **Publication history** | `signal_publications` and `signal_publication_targets` are never hard-deleted to satisfy a “delete post” request. States may advance (`CANCELLED` on withdraw); rows stay for audit. |
| **Integration log** | Append-only via `recordIntegrationEvent`. Withdraw records `signal.provider-cancel` (or Buffer equivalent per target). Retire records a local Signal operation — source and operation name are C107’s to add. |
| **Per-target remote ids** | Stored ids remain on target rows after retire so history, analytics, and permalinks stay resolvable. |
| **Drive** | No rename, move, trash, or content mutation on Drive files when retiring a plan or withdrawing a submission. |
| **Signal authority** | `signal_posts.date` / `time` / `status` are not rewritten by withdraw or retire. Only Signal’s own service (or the user through it) changes planning fields. |
| **Publisher boundary** | `server/publish/service.ts` never deletes `signal_posts`. Retire is implemented in `server/signal/service.ts` (C107). |

---

## 5. Confirmation, staleness, partial outcomes, and recovery

### 5.1 Confirmation

| Operation | Confirmation shape |
| --- | --- |
| Withdraw | Existing reconcile panel: preview diffs/refusals, `reconcileHash`, explicit action button. No one-click withdraw from the planner header. |
| Retire plan | Typed or explicit confirm naming irreversibility **for planning views**, listing linked publications that will remain visible in history, and stating that platform content is untouched. |
| Unpublish | N/A — not offered |

### 5.2 Stale-provider check

Withdrawal **must** re-read the remote record at commit time. The commit token remains
`reconcileHash` over the plan and provider record ([`publishing-integration.md`](publishing-integration.md)
§7.2). If the remote state moved from scheduled to `posted` between preview and confirm, the action
refuses and the operator sees the new state — not a generic `DELETE` error.

### 5.3 Partial multi-target outcomes

Buffer multi-channel submissions already commit per target. Withdrawal follows the same rule:

- Each target withdraws independently with its own read and hash where the architecture requires it.
- Some targets succeeding and others refusing yields **`PARTIAL`** on the integration log with a
  summary naming which remote ids were withdrawn and which refused.
- Retiring the local plan is allowed when no publication is **live-in-flight** (§2.2), even if
  history shows a partial withdraw — history stays readable.

### 5.4 Recovery

| Situation | Recovery path |
| --- | --- |
| Withdraw succeeded, plan still active | Plan unchanged; publication `CANCELLED`; operator may edit and submit again. |
| Withdraw refused (published/processing/sent) | Operator uses platform apps to remove live content if desired; may retire plan locally after reconciling delivery state. |
| Retire mistaken | **No undelete in v1.** C107 may record `retired_at` and `retired_by` for audit; restoration is a future card if needed. |
| Orphan provider post (never sent from here) | Unchanged — C78 inventory; adopt/edit/withdraw still declined ([`post-bridge-integrations-plan.md`](post-bridge-integrations-plan.md) §0.3). |

---

## 6. Will-not-build: live platform removal

**Unpublish is not built** until **all** of the following are true for a given provider route and
platform state:

1. A dated owner-run probe (Post Bridge or Buffer) creates or identifies a **published/sent** post,
   calls the provider delete mutation, and records whether the content is removed from the social
   network — not merely absent from the provider dashboard.
2. The probe transcript names the exact platform, account, and post shape (image, video, story, etc.).
3. A decision amendment adds the operation to this document with the same vocabulary as §2.1–§2.2,
   and an implementation card is filed with explicit confirmation and rate-limit budget.

**Until then:** the UI must not offer “Remove from Instagram/TikTok/…” and must not map the
planner **Delete** control to any provider call when delivery is `CONFIRMED` / `PARTIAL` or when
Buffer state is `sent`.

---

## 7. Current conflation (to be removed)

Today’s behaviour violates §1 and is explicitly **not** the target state:

```text
Planner [Delete] → DELETE /api/signal/posts/:id
  → cancelLiveForPost (withdraw if live submission exists)
  → deletePost (hard DELETE FROM signal_posts)
  → blocked with 409 when publication history exists
```

Problems:

- One label covers withdraw **and** hard delete.
- Retire is impossible when any publication row ever existed — the user only sees “Publication
  history protects this post from deletion.”
- A successful withdraw still throws 409 and leaves the plan in place, which reads like a failure
  after doing the right thing.

C107 replaces this with separate **Withdraw** (reconcile panel only) and **Retire plan** (local
lifecycle), and removes the hard-delete path for posts with publication history.

---

## 8. Threat-model checklist

- [ ] No single button implies unpublish.
- [ ] Provider capability is never inferred from HTTP method name alone.
- [ ] Retire never calls `PublishProvider.cancel` or `BufferWriteProvider.cancel` implicitly.
- [ ] Withdraw never runs without fresh reconcile evidence.
- [ ] Partial Buffer multi-target withdraw reports `PARTIAL`, not `SUCCESS`.
- [ ] MCP retire tool cannot withdraw or unpublish without the same boundaries as HTTP.
- [ ] Drive files are untouched by all three code paths.

---

## 9. Implementation cards

Only positively supported operations receive implementation work. Unpublish stays un filed.

| Card | Type | Size | Wave | Issue | Depends on | Delivers |
| --- | --- | --- | --- | --- | --- | --- |
| **C106** | `docs` | M | 20 | #305 | 5.0.0 | This decision record |
| **C107** | `feat` | L | 20 | #306 | **C106** | Lifecycle `RETIRED`, outside-Signal provenance, migration, filters, separate **Retire plan** vs reconcile **Withdraw**, removal of conflated `DELETE` hard-delete; README / manual / import updates per issue |
| **C108** | `feat` | L | 20 | #307 | C87 (#261) | Post-submit auto-reconciliation — **orthogonal** to deletion; does not add unpublish |

**No card is filed for unpublish.** Reopen §6 when probe evidence exists.

### C107 acceptance alignment (from C106)

C107 must satisfy, in addition to its issue body:

- [ ] Planner **Delete** is replaced by **Retire plan** with confirmation copy from §5.1.
- [ ] `DELETE /api/signal/posts/:id` no longer calls `cancelLiveForPost` implicitly.
- [ ] Withdraw remains only on the provider reconcile panel (Post Bridge four-actions model; Buffer
  per-target panel).
- [ ] Posts with any publication history retire instead of hard-delete; cascade rules preserve
  publication tables.
- [ ] Filters and counts state whether they use planning status, lifecycle, or delivery state.

---

## 10. Verification (this card)

This documentation card is complete when:

- [ ] §1–§3 separate scheduled withdrawal, local retirement, and live removal.
- [ ] §3 cites dated evidence and marks `sent`/`posted` delete **unverified** or **negative**.
- [ ] §4–§5 state audit preservation and confirmation rules explicitly.
- [ ] §6 states unpublish will-not-build and reopening conditions.
- [ ] No application code or live provider call is added.
- [ ] `npm run format:check` and `git diff --check` pass.

---

## 11. Sources

- [`publishing-integration.md`](publishing-integration.md) — §6 status vs delivery, §7 delete-before-row,
  §7.2 four actions, §2.1–§2.2 Buffer contract and probe matrix
- [`post-bridge-api-surface.md`](post-bridge-api-surface.md) — §3 endpoint table, §14 live probe
- [`social-media-publisher-artifact.md`](social-media-publisher-artifact.md) — §8 Remove behaviour
- [`post-bridge-integrations-plan.md`](post-bridge-integrations-plan.md) — §0.3 inventory non-adoption
- [`multi-agent-mcp-decision.md`](multi-agent-mcp-decision.md) — MCP tool boundaries
- GitHub issues [#305](https://github.com/GHolmesDesigns/hybrid-command-center/issues/305),
  [#306](https://github.com/GHolmesDesigns/hybrid-command-center/issues/306),
  [#307](https://github.com/GHolmesDesigns/hybrid-command-center/issues/307)
