# Wave 39 — One conversation, two surfaces

**Status:** Study draft — no GitHub cards filed  
**Prepared:** 11 September 2026  
**Source:** Operator screen recording and screenshots of `/agents/conversations` with the Command AI drawer open, plus the Novi Navigator side-panel interaction supplied as a UX reference; reviewed against `origin/main` through C218 and the in-progress C219 branch.  
**Theme:** Make the full Conversations page and the Command AI drawer behave as two views of one selected conversation rather than two independent chat clients.

---

## Study brief

| Question | Current answer |
| --- | --- |
| What is wrong? | The full page and drawer can display different selected threads at the same time. |
| What should change? | They should share one selected conversation identity and remain two presentation surfaces. |
| What stays separate? | Message fetching, handoff mutation, drawer open/closed preference, and full-view-only scoped discussions unless explicitly expanded. |
| What is the recommended contract? | Freeform synchronization first; the full-page `open` query remains the reloadable canonical link. |
| What is not being filed yet? | GitHub cards, issue numbers, release fragments, or product-code changes. |

### Recommended study order

1. Read §0 to separate the observed mismatch from the intended design reference.
2. Read §1 to validate the operator experience in concrete terms.
3. Decide the two contracts in §2.1–§2.2 and confirm the failure behavior in §2.3.
4. Review §3 for card boundaries and §4–§6 for safety, verification, and completion.

### Decisions requested from the study

- Should Wave 39 synchronize freeform Command AI threads only, or should the drawer also become a
  reader for scoped project, client, and task discussions?
- Should the Conversations URL remain canonical, with a small bridge into the persistent drawer, or
  should a global selection store become canonical?
- When the operator selects a scoped thread while the drawer is open, should the drawer clear its
  freeform selection or show a read-only “Open in full view” state?

Until these are answered, the W39 placeholders are intentionally not ready to become numbered cards.

### Terminology

- **Full view:** `/agents/conversations`, the reloadable page with filters, URL-selected thread, archive, decision, and message controls.
- **Drawer:** the persistent Command AI side panel available over workspace pages.
- **Selected conversation:** one conversation ID, not a second copy of messages or a second conversation record.
- **Page context:** optional current-page information supplied to a future assistant request; it is not automatically persisted as a conversation message.

---

## 0. The observed behavior

The full page is opened with a URL such as:

```text
/agents/conversations?open=<conversation-a>
```

The page correctly loads conversation A. At the same time, the Command AI drawer keeps its own React selection and can display conversation B. In the supplied recording, the full page shows the `@Cursor-desktop can you see this?` thread and its operator messages, while the drawer shows `@claude-oauth-claude-482724c3` with zero messages. The identifiers are different; this is not a missing-message display.

This follows the current implementation:

- `ConversationsView` owns the URL-selected conversation and reads `open`.
- `CommandAiPanel` owns a separate `selected` conversation state.
- The drawer intentionally lists only active `freeform` conversations.
- The drawer's **Open full view** link is one-way: it navigates the drawer's selected thread into the full page, but full-page selection does not update the drawer.

The behavior is technically consistent with the two components, but it is not the intended operator experience. The operator should not have to determine which surface currently owns the real conversation.

### Reference interaction from the additional screenshot

The Novi Navigator example shows the intended side-panel shape: the operator stays on the current
workspace page, asks a question in a persistent assistant drawer, can inspect the assistant's
thought/provenance disclosure, and receives an answer based on a fresh authoritative query. The
drawer also exposes History and New controls without taking the operator away from the page.

For Command AI, this means synchronization is not merely visual title matching. The drawer remains
the convenient working surface while the full Conversations page is the expanded, reloadable view
of that same thread. A selected thread must retain its identity while the operator navigates, and
any page context supplied to a future agent query must remain distinguishable from the conversation
record itself.

---

## 1. Intended product behavior

The full page and drawer are synchronized views of the same selected freeform conversation.

1. Opening `/agents/conversations?open=<id>` selects that conversation in the full page and, when the drawer is open, in the drawer too.
2. Selecting a thread in the drawer updates the full-page URL when the operator is on the Conversations page. The full page then loads that same thread.
3. Selecting a thread in the full page updates the drawer selection when the drawer is open.
4. Sending a message from either surface appends to the same conversation. A refresh in either surface must not create a second thread or duplicate a message.
5. The selected conversation remains stable while navigating between pages, subject to access and lifecycle rules below.
6. **Open full view** becomes a synchronization/navigation action, not a second independent copy of the chat.
7. A confirmed known-agent mention still creates an `OPEN` linked handoff. Synchronization must not claim, complete, or otherwise mutate that handoff.
8. If an agent replies, the existing SSE tip path may trigger an authoritative HTTP reread in both surfaces. SSE remains a wake-up hint, never the source of message data.
9. The drawer remains usable over the current workspace page: History and New do not discard the
   selected thread accidentally, and any assistant thought/provenance display remains subordinate
   to the stored conversation message rather than becoming a second answer source.

The drawer may remain visually open across navigation. Its open/closed preference remains local UI state; conversation identity is shared state.

---

## 2. Product contracts to settle before implementation

### 2.1 Scope of synchronization

**Recommended: Option A — synchronize freeform threads first.** The drawer is currently a Command AI freeform surface, and the recording demonstrates a freeform/full-view mismatch. Scoped project, client, and task discussions remain full-view-first until a later card deliberately expands the drawer's scope vocabulary.

- **Option A (recommended):** synchronize only freeform threads; selecting a scoped thread in the full page clears the drawer selection or shows a clear “Open in full view” state.
- **Option B:** extend the drawer to render every conversation scope and synchronize all accessible threads in both surfaces.

The choice changes the API/UI contract and must be recorded before cards are filed. Do not silently make the drawer appear to support scoped conversations by passing a scoped thread into a freeform-only list.

### 2.2 Canonical selection state

**Recommended: Option A — route is canonical on the full page; shared app state bridges the drawer.** The `open` query parameter remains the reloadable deep link. A small app-level conversation-selection bridge mirrors that value to the drawer and emits navigation when the drawer selects a thread.

- **Option A (recommended):** URL is canonical for `/agents/conversations`; app state synchronizes the persistent drawer.
- **Option B:** make a global context/store canonical and project it into the URL only on the full page.

Option A preserves existing deep links, browser Back/Forward behavior, notification destinations, and the current `Open full view` contract with the smallest routing change.

### 2.3 Missing, archived, or inaccessible selection

The bridge must fail closed:

- A missing or inaccessible ID must not cause either surface to display a previous conversation under the new URL.
- An archived thread remains readable in the full page when explicitly opened, but the active-only drawer must not silently reselect it after refresh.
- If the drawer cannot represent the selected scope or state, it should show a short explanatory state and link to full view rather than showing a different thread.

---

## 3. Proposed card sequence

Issue and card numbers are intentionally omitted until live GitHub occupancy is rechecked. The names below are planning placeholders, not filed work.

### W39-A — Shared conversation selection contract

Create a narrow client-side selection bridge with an explicit source (`url`, `full-view`, or `drawer`) and loop protection. Define behavior for initial load, browser navigation, drawer open/close, missing IDs, archived threads, and unsupported scopes. Keep message fetching in the owning view/provider; the bridge carries identity and navigation intent, not message copies.

**Acceptance evidence**

- One selected conversation ID is observable by both surfaces when applicable.
- URL deep links survive reload and browser Back/Forward.
- A stale or unsupported selection is cleared or explained, never replaced with another thread.
- No duplicate fetch loop or duplicate message state is introduced.

### W39-B — Synchronize drawer and full Conversations view

Wire the bridge into `CommandAiPanel` and `ConversationsView`.

**Acceptance evidence**

- Drawer selection on `/agents/conversations` updates `?open=` and the main detail pane.
- Full-view selection updates the drawer without changing the drawer's independent open/closed preference.
- **Open full view** lands on the same thread that was visible in the drawer.
- Sending from either surface writes one operator message to the same conversation.
- Freeform-only behavior and the selected scope contract are visible in the UI.

### W39-C — Live reread and lifecycle correctness

Build on C219 rather than creating a second event system. A conversation/notification tip causes the currently selected surface(s) to reread authoritative HTTP state, with debounce and reconnect fallback.

**Acceptance evidence**

- A reply to the selected thread appears in both surfaces after a tip without a full-page reload.
- A tip for another conversation does not replace the selected thread or append unrelated messages.
- SSE payloads contain no authoritative message body.
- Disconnect/reconnect leaves the last rendered state intact and manual refresh still works.

### W39-CONTEXT — Preserve page context without changing conversation identity

If Command AI later sends page context to an agent, define that context as an explicit, bounded
attachment to the request. It must not silently convert the freeform conversation into a scoped
project/client/task thread, and it must not cause the drawer to switch threads merely because the
operator changed pages.

**Acceptance evidence**

- Navigating from a workspace page to Conversations preserves the selected conversation ID.
- Navigating between workspace pages does not create a new conversation or rewrite prior messages.
- Any context shown to the operator is labelled as current-page context and is not presented as a
  persisted conversation message unless the operator explicitly sends it.
- A fresh answer is visibly tied to the request that produced it; an expandable thought/provenance
  affordance never replaces the answer or becomes authoritative data.

### W39-D — End-to-end synchronization workflow

Add one milestone-level browser spec covering the operator flow:

1. Create or seed two freeform conversations.
2. Open conversation A in the full view while the drawer is open on conversation B.
3. Select A from the drawer and verify the URL, main detail, and drawer title all agree.
4. Send from the drawer and verify the message appears once in the full view.
5. Select B in the full view and verify the drawer follows it.
6. Reload and use browser Back/Forward to verify stable selection.
7. Exercise an unsupported/missing selection and verify no prior thread is shown as a substitute.

This spec should land on the last implementation card for the wave. It must use rows created by the spec and must not depend on a real MCP agent or provider.

### W39-E — Documentation and operator language

Update the user manual and the Conversations/Command AI help text to explain that the drawer and full page are synchronized views, that **Open full view** preserves the selected thread, and that agent mentions create handoffs only after confirmation. Include the unsupported-scope behavior selected in §2.1.

---

## 4. Non-goals

- Do not merge all conversation storage into a second client-side cache.
- Do not make SSE authoritative or place message bodies in tip payloads.
- Do not make the browser execute, claim, or complete an agent handoff merely because a thread is selected.
- Do not broaden the drawer to scoped discussions without choosing Option B in §2.1.
- Do not add OS/browser push notifications; the existing in-app notification surface remains separate.
- Do not change server conversation permissions, retention, provenance, or pagination rules unless a synchronization defect proves a contract gap.

---

## 5. Verification and release gates

Follow `AGENTS.md` and the repository testing guidance:

- Focused component tests for both selection sources, stale IDs, unsupported scopes, and send-through-either-surface.
- Server tests only where the existing API contract needs an explicit synchronization-supporting change.
- One Wave 39 `e2e/` spec for the complete two-surface workflow.
- `npm test`, `npm run test:coverage`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, and `npm run test:e2e`.
- Keep the work in draft branches with `changes/<issue>.md`; perform release finalization only after review and exact-head CI.

---

## 6. Definition of done

Wave 39 is complete when an operator can move between the Command AI drawer and the full Conversations page without seeing two competing selected threads, while deep links, browser navigation, permissions, handoff confirmation, live rereads, and the existing full-view-only boundaries remain correct.
