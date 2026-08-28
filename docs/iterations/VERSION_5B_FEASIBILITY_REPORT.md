# Version 5b Feasibility Report

Reviewed: 2026-08-23  
Source: `C:\Users\garni\Dropbox\GHD Deliverables\House\Version 5.docx`  
Source modified: 2026-08-23 18:33:13 -04:00  
Source SHA-256: `8AD42C739F6B7C3032D8061F38A9E5EA236CE47AC0A146A62D0D74562BFEF7EA`  
Repository baseline: live `origin/main` at `e232626` (merged C85 / issue #259)  
Roadmap baseline: [Project 6 - Command Center v5.1](https://github.com/users/GHolmesDesigns/projects/6), 10 cards  
Prior report: `VERSION_5_FEASIBILITY_REPORT.md`

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

## Verification and limitations

- Read Project 6 live through the active `GHolmesDesigns` GitHub identity.
- Verified the live main commit and the merged pull request attached to every struck requirement.
- Inspected current types, routes, view-state convention, Signal editor/planner, Projects filters,
  breadcrumbs, CSP, and provider decision records from `origin/main`.
- Made no live Post Bridge, Buffer, Drive, or platform call.
- Ran no application quality gates because this is a planning artifact and changes no runtime code.
- The supplied DOCX could not be rendered because the bundled runtime has no Word-compatible
  renderer (`WinError 2`). Run-level OOXML extraction preserved strikethrough and paragraph order,
  but annotated-image layout was not visually reviewed. Conclusions based on formatting are limited
  to the extracted strike flags.
- The working tree already contained active and unrelated changes. This report is the only file
  intentionally added by this review.
