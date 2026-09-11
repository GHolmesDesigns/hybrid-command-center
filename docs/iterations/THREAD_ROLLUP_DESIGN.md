# Thread rollups — design direction

**Card:** C216 / Issue #602  
**Status:** Design only; no application code  
**Depends on:** C202 (operator conversations)  
**Related contract:** `AgentSummary` in `shared/agent-summaries.ts`

## Decision summary

Thread rollups are a reading aid for long conversations, not a replacement for the conversation.
The first evaluation point is **50 persisted messages**. Reaching that count may show a lightweight
operator suggestion, but it must not start a model call or write a rollup by itself. The operator
chooses when to generate a preview and must confirm before a rollup becomes part of the thread's
durable record.

This gives the product the requested auto-suggest timing without making summarization automatic:

1. At 50 messages, the thread can say that a rollup is available to review.
2. The operator selects **Review rollup**, which generates a bounded summary preview.
3. The operator confirms or dismisses that preview.
4. A confirmed rollup is displayed alongside, and links back to, the source messages.

Time alone never triggers a suggestion or summarization. A thread with no new messages does not
become eligible merely because it has aged.

## Why 50 messages

Fifty is an evaluation threshold, not a claim that every fifty-message thread needs a summary. It
is high enough to avoid adding ceremony to short exchanges and low enough to expose whether the
operator benefits before a thread becomes unwieldy. It also matches the existing planning decision
in `docs/iterations/AGENT_HUB_CARDS.md`. The implementation card should keep the threshold in one
shared rule so product evidence can change it without changing UI and server copies independently.

The first version should evaluate a conversation's total persisted message count. It should not
count a rollup as a message, and it should not treat a confirmed rollup as permission to stop
loading or displaying messages.

## Rollup record shape

The outward summary shape follows the C196 `AgentSummary` vocabulary: bounded `text`,
`generatedAt`, and an explicit `evidence` array. The rollup adds identity, source coverage, and
operator state around that shape:

```ts
type ConversationRollup = {
  id: string;
  conversationId: string;
  source: {
    firstMessageId: string;
    lastMessageId: string;
    messageCount: number;
  };
  text: string;
  generatedAt: string;
  evidence: string[];
  state: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED' | 'SUPERSEDED';
  createdAt: string;
  confirmedAt: string | null;
  confirmedBy: 'operator' | null;
};
```

The following rules make the shape useful without duplicating the forum:

- `source` is an immutable range over message IDs. The range is evidence of what was summarized;
  it is not a cursor and is not allowed to drift when later messages arrive.
- `evidence` contains canonical in-app references to the messages that support the summary. It
  uses the existing `string[]` C196 shape for compatibility, but each future entry must resolve to
  a source message or an explicit unavailable-evidence state. Storing only a copied excerpt is not
  sufficient provenance.
- `text` is bounded and plain text. A rollup stores no full message-body copy, credentials, or
  provider response.
- `generatedAt` records when the preview was generated, not when the source conversation ended and
  not when an agent last acted.
- A record becomes `CONFIRMED` only through the operator confirmation action. A generated preview
  is not visible as authoritative agent context while it is `SUGGESTED`.
- A later confirmed rollup may mark an earlier one `SUPERSEDED`, but it never mutates the earlier
  summary or its source range. Source messages remain the canonical history.

The first implementation should cap summary text and evidence at the same bounded values used by
the conversation APIs. If a future provider cannot produce complete evidence, the preview must say
so and confirmation must be refused rather than silently saving an incomplete rollup.

## Operator flow

### Suggestion and preview

The thread detail view keeps its current message list and pagination. Once the shared count rule
marks the thread eligible, the UI adds a non-blocking status such as “50 messages — review a
rollup.” It must not replace the composer, auto-open a modal, or imply that a rollup exists.

Selecting **Review rollup** opens a review surface containing:

- the proposed summary text and generation time;
- the exact source range and message count;
- every evidence reference, each linked to the source message where possible;
- a visible explanation that source messages remain unchanged; and
- **Confirm rollup** and **Dismiss** actions.

The preview hash must cover the conversation ID, source range, summary text, generation time, and
evidence. Confirmation is refused if the conversation or preview changed after generation. This
keeps a person from confirming a preview over a different set of messages.

### Confirmed display

A confirmed rollup appears as a clearly labelled “Thread rollup” item in the conversation, separate
from ordinary messages. It shows its source count and generated time, and its evidence links remain
available. The source timeline stays readable, searchable, and paginatable exactly as before.

Dismissal records the operator decision for that source range. The same range should not repeatedly
show the same suggestion, but new messages may create a new eligible range. Reopening a dismissed
rollup is a deliberate operator action, not an automatic retry loop.

All states need text labels, visible keyboard focus, and accessible confirmation/error messages.
The color or icon for `SUGGESTED`, `CONFIRMED`, and `DISMISSED` is supplemental only.

## MCP implications

The existing conversation read surface remains authoritative. No existing list or message tool may
silently summarize, omit, or replace messages.

The future implementation card should add bounded, explicit operations with these rules:

- Agent reads may return **confirmed** rollups with their source range and evidence references.
- A suggestion is operator-facing by default; it is not injected into an agent's context merely
  because the message threshold was reached.
- Generating a preview, confirming it, dismissing it, and requesting a refresh are separate
  operations. A message post, passage of time, or MCP read cannot confirm a rollup.
- Confirmation and dismissal use the same explicit identity and idempotency discipline as other
  operator mutations. An agent cannot confirm a rollup on behalf of the operator by posting text.
- A read that encounters a rollup whose evidence is unavailable reports that fact visibly; it does
  not turn missing evidence into an unqualified summary.

If the MCP contract later exposes rollups on conversation reads, the addition must be additive and
bounded. Existing message pagination and response shapes remain compatible, and a client can still
retrieve the complete source conversation.

## Retention and lifecycle

Rollups are derived records, not a second message archive. They follow the conversation's future
retention policy and cannot extend the lifetime of source messages. The current conversation model
does not delete source messages, so this design does not introduce deletion or compaction.

When a future retention policy removes a source message, it must also define the rollup consequence:
the rollup may remain as a historical record only if it is marked with unavailable evidence and is
never presented as a complete substitute for the removed source. A rollup must not keep private
copies of all source bodies to bypass that policy.

Rollup writes should be append-only except for explicit lifecycle state transitions. No background
timer, scheduled job, or read path performs summarization. A failed generation or failed
confirmation leaves the last confirmed rollup and all source messages untouched.

## Explicit non-goals

- No message deletion, hiding, replacement, or automatic compaction.
- No summarization because time passed.
- No automatic model call at the 50-message boundary.
- No automatic confirmation or agent-controlled confirmation.
- No requirement that every thread receive a rollup.
- No new autonomous agent workflow, notification, or handoff from a rollup.
- No change to current conversation pagination or source-message retention in this design card.

## Draft implementation card — C216b

**Title:** Confirmed rollups for long conversations  
**Type:** Feature; follow-up to C216  
**Depends on:** C202 and the decisions in this document  
**Scope:** Server contract, operator review UI, bounded MCP reads, and focused tests

### Problem

Long threads become difficult to scan, but a summary that hides its source is unsafe. The product
needs a reviewable reading aid whose provenance is visible and whose creation remains an explicit
operator decision.

### Acceptance criteria

- [ ] At the shared 50-message threshold, an eligible thread offers a lightweight rollup suggestion;
      no model call or durable rollup happens merely because the threshold or time was reached.
- [ ] **Review rollup** generates a bounded preview with `text`, `generatedAt`, `evidence`, and an
      immutable source message range.
- [ ] The operator can confirm or dismiss the preview; confirmation requires an unchanged preview
      hash and an explicit operator identity.
- [ ] A confirmed rollup is displayed as a labelled reading aid with source count, generation time,
      and evidence links.
- [ ] Source messages remain visible, retrievable, and unchanged before and after confirmation.
- [ ] A failed or stale preview writes nothing and leaves the last confirmed rollup and source
      messages unchanged.
- [ ] Dismissing one source range does not suppress a later range containing new messages.
- [ ] Existing message pagination remains compatible and can retrieve the complete source thread.
- [ ] MCP reads expose confirmed rollups only through an explicit bounded contract; posting a
      message, reading a thread, or waiting for time to pass cannot confirm one.
- [ ] Missing or incomplete evidence is visible and prevents confirmation rather than being hidden.
- [ ] No message deletion, automatic compaction, time-only summarization, or agent-controlled
      confirmation is introduced.

### Verification

Focused service and contract tests should cover threshold eligibility, stale preview refusal,
preview-hash mismatch, confirmation/dismissal idempotency, complete evidence, source-message
preservation, and additive MCP reads. Browser coverage should verify the review/confirm flow and
that the original message list remains accessible. Standard repository gates apply; this card does
not add an end-to-end spec to the design-only C216 card.

