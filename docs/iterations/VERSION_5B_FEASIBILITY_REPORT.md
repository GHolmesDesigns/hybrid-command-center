# Version 5b Feasibility Report

Reviewed: 2026-08-23  
Source: `C:\Users\garni\Dropbox\GHD Deliverables\House\Version 5.docx`  
Source modified: 2026-08-23 18:33:13 -04:00  
Source SHA-256: `8AD42C739F6B7C3032D8061F38A9E5EA236CE47AC0A146A62D0D74562BFEF7EA`  
Repository baseline (5b audit): live `origin/main` at `e232626` (merged C85 / issue #259)  
Roadmap baseline: [Project 6 - Command Center v5.1](https://github.com/users/GHolmesDesigns/projects/6), 10 cards  
Prior report: `VERSION_5_FEASIBILITY_REPORT.md`

**Version 5.5 delta reviewed:** 2026-08-30  
**Version 5.5 source:** `C:\Users\garni\OneDrive\Desktop\Version 5.5.docx`  
**Version 5.5 modified:** 2026-08-30 09:43:47 -04:00  
**Version 5.5 SHA-256:** `d5f9cb5a4185fc2a9d7dfb04bbac2d3d83f7b646e0d70f9729f905d6a289923f`  
**Repository baseline (5.5 delta):** live `origin/main` at `ed8b211`, app version `5.9.4`  
**C136 post-implementation pass:** 2026-08-30, live `origin/main` at `ca046a8` (merged #421), app
version `5.9.5` — see [Post-implementation findings](#post-implementation-findings-c136-guided-credential-flow-595)  
The Version 5b strikethrough audit and Project 6 tables below are historical as of 2026-08-23. The
[Version 5.5 delta](#version-55-delta) appends a full assessment of the new Word document without
rewriting that audit.

## Scope and interpretation

The Word document is source material, not an instruction to implement anything. This report:

- treats a fully struck paragraph as a claim that the requirement is already covered;
- verifies that claim against merged issues and pull requests, not formatting alone;
- evaluates the unstruck paragraphs as requests to assess, not approved scope;
- checks whether Project 6 actually covers each request; and
- creates no issues, changes no project status, and implements no application behavior.

The source contains 52 paragraphs: 22 fully struck requirements and 21 unstruck requirement
paragraphs. The latter consolidate into 17 logical initiatives because the four Projects-view
paragraphs describe one feature family and the document asks for configurable default views twice.

## Executive assessment

Version 5b is feasible as a follow-on roadmap, but it is not one coherent implementation wave.
It combines three current publishing defects, several contained UI improvements, a Projects-view
expansion, provider lifecycle changes, and an undefined multi-agent integration.

The important conclusions are:

1. **Every struck requirement has merged evidence.** The 22 strikes are valid. None depends on an
   open Project 6 issue to make the claim true.
2. **Project 6 is narrower than the active list.** It covers the Buffer publishing chain and Signal
   import. It does not cover most of the remaining UI, navigation, Projects, favicon, Publish Now,
   MCP, or lifecycle-vocabulary requests.
3. **The three publishing defects need explicit reproduction.** C86 (#260) and C87 (#261) are not
   catch-all bug cards. A Post Bridge failure will not be fixed by adding Buffer, and a layout bug
   is not covered merely because C86 edits the same screen.
4. **Several active requests are already partly present.** View state is already URL-durable,
   delivery state is already separate from planning state, Threads already exists beside X, and
   scheduled provider posts can already be cancelled. The requested work is narrower than a fresh
   implementation, but its remaining semantics matter.
5. **Three requests should not become simple status values or buttons without a decision first:**
   deleting a published platform post, adding `Deleted` / `Outside of Signal`, and exposing MCP to
   multiple agents. Each crosses an existing ownership, audit, or security boundary.

Size guide used below:

- **XS:** a few focused hours
- **S:** up to two focused days
- **M:** roughly three to five focused days
- **L:** roughly one to two weeks
- **XL:** a program with multiple cards or an external architecture decision

These are planning ranges, not delivery commitments.

## Strikethrough audit

All 22 struck requirements map to closed issues with merged pull requests.

| Struck requirement | Merged evidence | Finding |
|---|---|---|
| Notes render on task cards | [#142 / C40](https://github.com/GHolmesDesigns/hybrid-command-center/issues/142), [PR #168](https://github.com/GHolmesDesigns/hybrid-command-center/pull/168) | Implemented |
| Settings columns flow independently | [#183 / C56](https://github.com/GHolmesDesigns/hybrid-command-center/issues/183), [PR #199](https://github.com/GHolmesDesigns/hybrid-command-center/pull/199) | Implemented without fixed cross-column alignment |
| `Dev Work` task type | [#135 / C33](https://github.com/GHolmesDesigns/hybrid-command-center/issues/135), [PR #153](https://github.com/GHolmesDesigns/hybrid-command-center/pull/153) | Implemented |
| Task-type filter on Status | [#136 / C34](https://github.com/GHolmesDesigns/hybrid-command-center/issues/136), [PR #155](https://github.com/GHolmesDesigns/hybrid-command-center/pull/155) | Implemented with URL state |
| Task details order: Checklist, Notes, Tags | [#137 / C35](https://github.com/GHolmesDesigns/hybrid-command-center/issues/137), [PR #154](https://github.com/GHolmesDesigns/hybrid-command-center/pull/154) | Implemented |
| Description label/box spacing | [#133 / C31](https://github.com/GHolmesDesigns/hybrid-command-center/issues/133), [PR #151](https://github.com/GHolmesDesigns/hybrid-command-center/pull/151) | Implemented |
| Download sample playbook | [#139 / C37](https://github.com/GHolmesDesigns/hybrid-command-center/issues/139), [PR #157](https://github.com/GHolmesDesigns/hybrid-command-center/pull/157) | Implemented from the canonical workbook |
| Remove Drive-card blank space | [#134 / C32](https://github.com/GHolmesDesigns/hybrid-command-center/issues/134), [PR #152](https://github.com/GHolmesDesigns/hybrid-command-center/pull/152) | Implemented |
| Contain and expand Signal calendar posts | [#140 / C38](https://github.com/GHolmesDesigns/hybrid-command-center/issues/140), [PR #158](https://github.com/GHolmesDesigns/hybrid-command-center/pull/158) | Implemented with a keyboard-reachable sibling control |
| Project link from Task details | [#138 / C36](https://github.com/GHolmesDesigns/hybrid-command-center/issues/138), [PR #156](https://github.com/GHolmesDesigns/hybrid-command-center/pull/156) | Implemented |
| `/kanban` becomes `/status` | [#141 / C39](https://github.com/GHolmesDesigns/hybrid-command-center/issues/141), [PR #161](https://github.com/GHolmesDesigns/hybrid-command-center/pull/161) | Implemented with redirect coverage |
| Project tile/button spacing is dynamic | [#184 / C57](https://github.com/GHolmesDesigns/hybrid-command-center/issues/184), [PR #200](https://github.com/GHolmesDesigns/hybrid-command-center/pull/200) | Implements both struck spacing paragraphs |
| Tasks draggable on the project page | [#144 / C42](https://github.com/GHolmesDesigns/hybrid-command-center/issues/144), [PR #170](https://github.com/GHolmesDesigns/hybrid-command-center/pull/170) | Implemented with persisted ordering |
| Project status has visible tile/chip treatment | [#143 / C41](https://github.com/GHolmesDesigns/hybrid-command-center/issues/143), [PR #169](https://github.com/GHolmesDesigns/hybrid-command-center/pull/169) | Implemented accessibly |
| Today / Week / Month on Calendar and Signal | [#145 / C43](https://github.com/GHolmesDesigns/hybrid-command-center/issues/145), [#146 / C44](https://github.com/GHolmesDesigns/hybrid-command-center/issues/146), [PR #171](https://github.com/GHolmesDesigns/hybrid-command-center/pull/171), [PR #172](https://github.com/GHolmesDesigns/hybrid-command-center/pull/172) | Implemented on both pages |
| Social Media Publisher incorporated into Signal | [#148 / C46](https://github.com/GHolmesDesigns/hybrid-command-center/issues/148), [#149 / C47](https://github.com/GHolmesDesigns/hybrid-command-center/issues/149), [#150 / C48](https://github.com/GHolmesDesigns/hybrid-command-center/issues/150) | Implemented for Post Bridge; the new unstruck Buffer route is separate |
| Live provider status for previously scheduled posts | [#192 / C65](https://github.com/GHolmesDesigns/hybrid-command-center/issues/192), [#193 / C66](https://github.com/GHolmesDesigns/hybrid-command-center/issues/193) | Planning and delivery states are separate; reconciliation is implemented |
| Accessible channel-specific visual tiles | [#185 / C58](https://github.com/GHolmesDesigns/hybrid-command-center/issues/185), [PR #201](https://github.com/GHolmesDesigns/hybrid-command-center/pull/201) | Implemented with initials/text, not color alone |
| Merge duplicate clients after import | [#173 / C49](https://github.com/GHolmesDesigns/hybrid-command-center/issues/173), [#198 / C71](https://github.com/GHolmesDesigns/hybrid-command-center/issues/198) | Implemented with preview, field choices, confirmation, and alias retargeting |
| Stable client import identity | [#197 / C70](https://github.com/GHolmesDesigns/hybrid-command-center/issues/197), [PR #213](https://github.com/GHolmesDesigns/hybrid-command-center/pull/213) | Implemented as source-qualified aliases rather than a fragile name key |
| Multi-select Status filters | [#187 / C60](https://github.com/GHolmesDesigns/hybrid-command-center/issues/187), [PR #203](https://github.com/GHolmesDesigns/hybrid-command-center/pull/203) | Implemented; OR within a dimension, AND across dimensions |

### Strikethrough conclusion

No struck item should be reopened solely because it is absent from Project 6. If any has regressed,
that is a new defect against merged behavior and should be reproduced as such.

## Project 6 coverage

Live Project 6 has ten cards.

| Card | Project status | What it covers here |
|---|---|---|
| [#257 / C83](https://github.com/GHolmesDesigns/hybrid-command-center/issues/257) | Done | Buffer contract, routing decision, guarded probe |
| [#258 / C84](https://github.com/GHolmesDesigns/hybrid-command-center/issues/258) | Done | Provider-neutral account and per-target remote identities |
| [#259 / C85](https://github.com/GHolmesDesigns/hybrid-command-center/issues/259) | Done | Buffer configuration, account refresh, and read-only adapter |
| [#260 / C86](https://github.com/GHolmesDesigns/hybrid-command-center/issues/260) | Todo | Buffer media rules, capabilities, provider-qualified preview |
| [#261 / C87](https://github.com/GHolmesDesigns/hybrid-command-center/issues/261) | Todo | Confirmed Buffer create/read/edit/cancel/reconcile |
| [#271 / C89](https://github.com/GHolmesDesigns/hybrid-command-center/issues/271) | Todo | Stable imported Signal-post identity |
| [#272 / C90](https://github.com/GHolmesDesigns/hybrid-command-center/issues/272) | Todo | Signal import preview, confirmation, transaction, receipt |
| [#273 / C91](https://github.com/GHolmesDesigns/hybrid-command-center/issues/273) | Todo | Read-only Drive metadata resolution during Signal import |
| [#274 / C92](https://github.com/GHolmesDesigns/hybrid-command-center/issues/274) | Todo | Import-time capability warnings |
| [#275 / C93](https://github.com/GHolmesDesigns/hybrid-command-center/issues/275) | Todo | Documentation of deliberately unbuilt Signal-import pieces |

Board hygiene findings:

- #259 is Done but still carries `blocked`; its label is stale.
- #260 depends on #257 and #259, which are Done, so its `blocked` label is also stale.
- #261 remains genuinely blocked on #260.
- #271-#275 are a Signal-import dependency chain. They do not cover the active Version 5b UI and
  lifecycle requests merely because they mention Signal, media, or capabilities.
- The live repository had no open pull request at review time. Local uncommitted work on the C86
  branch was deliberately excluded from the implemented baseline.

### Status since 2026-08-23 (Project 6)

As of the 2026-08-30 delta pass, the former Project 6 Todo cards above are **closed** on GitHub:

| Card | Closed | Notes |
|---|---|---|
| [#260 / C86](https://github.com/GHolmesDesigns/hybrid-command-center/issues/260) | 2026-08-24 | Buffer media and capability boundary |
| [#261 / C87](https://github.com/GHolmesDesigns/hybrid-command-center/issues/261) | 2026-08-24 | Confirmed Buffer publishing and reconciliation |
| [#271 / C89](https://github.com/GHolmesDesigns/hybrid-command-center/issues/271) | 2026-08-24 | Stable imported Signal-post identity |
| [#275 / C93](https://github.com/GHolmesDesigns/hybrid-command-center/issues/275) | 2026-08-25 | Deliberately unbuilt Signal-import documentation |

Sibling Signal-import cards in the same chain are also closed:
[#272 / C90](https://github.com/GHolmesDesigns/hybrid-command-center/issues/272),
[#273 / C91](https://github.com/GHolmesDesigns/hybrid-command-center/issues/273),
[#274 / C92](https://github.com/GHolmesDesigns/hybrid-command-center/issues/274)
(2026-08-24–25). Live Buffer production writes may still be gated by evidence flags
(`BUFFER_WRITE_EVIDENCE`); closed issues mean the *cards* shipped, not that every provider path is
enabled in production. The historical Todo table above is left unchanged on purpose.

## Feasibility of the active items

### Current publishing defects

| Active item | Feasibility / size | Project 6 coverage | Recommendation |
|---|---:|---|---|
| First **Show preview** click errors; retry works | High after reproduction / S | Partial overlap with #260, but not stated | Capture the first failing request, provider, response, and state transition. Add an explicit regression acceptance criterion to #260 only if the failure is in the Buffer plan/account refresh. Otherwise file a separate Post Bridge defect. Do not assume a retry proves safety. |
| Account-selection boxes do not align with account names | High / XS-S | Same screen as #260, not explicit scope | Safe to fold into #260 if its branch already owns the account selector, but add a named responsive and keyboard acceptance check. File separately if the defect exists on live C85 independent of C86. |
| Error on **Confirm and submit** | High after reproduction / S-M | #261 covers the future Buffer confirmation path only | Split by provider. A current Post Bridge submit failure is a regression against C48 and needs its own fix. A Buffer failure belongs to #261 only after C86 has made the plan valid. Preserve ambiguous-write refusal; never fix this with an automatic retry. |

The three defects should be reproduced before estimating delivery. Their messages and request paths
are more useful than screenshots of the final warning state.

### Contained UI and navigation work

| Active item | Feasibility / size | Current-state finding | Recommendation |
|---|---:|---|---|
| Show provider-verified / ready status on the Signal calendar tile | High / M | Delivery state exists in the editor, while the tile shows only planning status | Add a batch/local summary to the planner read; do not make one provider call per tile or refresh on page load. Show planning and delivery as two separately named indicators. |
| Project-aware breadcrumbs when Status is opened from a project | High / S-M | `/status?project=<id>` is a top-level route, so the pathname-only breadcrumb table cannot see project context | Make breadcrumbs query-aware for this route: Command Center -> Projects -> project -> Status. Preserve the project filter in the current crumb and test stale/unknown project ids. |
| Hide archived clients from the client filter while viewing Live Projects | High / XS-S | `Projects.tsx` currently renders every client in the select regardless of `visibility` | Filter client choices by the selected project visibility. Define what happens when a URL names an archived client while `visibility=live`; recommendation: clear the invalid filter rather than keep a hidden selection. |
| Browser-tab icon | High / XS for a bundled favicon; M for runtime customization | `client/index.html` has no favicon link | A bundled SVG/ICO needs no storage feature. Treat a user-editable favicon as a different card because browser caching, validation, and the existing HTTPS-only branding model apply. |
| Add-post entry points: day-cell plus, **Add Post** label, and top navigation action | High / M as one card | Signal owns its editor state; the top bar currently owns only New Task | Use one query-addressable creation flow, e.g. `/signal?new=1&date=YYYY-MM-DD`, so all entry points open the same form. The day-cell action pre-fills the local date; the top action opens an unscheduled post. Avoid a second global modal implementation. |

### Views and defaults

| Active item | Feasibility / size | Current-state finding | Recommendation |
|---|---:|---|---|
| Configurable default view and sort behavior | High / M-L | C59 already defines URL-durable view state and canonical defaults; it does not add user settings | Store defaults only for the absence of an explicit URL value. URL state must always win so shared links remain deterministic. Add Reset to defaults and document every page that consumes the setting. |
| Projects list view and planning-status filters | High / M-L | Projects has tiles, live/archived/all visibility, client/category filters, seven sorts, and custom tile order; no list mode or active/planning status multi-filter | Treat list/grid as presentation over one result set. Keep `visibility` for archived scope and use a separate multi-value status parameter for live planning statuses. Decide whether Custom order is available in list mode before implementation. |

These two items should share the existing `docs/view-state-convention.md` contract rather than add a
Settings-only state model that competes with URLs.

### Media and provider routing

| Active item | Feasibility / size | Project 6 coverage | Recommendation |
|---|---:|---|---|
| Actual media preview on scheduled posts | Partial / M for public URLs; not feasible for private Drive bytes under the current boundary | #260 builds Buffer payload/media preflight, not image rendering | After a person presses Show preview, the browser may render positively classified public HTTPS images/videos. Do not have the server fetch arbitrary URLs. A Drive viewer URL is HTML and must not be embedded; previewing private Drive bytes would require a separately approved read/stream boundary. Warn that loading a remote preview discloses the viewer's IP to that host. |
| Replace X with Threads; route TikTok and YouTube through Buffer | Feasible / M plus #260/#261 | Threads was added by #246; X still remains. Buffer routing is covered by #260/#261 | Do not silently translate historical X rows into Threads. Decide whether X becomes historical/read-only, remains supported, or is removed after an explicit migration. #260 and #261 can complete the TikTok/YouTube route; the X retirement needs its own card. Use the repository's `youtube` channel name unless a separate Shorts content model is introduced. |

### Provider lifecycle and workflow

| Active item | Feasibility / size | Boundary / coverage | Recommendation |
|---|---:|---|---|
| **Publish Now** | Conditional / L | Not in #261, which creates at an exact scheduled instant | Probe and record the exact immediate-publish contract for each provider before enabling it. Make it a separate, irreversible confirmation with the provider/account/media shown. No fallback and no automatic retry after ambiguity. |
| Delete published posts | Ambiguous; scheduled cancellation already exists | Post Bridge deletion is verified only for scheduled/draft posts; #261 cancels Buffer only where Buffer permits it | First decide whether this means cancelling a scheduled provider post, deleting the local Signal plan, or removing already-live platform content. The first is already supported for Post Bridge; the second is constrained by publication history; the third is unsupported until each provider and platform proves an unpublish/delete capability. |
| Add `Deleted` and `Outside of Signal` options | Feasible only after vocabulary decision / M | Signal planning status intentionally has exactly Draft, Scheduled, Published; delivery is separate | Do not add both as planning statuses. `Deleted` is a lifecycle/audit outcome, while `Outside of Signal` is provenance. Model them separately if the use cases survive review, and preserve the existing meaning of historical rows. |
| Reduce Show preview -> Confirm -> Refresh delivery steps | Partially feasible / S-M after #261 | #261 preserves preview and stale-plan confirmation by design | Keep preview and confirmation. Safe streamlining is to refresh/reconcile automatically after a clearly answered submit and show the result in the same panel. Do not automatically resend or refresh through an ambiguous response, and do not remove the stale-preview check. |

### Multiple-agent MCP connection

Feasibility is **undetermined / L-XL** because the request does not yet name the capability.

Three materially different products fit the phrase:

1. a local stdio MCP server exposing selected Command Center reads/writes to agents on this machine;
2. a network MCP service used by several authenticated agents; or
3. coordination metadata so agents claim development issues without editing application data.

The second cannot safely ship on the current unauthenticated loopback application. It depends on the
authentication and hosting program (#176-#181) or on a separately secured local broker. Before a card
is written, define the resource/tool surface, read versus write methods, identity per agent,
authorization, confirmations, idempotency, audit events, and whether agents can trigger provider writes.
Provider publishing must remain human-confirmed unless a later security decision explicitly changes it.

## Coverage gaps that need cards or scope amendments

Project 6 does not currently contain explicit coverage for:

- the three observed publishing defects;
- delivery status on Signal calendar tiles;
- project-aware Status breadcrumbs;
- archived-client filtering on Live Projects;
- favicon support;
- Signal add-post entry points;
- user-configurable default views;
- Projects list view and live-status filters;
- retirement of X;
- Publish Now;
- multi-agent MCP access;
- already-published remote deletion;
- Deleted / Outside-of-Signal semantics; or
- safe post-submit auto-reconciliation.

The media-preview request is adjacent to #260 but is not one of its acceptance criteria. It should
not be marked covered without adding the public-preview privacy and Drive refusal boundaries.

## Recommended sequence

### Wave A - Stabilize the current publishing flow

1. Reproduce the first-preview and confirm-submit errors against the provider actually used.
2. Fix current Post Bridge regressions separately from new Buffer work.
3. Add the account-alignment acceptance check to #260 if the same UI is already being changed.

### Wave B - Finish Project 6 Buffer publishing

1. C86 (#260): provider capabilities, public URL media rules, mixed-provider refusal/split decision.
2. C87 (#261): confirmed Buffer writes, partial outcomes, reconciliation, edit, and cancellation.
3. Only after C87: safe automatic reconciliation after an answered submit.

### Wave C - Contained Version 5b usability

1. Archived-client filter correction.
2. Project-aware Status breadcrumbs.
3. Bundled favicon.
4. Unified Add Post entry points.
5. Local, batch-derived delivery status on Signal tiles.

### Wave D - Views and defaults

1. Projects list/grid decision and project-status filter semantics.
2. Shared settings-backed defaults that yield to explicit URL state.

### Wave E - Decision-gated provider and agent work

1. X retirement policy.
2. Public media preview privacy and Drive boundary.
3. Publish Now provider evidence and confirmation model.
4. Published-content deletion definition and provider feasibility.
5. Deleted / Outside-of-Signal data model.
6. MCP audience, trust boundary, and tool surface.

Signal import (#271-#275) can proceed on its own dependency chain after its prerequisites. It should
not be used as a container for these unrelated Version 5b requests.

## Decisions required before implementation cards are written

1. Which provider and request fail on the first preview and on Confirm and submit?
2. Should a stale archived-client URL filter be cleared or automatically switch Projects visibility?
3. Is favicon support a bundled app icon or a user-editable branding setting?
4. Should Projects list mode support custom drag order?
5. Which live project statuses belong in the Projects filter?
6. Does X remain readable for history after new X selection is disabled?
7. Does media preview cover only public URL media, or is a new private Drive-byte capability desired?
8. What exactly does “delete a published post” delete: provider schedule, local plan, or live platform content?
9. What user question does `Outside of Signal` answer: provenance, manual delivery, or planning state?
10. Is MCP local-only, networked, or development-coordination-only, and which methods may write?

## Version 5.5 delta

Reviewed against `Version 5.5.docx` on 2026-08-30. This section does not reopen the Version 5b
strikethrough audit. It assesses the new document as a follow-on backlog and records where that
backlog **drops**, **rewrites**, or **reverses** earlier Version 5b requests.

### Scope and interpretation (5.5)

- The document has **65 paragraphs**: 62 active, 0 fully struck, 0 partial strike, 3 empty.
- There is **no strikethrough evidence**. Nothing in 5.5 is treated as “already done” from formatting.
- Headings are Bugs, Paper cuts, and Feature requests. Agent-reported MCP “import headaches” are
  included as operator evidence, including the document’s own “by design” boundary notes.
- Same planning size guide (XS–XL) as above. Same rule: this report creates no issues and
  implements no application behavior.
- Repository baseline for this delta: `origin/main` at `ed8b211`, app version **5.9.4**. Recent tip
  commit removes the stdio MCP server and standardizes on the production HTTPS endpoint — important
  for credential UX and Drive-connection diagnosis.

### Executive assessment (5.5)

Version 5.5 is a **mostly new** roadmap, not a polish pass on Version 5b. It is feasible as sequenced
work, but it mixes quick UI fixes, an operator-blocking MCP credential problem, product reversals
(planning status, calendar editability, TikTok/YouTube routing), and several XL boundary programs
(Drive writes, Wix blog, Buffer Drive video, multi-user).

The important conclusions are:

1. **Operator priority: guided MCP key issue and rotate.** The current Settings flow still ends in
   copy-ready JSON/TOML and client-side paste. For a non-technical operator that can take hours.
   Version 5.5 asks for an Agents-module field instead of PowerShell and hand-edited files. A guided
   in-app flow (issue → one-time reveal → client-specific copy steps → health confirm → rotate) is
   **high / M** and belongs in Wave A.
2. **Most Version 5b active items are absent from 5.5.** Publishing preview/submit defects, favicon,
   Add Post entry points, Publish Now, X→Threads, Deleted / Outside of Signal, and generic
   multi-agent MCP do not reappear. Do not invent cards for them solely because the 5b section still
   discusses them.
3. **TikTok / YouTube routing is reversed.** Version 5b routed them through Buffer; Version 5.5 says
   they now live on the Post Bridge account and asks to rewire Signal. Code on `main` still lists
   `tt` / `yt` in `BUFFER_ROUTE_CHANNELS` (`shared/buffer.ts`). That needs an evidence-backed decision
   before any card assumes either provider.
4. **Two requests conflict with deliberate architecture.** Auto-setting planning status to Published
   after a successful check, and opening the Signal editor from Calendar, both cross C65/C66 and the
   read-only calendar composition. Feasible only after an explicit product decision.
5. **Drive writes conflict with the doc’s own “by design” MCP walls.** Item “write ability to Drive
   Folders” asks for the capability that paragraphs 58–60 say should stay walled off. Treat Drive
   write as a separately approved module — never as a silent widening of Files or MCP browse.

### Crosswalk: Version 5b active items → Version 5.5

| Version 5b active item | In 5.5? | Notes |
|---|---|---|
| First Show preview error | Absent | Historical 5b defect only |
| Account-selection alignment | Absent | Historical 5b defect only |
| Confirm and submit error | Absent | Historical 5b defect only |
| Delivery status on Signal calendar tiles | Absent | Not restated |
| Project-aware Status breadcrumbs | Absent | Not restated |
| Hide archived clients on Live Projects | Absent | Not restated |
| Browser-tab favicon | Absent | Not restated |
| Add Post entry points | Absent | Not restated |
| Configurable default views / sort | Reworded | Narrowed to Grid/List in Default view settings |
| Projects list view + status filters | Partial | Grid/List defaults only; live-status multi-filter not restated |
| Media preview spike | Absent | Not restated |
| Replace X with Threads; Buffer for TikTok/YouTube | **Policy reversed** | 5.5: TikTok/YouTube on Post Bridge; rewire Signal |
| Publish Now | Absent | Not restated |
| Delete published posts | Absent | Not restated |
| Deleted / Outside of Signal | Absent | Not restated |
| Reduce preview → confirm → refresh steps | Reworded | “When the check comes back success, status should automatically update to Published” |
| Multi-agent MCP | Reworded / narrowed | Credential rotation UX + Agents nav + MCP shape quirks; not a vague multi-agent spike |

### Operator priority: guided MCP key issue and rotate

**Request (5.5):** improve Agent Credential rotation; put it on the Agents module, not PowerShell and
editing JSON files. Operator feedback during this review: the current process is too technical and
can take hours for a non-technical person.

**Current state (5.9.4):**

- Issue, revoke, copy config, and health test live in Settings via `McpConnectionSetupCard`
  (`client/src/components/McpConnectionSetupCard.tsx`).
- `buildMcpClientConfig` in `shared/mcp-client-config.ts` still emits JSON/TOML (or equivalent)
  snippets; the operator must paste them into Cursor, Claude, or another client.
- There is no top-level Agents nav. Connection setup, connection health, and Agent Handoffs sit among
  Settings cards (`client/src/components/App.tsx` nav order ends at Settings).
- `origin/main` at `ed8b211` removes the stdio MCP server and standardizes on the production HTTPS
  endpoint, which should simplify the guided path (one transport story) but makes a clear HTTPS
  credential flow mandatory.

**Target UX to assess (chosen for this delta):** an **in-app guided flow** that covers issue / rotate /
revoke, shows the secret once, and gives **client-specific next steps with a single copy/paste** —
**no PowerShell and no hand-editing JSON/TOML**. One-click writing of client config files on disk is
a later option only, not required for this card.

**Feasibility:** High / **M**.

**Recommendation:**

1. Promote an **Agents** surface (top-level nav group or dedicated page) that owns Connection Setup,
   Connection health, and Agent Handoffs together.
2. Replace “generate config blob → find the right file → paste” with numbered steps per client
   (Cursor, Claude, …): where to open settings, what to click, and one copy control for the value
   that client needs.
3. Keep one-time secret reveal, revoke, and reissue. After rotate, the health diagnostic must prove
   the new credential works before the operator leaves the page.
4. Acceptance criterion: a non-technical operator completes issue or rotate **without opening a text
   editor or terminal**.
5. Do not widen MCP write boundaries as part of this card. Credential UX is authentication and
   onboarding, not Drive writes or provider publish.

**Status:** shipped as C136 in `5.9.5` (PR #421, merged `ca046a8`). Recommendations 1–3 landed: an
Agents page owns the three cards, `buildMcpClientGuide` emits numbered client-specific steps with
copy controls, and one-time reveal plus in-app Rotate exist. Recommendation 4 — the acceptance
criterion — is **not met on every client**; see below.

### Post-implementation findings: C136 guided credential flow (5.9.5)

Defects found by inspecting the shipped code at `ca046a8`, and by an operator connecting Claude
Desktop through this flow on 2026-08-30. Ordered most severe first. None of these were knowable at
the `ed8b211` baseline the 5.5 delta was written against.

| # | Finding | Feasibility / size | Current-state evidence | Recommendation |
|---|---|---:|---|---|
| C136-1 | **Rotate is non-atomic and has no rollback.** `rotateFor` POSTs revoke, then separately POSTs a new credential. If the second call fails, the label is left with no working credential and the UI offers no recovery — the operator must notice and re-issue by hand | High / S | `McpConnectionSetupCard.tsx:132-137` — `send(.../revoke)` then `send('/auth/mcp-agents', 'POST')`, no try/rollback around the pair | Make rotate a single server-side operation that issues before revoking, or catch the issue failure and surface an explicit "old key revoked, re-issue required" state |
| C136-2 | **Rotate silently changes the credential lifetime.** Expiry is computed from the step-1 form dropdown, not from the credential being rotated. Rotating a 90-day credential while the selector sits at its 30-day default issues a 30-day one, with no indication. Scopes are carried over correctly; expiry is not | High / XS | `:136` `credentialExpiryIso(days, …)` where `days` is component state from `:60` (`useState(30)`); contrast `:135` which correctly reuses `credential.scopes` | Carry the original lifetime, or show the expiry the rotate will apply in the confirm dialog |
| C136-3 | **The HTTPS "ready-to-paste setup" is not pasteable as a config file.** It emits a bare `{url, headers}` fragment with no `mcpServers` wrapper and no server name, yet is named `<platform>-mcp-http.json`. The stdio builders emit complete documents; the HTTP path does not. Pasting it where the filename implies produces malformed config | High / S | `shared/mcp-client-config.ts:110-116` (payload) vs `:52-66` / `:69-84` (stdio emit full `mcpServers` documents with real filenames) | Emit a complete, named `mcpServers` entry for HTTP too, or rename the copy control so it does not read as a file body |
| C136-4 | **No Claude Desktop or claude.ai option; Claude Code steps are shown instead.** Platforms are `cursor \| claude \| codex`, and the `claude` steps say "In Claude Code, open MCP / connector settings for this project." An operator in Claude Desktop, claude.ai chat, or Cowork follows instructions that do not match their UI — those surfaces use connector settings, not per-project MCP config. This is what broke recommendation 4's acceptance criterion in practice | High / M | `shared/mcp-client-config.ts:9` platform union; `:170` label `'Claude Code'`; `shared/mcp-client-guide.ts` `STEPS.claude` | Add a Claude Desktop / claude.ai connector platform with its own steps, or relabel and reword so the distinction is explicit |
| C136-5 | **The emitted config includes `x-agent-label`, which can only be a no-op or a hard error.** The label is authoritative from the credential; the server throws when the header disagrees with it. Including the header adds a failure mode and no capability. The known-good production config omits it | High / XS | `shared/mcp-client-config.ts:114` emits the header; `server/mcp/http.ts:199-204` throws `x-agent-label does not match the credential identity` on mismatch | Drop the header from the emitted HTTP config; keep `MCP_GUIDE_HEADER_HINT` as documentation only |

**Operator-observed impact.** C136-3 and C136-4 together sent a non-technical operator to Claude
Desktop's Developer → Edit config (`claude_desktop_config.json`, a local-stdio file) with a fragment
that belongs in connector settings. The credential also reached the config without its `Bearer `
prefix, which the server rejects as HTTP 401 and the client surfaces as "server unreachable." Time
to a working connection was well beyond the "no text editor, no terminal" bar in recommendation 4.

### Full-repository sweep (5.9.5)

A broader pass over the codebase at `ca046a8`, beyond the C136 credential flow: HTTP hardening, auth
and session handling, the coordination and workspace read paths, the Signal/provider surface, the
import paths, and process lifecycle. Scale at time of review: ~67k lines of non-test TypeScript
(server 35.7k, client 16.7k, shared 9.3k, e2e 5.2k) across 343 test files.

This is an inspection pass, not an audit with executed exploits. Findings below were read directly in
the code; none were reproduced against a running instance except where noted.

#### Findings

| # | Area | Finding | Feasibility / size | Evidence | Recommendation |
|---|---|---|---|---:|---|
| SW-1 | Scalability | **`workspace_list_tasks` paginates after doing all the work.** `limit`/`offset` are applied with `Array.slice` *after* the full result set is fetched and hydrated. `hydrateTask` issues four queries per task — tags, checklist, dependencies, blocking dependencies — so `listTasks` costs `1 + 4N` queries regardless of page size. A `limit: 1` request against 500 tasks runs ~2,000 queries and builds 500 objects to return one. The API looks paginated; the database work is not | High / M | `server/mcp/workspace-read.ts:109-110` (`listTasks(...)` then `.slice(offset, offset + limit)`); `server/repositories.ts:105-137` (`hydrateTask`), `:149-157` (`listTasks`), `server/domain/dependencies.ts:20-27` | Push `LIMIT`/`OFFSET` into the SQL, and batch-hydrate the page with one query per relation (`WHERE task_id IN (…)`) instead of four per row. Same slice-after-compute shape at `workspace-read.ts:61-64` (dashboard buckets) and `:163` (queue) |
| SW-2 | Scalability | **`coordination_list_handoffs` is unbounded.** No `LIMIT`, no pagination; the tool exposes only `state`. `state=COMPLETED` returns the entire history with full messages, notes, and validations in one response. Contrast `workspace_list_tasks`, which at least accepts `limit` (max 100) and `offset` | High / S | `server/agent-coordination/service.ts:190-206` | Add `limit`/`offset`, default to a recent window, and return a `truncated` flag as the workspace reader does |
| SW-3 | Security | **Bootstrap bearers can assume any agent label.** Scoped credentials reject a mismatched `x-agent-label`, but an operator bearer resolves to `operatorBootstrapCredential(...)` and that branch accepts the header verbatim. Anyone holding an operator bearer can post, claim, note, and complete as any label. Not privilege escalation — an operator bearer is already privileged — but `fromAgentLabel`, `claimedBy`, and note authorship stop being verifiable, which matters because the board is the evidence half of claim → work → prove | Moderate / M | `server/mcp/http.ts:191-197` (bootstrap branch) vs `:199-204` (scoped mismatch throws); `server/auth/mcp-agent-credentials.ts:50-60` | Bind bootstrap bearers to a fixed label, or flag bootstrap-authored coordination rows so the UI can separate asserted from verified identity |
| SW-4 | Availability | **No process-level error handlers.** No `unhandledRejection` or `uncaughtException` listener anywhere in `server/`. Node terminates the process on an unhandled rejection by default, so a single missed `.catch()` in a background path takes the service down with no logged cause. There is also no graceful shutdown for in-flight MCP HTTP sessions or the SQLite handle | Moderate / S | absence across `server/**` (`server/index.ts`, `server/app.ts`) | Add handlers that log and exit deliberately, plus a SIGTERM path that drains MCP sessions and closes the database |
| SW-5 | Security / ops | **Rotating the session secret invalidates every agent credential at once.** Credential lookup is by `HMAC-SHA256(sessionSecret, token)`; change the secret and no stored hash matches. Every agent 401s simultaneously, and the client-side symptom is "server unreachable" rather than an auth error | Moderate / XS | `server/auth/mcp-bearers.ts:48-50`; `server/auth/mcp-agent-credentials.ts:159-162` | Document as an operational constraint, or derive the credential key from a dedicated secret with its own rotation story |
| SW-6 | Scalability | **Two writes on every authenticated MCP request.** Each resolve updates `last_used_at` on both the credential and the registration inside a transaction, including for read-only calls like `system_connection_status`. WAL and a 5s busy timeout make this survivable; it is still a write lock per request | Low / S | `server/auth/mcp-agent-credentials.ts:163-171`; mitigations at `server/db.ts:1456` | Debounce the touch (skip when `last_used_at` is within N seconds) or move it off the request path |
| SW-7 | Usability | **"Reserved" scopes are grantable.** The Agents UI labels `workspace:read` / `workspace:write` reserved and omits them from defaults, but the checkboxes still issue them — credentials in the wild carry all four | Low / XS | `McpConnectionSetupCard.tsx:38-47`; `MCP_AGENT_SCOPES` | Disable the reserved checkboxes until the scopes are enforced, or drop the "reserved" label |
| SW-8 | Usability | **A live connection cannot be traced to a credential.** The Agents list shows label, scopes, `lastUsedAt`, `lastOrigin` — so two credentials on one label are indistinguishable, and "is this old key still live?" is unanswerable from the UI | Low / S | `McpConnectionSetupCard.tsx:370-400`; `McpAgentCredentialSummary` | Surface a credential fingerprint (first bytes of the hash) in both the list and `system_connection_status` |

#### Verified sound — recorded so later reviews do not re-open them

- **The publish and Drive boundary is enforced and negatively tested.** `signal_publish_now` and
  `signal_publish_submit` exist only in `server/mcp/registry.test.ts` and
  `workspace-write-matrix.test.ts` as assertions that they are *not* registered. The MCP registry
  exposes `signal_publish_preview` (read) and `signal_update_publish_targets` (config) and no publish
  path. This is the single most important invariant in `docs/mcp-agent-workflow.md`, and it holds.
- **No injection or dangerous-sink exposure.** No `dangerouslySetInnerHTML`, `innerHTML =`, `eval`,
  or `new Function` in the client. Every SQL template interpolation is a constant table name or a
  generated placeholder list — no user input reaches SQL as text.
- **HTTP hardening is in place.** `helmet` with a production CSP, CORS pinned to `config.appOrigin`
  with credentials, `HttpOnly` + `SameSite=Lax` + `Path=/` cookies with `Secure` under TLS, a 1 MB
  default body limit, and rate/concurrency budgets deliberately mounted *ahead* of the body parsers
  with the rationale documented in place (`server/app.ts:613-663`).
- **Credential handling is correct.** 32 random bytes, prefix-gated, stored as HMAC-SHA256 keyed by
  the session secret; revocation and expiry are both enforced on every resolve, and the listing
  filters revoked and expired rows.
- **Bounded MCP session growth.** The HTTP session registry prunes by TTL and evicts oldest-touched
  past `MCP_HTTP_SESSION_MAX` (`server/mcp/http-sessions.ts:127-140`).
- **Storage fundamentals.** WAL journal mode with a 5s busy timeout; 38 indices across 50 tables;
  backup, restore, offsite, rehearsal, and cutover scripts all present in `package.json`.
- **No latent debt markers.** Zero genuine `TODO` / `FIXME` / `HACK` / `XXX` comments in
  `server/`, `client/src/`, or `shared/` — all ten textual matches are the `TODO` task *status*.

#### Sweep priority

SW-1 and SW-2 are the two that degrade silently: both are invisible at four clients and a
single-digit board, and both worsen with exactly the growth this product is for. SW-3 is the one to
fix before the coordination board is treated as an audit trail. SW-4 is cheap and prevents a class of
silent outage. The rest are contained.

### Bugs (5.5)

| Active item | Feasibility / size | Current-state finding | Recommendation |
|---|---:|---|---|
| Status drag-and-drop into empty columns fails; field selector works | High / S | Columns and “Drop tasks here” exist (`KanbanCards.tsx` / `Kanban.tsx`); empty `SortableContext` + `closestCorners` is the classic miss | Fix empty-column droppable hit area; add a regression test that drops into an empty status |
| Line up fields with radio buttons on merge modal | High / XS | Merge modal shipped (C49/C71); `.merge-choice` uses baseline alignment | CSS/layout polish only; preserve keyboard and field-choice semantics |

This table covers bugs listed in `Version 5.5.docx`. Five further defects found in shipped C136 code
after that document was written are tracked separately in
[Post-implementation findings](#post-implementation-findings-c136-guided-credential-flow-595); C136-1
and C136-2 are correctness bugs in rotate and belong in the same wave as the rows above.

### Paper cuts (5.5)

| Active item | Feasibility / size | Current-state finding | Recommendation |
|---|---:|---|---|
| Add padding below Picker button | High / XS | Google Picker control in Settings Drive card | One spacing rule under the Picker control |

### Feature requests (5.5)

| Active item | Feasibility / size | Current-state finding | Recommendation |
|---|---:|---|---|
| Rewire TikTok/YouTube to Post Bridge | Conditional / L | `BUFFER_ROUTE_CHANNELS` still owns `tt` / `yt` | Probe account evidence first. If Post Bridge now holds them, reverse the Buffer route with migration and mixed-provider refusal rules. Do not silently dual-route. |
| Per-client branding (logo, color 1, color 2) | Feasible / L | Sidebar branding only; `clients` has no branding columns | Reuse `shared/branding.ts` contrast rules per client; HTTPS logo only; no local file store |
| Client branding cues on Signal | Feasible after association / M-L | Signal posts have no `client_id`; campaigns have color only | Decide how a post binds to a client (project? campaign? explicit field) before painting logos on tiles |
| Calendar click opens Signal Campaign modal | Decision-gated / M | Calendar is deliberately read-only; tasks link, posts do not | Prefer deep-link to `/signal` with the post selected, or host the editor only after accepting that Calendar becomes an edit entry point |
| Auto-update status to Published after successful check | Decision-gated / M | Planning vs delivery are separate (C65/C66); auto-reconcile of delivery already exists | Do not mutate planning status without an explicit reversal. Safer: surface delivery success in the same panel |
| Reorder sidebar (Dashboard… Agents… Settings) | High / S | Current order: Dashboard, Clients, Projects, Status, Import, Files, Calendar, Signal, Settings — no Agents | Implement with the MCP credential card; Agents owns setup/health/handoffs |
| Reorder Settings columns | High / XS-S | Cards exist; left currently leads with Drive and agent cards | Left: categories, tags. Right: defaults, branding, Drive, timezones, calendar, campaigns. Move agent cards to Agents |
| Guided MCP credential rotation on Agents | High / M | See [Operator priority](#operator-priority-guided-mcp-key-issue-and-rotate); card [C136 / #420](https://github.com/GHolmesDesigns/hybrid-command-center/issues/420) | Wave A; non-technical acceptance criterion |
| Logo click → gholmesdesigns.com | High / XS | `BrandMark` is not a link | External link with visible new-tab affordance; keep contrast rules |
| Signal import sample file; stack buttons in a quadrant | High / S | Sample workbook exists at `docs/examples/signal-import-format.xlsx`; UI has playbook sample, not Signal sample; buttons wrap in a row | Serve/download the Signal sample; quadrant layout for the two import actions |
| Link to current version’s user manual | High / XS | Manual is version-gated in repo; README links it; no in-app link | Settings or Help link to the version-matched manual HTML |
| Import page layout: helper full width; two equal scroll receipt columns | High / S | Helper left, receipts right; no column max-height scroll | Match the requested grid; keep receipts scoped to this run |
| Write ability to Drive folders (operator and agents) | Ambiguous / XL | Files and MCP browse are read-only by design; provisioning exists | Requires a new confirmed write module, AGENTS.md + manual change, and MCP policy decision. Conflicts with 5.5’s own “by design” walls |
| Grid and List in Default view settings | High / S | Projects grid/list is URL-durable; Settings defaults omit presentation | Store under view defaults; URL still wins when present |
| Plan a Reports modal (basic DB queries v1) | Feasible / M-L plan-first | No `/reports` route | Plan read-only SQLite aggregates only; no provider calls; separate card after the plan |
| Debug logging | Partial / S-M | `pino` + `LOG_LEVEL` including debug/trace | Decide operator-facing panel vs documented server env; do not log secrets |
| Add multi-user to the roadmap | Docs / S | Explicitly out of scope in cloud-hosting docs | Roadmap note only for this horizon |
| Username, password, forgot password, show-password eye | Partial / M | Password session shipped (C50+); login is password-only | Username/forgot/eye are UX cards; keep single-operator auth unless multi-user is approved |
| Add scalability to the roadmap | Docs / S | Hosting docs exist | Roadmap note only |
| Wix blog scheduling via MCP/Signal | Undetermined / XL | `blog` channel exists with null publish capabilities | New provider program; human-confirmed publish; not an MCP write by default |
| Improve Buffer video from Drive (no silent conversion fail) | Conditional / L | Buffer refuses Drive media by design today | Needs an approved byte/transcode path or a provider-native upload; refuse silent conversion |
| MCP Drive NOT_CONNECTED while browser Drive CONNECTED | High after diagnosis / S | Same SQLite token store when the same DB is used; stdio-local vs HTTPS-prod were different stores | With HTTPS-standardized MCP, document `storeId` / which server the agent hits; reconnect Drive on that store. Not a second OAuth by design |
| `signal_list_posts` lacks projectId/campaign filters | Feasible / S | Args are date range + optional lifecycle only | Add optional filters; keep date window semantics |
| `signal_resolve_drive_media` folder batch | Feasible / M after approval | One file link; folders refused | Explicit batch card; do not sneak folder resolve into the single-file tool |
| MCP “by design” walls (no Drive write, no provider publish, no hard client delete) | Confirm | Matches AGENTS.md and approval boundaries | Do **not** file enhancement cards that erase these without a security decision. Note conflict with Drive-write request above |
| `import_signal_commit` needs human go-ahead on preview | Confirm | Working-method rule, not a missing tool | Keep preview → confirm; no silent agent commit |

### Coverage gaps that need cards or scope amendments (5.5)

No current milestone card explicitly covers:

- guided MCP key issue/rotate on an Agents surface (operator priority);
- empty-column Status drag-and-drop;
- merge-modal field/radio alignment;
- Picker padding;
- sidebar Agents group and Settings column reorder;
- logo → gholmesdesigns.com;
- in-app user-manual link;
- Signal import sample download and Import quadrant/layout;
- Grid/List in Default view settings;
- MCP `signal_list_posts` campaign/project filters;
- clarifying MCP vs web Drive store diagnosis in-product;

Decision-gated or program-sized (do not quietly fold into adjacent cards):

- Post Bridge rewire of TikTok/YouTube;
- per-client branding and Signal cues;
- Calendar → Signal editor;
- auto Published planning status;
- Drive folder writes;
- Reports v1;
- debug logging productization;
- auth username / forgot / eye;
- Wix blog publish;
- Buffer Drive video path;
- folder-batch Drive media resolve;
- multi-user and scalability (roadmap docs only unless approved otherwise).

### Recommended sequence (5.5)

#### Wave A — Stabilize operator access and obvious defects

1. **Guided MCP key issue/rotate** on an Agents surface (non-technical acceptance) —
   tracked as [C136 / #420](https://github.com/GHolmesDesigns/hybrid-command-center/issues/420).
2. Agents nav + Connection health + Handoffs placement beside that flow.
3. MCP vs web Drive connection diagnosis (`storeId`, which base URL the agent uses).
4. Empty-column Status drag-and-drop.
5. Merge-modal alignment and Picker padding.

#### Wave B — Contained Version 5.5 usability

1. Settings column reorder after Agents leave Settings.
2. Logo external link and in-app user-manual link.
3. Import layout, Signal sample download, quadrant actions.
4. Grid/List in Default view settings.
5. `signal_list_posts` optional project/campaign filters.

#### Wave C — Product decisions before coding

1. TikTok/YouTube provider ownership (Post Bridge vs Buffer evidence).
2. Client branding model and Signal association rule.
3. Calendar deep-link vs in-calendar Signal editor.
4. Whether “Published” means planning status, delivery, or both.
5. Folder-batch Drive media: approve or keep one-file.

#### Wave D — Boundary programs and roadmap-only items

1. Drive write module (only if approved against the doc’s own walls).
2. Reports v1 plan, then implementation.
3. Debug logging operator story.
4. Auth username / forgot / show-password eye.
5. Wix blog provider program.
6. Buffer Drive video without silent conversion failure.
7. Multi-user and scalability as **roadmap documentation**, not this milestone’s build.

### Decisions required before Version 5.5 implementation cards are written

1. Confirm guided in-app MCP issue/rotate with client-specific copy steps (no PowerShell/JSON editing); defer one-click filesystem install?
2. Are Agents a top-level nav group that owns credential setup, or only a Settings reorder?
3. Does TikTok/YouTube move to Post Bridge, stay on Buffer, or split by live account evidence?
4. Does “status → Published” mean planning status, delivery summary, or both?
5. Is Drive write a new confirmed module (operator UI ± MCP), or out of scope despite the request?
6. How does a Signal post bind to a client for branding cues?
7. Should Calendar remain read-only with a deep link to `/signal`, or host the editor modal?
8. Is folder-batch Drive media resolution approved, or stay one-file?
9. Are multi-user and scalability documentation-only for this horizon?

## Verification and limitations

- Read Project 6 live through the active `GHolmesDesigns` GitHub identity (2026-08-23 pass).
- Verified the live main commit and the merged pull request attached to every struck requirement
  (2026-08-23 pass).
- 2026-08-30 delta: re-read `Version 5.5.docx` via OOXML extraction (0 strikethroughs);
  verified closed state of #260, #261, #271, #275; inspected `origin/main` at `ed8b211` and app
  version `5.9.4`; inspected MCP setup UI, nav order, Buffer route constants, calendar read-only
  composition, view defaults, and Drive media boundaries.
- 2026-08-30 C136 post-implementation pass: inspected `origin/main` at `ca046a8`, app version
  `5.9.5`. Read `McpConnectionSetupCard.tsx`, `shared/mcp-client-config.ts`,
  `shared/mcp-client-guide.ts`, `client/src/components/AgentsView.tsx`, and the label-resolution path
  in `server/mcp/http.ts`. Confirmed the live server over HTTPS MCP via `system_connection_status`
  (server 5.9.5, capability `mcp-d3c51687`, 60 tools, 4 resources).
- The five C136 findings are from code inspection plus one operator connection attempt, not from a
  test suite. C136-1 was reasoned from the call sequence; the revoke-then-failed-issue path was not
  deliberately triggered against a live credential. C136-2 through C136-5 were each observed or read
  directly in the emitted values.
- 2026-08-30 full-repository sweep: static inspection of HTTP hardening, auth and session handling,
  the coordination and workspace read paths, the MCP registry and boundary tests, storage
  configuration, and process lifecycle. Read, not executed — no exploit was run, no load test was
  performed, and the SW-1 query counts are derived from the call graph rather than measured.
- The sweep did not cover: the Signal/provider surface beyond MCP registration and the publish
  boundary, Buffer and Post Bridge adapters, Drive sync internals, the import parsers past their body
  limits, the e2e suite, or client rendering performance. Dependency and supply-chain review
  (`npm audit`, license posture) was not performed.
- Earlier in this session the truncation of handoff message bodies was attributed to MCP. No
  server-side truncation of `message` was found in the coordination path; `handoffMessageExcerpt`
  (`shared/agent-coordination.ts:321`, 140 chars) is UI-only and has no other caller. The truncation
  is real and reproducible at roughly 400 characters through two different agents, but its source is
  unconfirmed and may be client-side rendering rather than HCC. Not filed as a finding for that
  reason.
- Made no live Post Bridge, Buffer, Drive, or platform call.
- Ran no application quality gates because this is a planning artifact and changes no runtime code.
- Neither DOCX could be visually rendered in Word; OOXML extraction preserved paragraph order and
  strike flags. Annotated-image layout was not visually reviewed.
- The working tree may contain unrelated local changes. This report file is the only deliverable of
  the 5.5 delta review.
