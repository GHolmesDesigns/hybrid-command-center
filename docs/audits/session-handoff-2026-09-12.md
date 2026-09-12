# Session handoff — 2026-09-12

**Branch:** `claude/get-latest-bc5132` (worktree `post-bridge-integrations-plan-39a95a`, at `ce350de`)
**Working tree:** clean — no code was modified in either investigation.

Two investigations ran. The first is **complete and actionable**. The second is **partially
complete**; its raw evidence is on disk and it resumes without re-running what already finished.

---

## 1. Command AI drawer refresh loop — CONFIRMED, fix specified, not applied

Nine agents: three static traces, two independent empirical reproductions, three adversarial
refuters, one judge. No refuter could break it. Reproduced by direct measurement, not by reasoning
alone.

### What it is

`client/src/components/CommandAiPanel.tsx` enters an unbounded self-retriggering fetch loop.
`openThread` calls `setSelected` with a freshly-parsed object, which invalidates `refresh`'s
`useCallback` (`selected` is in its deps at :139), which re-fires the `[open, refresh]` effect at
:141-144, forever. The other three deps are all `useCallback(..., [])` and reference-stable, so
`selected` is the only identity that moves.

### Trigger conditions — all four must hold

1. `open === true` (the effect early-returns at :142). Note `if (!open) return null` at :204 sits
   *after* the hooks, and App.tsx:585 mounts the panel unconditionally — only the effect guard
   keeps it quiet.
2. `selected !== null`. Initializes null at :58, so a fresh load never loops. **Two** entry points:
   clicking a Recent/History row (:256, :282), and — the more common one — `submit()` calling
   `setSelected` at :182 after creating a thread. A first-time operator who types a question and
   presses Send is in the loop.
3. The selected row must return in the refreshed list every pass: `state=ACTIVE&limit=50` (:111)
   and survive the `scope.type === 'freeform'` filter (:112). An archived, non-freeform, or
   51st-newest thread never arms it — which makes field reports look intermittent and
   workspace-size-correlated.
4. Every fetch in the pass must resolve; the catch at :136-138 skips the identity rewrite.

### Impact

Five requests per revolution (agents directory, presence, summaries via the `Promise.all` at
:72-80, plus the conversation list and messages), sustaining ~10 passes/sec ≈ 50 req/sec under
realistic latency. Faster figures measured in jsdom are harness artifacts and were discounted.
Nothing throttles it: `server/budgets.ts` documents that routes outside import/Drive are
deliberately unmetered, and these carry no limiter.

The operator-visible damage matters more than the traffic. `openThread` also calls
`setView('thread')` (:119), and `startNew()` (:152-158) cannot cancel an in-flight refresh that
closed over the old non-null `selected` — so **"New chat" appears to do nothing and snaps back to
the thread**. There is no in-panel escape; closing and reopening the drawer restarts it, because
the component never unmounts and `selected` survives. The effect has no cleanup and no
`AbortController`.

### The fix — three edits, template already in this repo

Copy `ConversationsView`'s ref pattern (ConversationsView.tsx:151-154 / :156-165), *not* a
functional updater — `refresh` must call an async fetch, not merely compute state.

1. After the `messagesEndRef` declaration (~:68):
   ```
   const selectedRef = useRef<Conversation | null>(null);
   useEffect(() => { selectedRef.current = selected; }, [selected]);
   ```
2. In `refresh`, replace the closure read at :131-133 — read the ref **after** the await, which
   also fixes the `startNew` race:
   ```
   const current = selectedRef.current;
   if (current) {
     const fresh = items.find((item) => item.id === current.id);
     if (fresh) await openThread(fresh);
   }
   ```
3. Drop `selected` from the dep array at :139 → `}, [loadAgents, loadConversations, openThread]);`

Do **not** fix this by reducing renders or adding a deep-equality guard inside `openThread`. The
render count is not the problem; `selected`'s identity reaching a dependency array is.

### Regression test — the committed suite cannot catch this

`client/src/CommandAiPanel.test.tsx:23-24` returns `items: []`, so precondition 3 masks it. The
test at :82-136 actually *starts* the loop and passes only because its assertions resolve before
RTL cleanup unmounts the tree. A real test must assert a **bounded request count** after selecting
a thread, and must not use `act()` or `waitFor` to do it — React's work queue never quiesces
against this component, and three separate agents hit 60-120s timeouts that way.

### Blast radius

`ConversationsView` is **safe**, and verified so rather than assumed: it performs the identical
identity rewrite but inside a functional `setState` updater at :89-91, so it never reads `selected`
from the closure; `load`'s deps at :95 are `[filter, flash, scopeQuery]`. No other site has this
shape.

Two adjacent findings, neither a loop, each worth its own ticket:

- `App.tsx:282` — `flash` is a plain arrow, not `useCallback`, so it gets a new identity every App
  render and flows into `ConversationsView`'s `load` deps at :95, re-firing its list fetch. Not
  self-sustaining, but it means stabilizing the drawer should not be assumed to have made
  `ConversationsView` optimal.
- `CommandAiPanel.tsx:90` — `setRegisteredLabels` gets a fresh `.map()` array each pass, re-firing
  `useMentionHandoffCompose`'s memo and its `setConfirmed` effect. A passenger of the loop; settles
  on its own.

### Bearing on Wave 39

W39-A's acceptance criterion "no duplicate fetch loop or duplicate message state is introduced"
is currently unmeetable as written — the loop already exists and the suite cannot see it. Fix and
pin it *before* the selection bridge lands, or the bridge will be blamed for it.

---

## 2. Project security review — PARTIAL, resumes from cache

113 agents planned across 11 dimensions (authn/session, MCP OAuth, authz/IDOR, MCP tool surface,
injection, SSRF/egress, secrets/crypto, web transport/CSRF/SSE, client-side, agent trust boundary,
supply chain). 63 completed; 50 died on a spend limit — many verifier votes, both completeness
critics, and the final synthesis, which therefore returned `null`.

**Verified so far: 17 findings survived adversarial verification — 0 critical, 1 high, 9 medium,
7 low.** These are survivors of a three-lens adversarial pass (accuracy / already-mitigated /
reachability), not raw reviewer output; 2 were dismissed.

### The one finding read in full

**`resources/read` bypasses the MCP credential scope gate** — `server/mcp/resources.ts:160`.
Scope enforcement is keyed to `tools/call` in both places it exists: `requiredToolScope()` returns
null for any other method (`server/mcp/http.ts:233-236`), so the gate at `http.ts:474-480` never
fires, and `dispatch.ts:89-91` is only reached from the `tools/call` branch. The `resources/read`
branch (`stdio.ts:339-349`) calls `readMcpResource` directly, whose fall-through hands the URI to
`readCoordinationResource` — which takes no scopes argument and checks nothing. It returns every
OPEN and CLAIMED handoff with full message bodies, agent labels, and subject IDs. The same data via
`coordination_list_handoffs` *is* gated on `coordination:read` (`registry.ts:95`).

A narrowly-scoped connector (`['workspace:read']`) is refused on the tool and served on the
resource. A verifier corrected high → medium: read-only, no escalation, requires a valid
unexpired credential, and `redactToolResult` scrubs known secret shapes — but handoff content
itself is not redacted. The same verifier found `hcc://workspace/context` is ungated too, which
argues for deriving required scope per resource URI from one table rather than patching the
coordination branch alone. The change-feed branch at `resources.ts:120-129` already does it right
and is the template.

The other 16 are in the artifacts below and have **not** been ranked or synthesized yet.

### To resume — replays the 63 cached agents for free

```
Workflow({
  scriptPath: "C:\\Users\\GarnieHolmes\\.claude\\projects\\C--Users-GarnieHolmes-HCC--claude-worktrees-post-bridge-integrations-plan-39a95a\\40d38c5a-a317-4083-b4fb-353e81f51413\\workflows\\scripts\\hcc-security-review-wf_66173326-d6b.js",
  resumeFromRunId: "wf_66173326-d6b"
})
```

Do not edit that script before resuming — any edit invalidates the cache from the edit point
onward, and the dimension prompts sit at the top of the file.

### Artifacts

- Per-agent results (one JSON `result` line each):
  `…/40d38c5a-…/subagents/workflows/wf_66173326-d6b/journal.jsonl`
- Truncated final result:
  `…/AppData/Local/Temp/claude/…/40d38c5a-…/tasks/wpfp2km8k.output`
- Drawer-loop run (complete): `wf_3050cf84-b72`, task output `wxyauz0ym.output`

---

## Not done

- The drawer-loop fix is **specified but not applied**, and the bounded regression test is not
  written.
- The Wave 39 study document has **not** been edited. The synthesis agent that was to produce a
  drop-in security section for it is among the 50 that failed; writing that section now would mean
  inventing a ranking the evidence has not yet produced.
- The Wave 39 doc itself lives outside this repo, at
  `C:\Users\GarnieHolmes\Dropbox\GHD Deliverables\House\WAVE_39_COMMAND_AI_CONVERSATION_SYNC.md`.
  Separate review notes on it (the missing `?open=` write path, the one-shot
  `openedConversationRef` guard, the archived-thread gap in §2.3) are in the session transcript
  and not yet folded into the document.
