# Signal delivery and Published status decision — 2026-09-02

Status: **decided (C160 / #452).** This record settles whether a successful delivery check
changes a Signal post's planning status. It changes no application behavior and does not alter
the existing reconciliation path.

## Decision

**A successful delivery check does not set planning status to `PUBLISHED`.** `PUBLISHED` remains
the operator's planning claim, changed only through Signal's existing editor or its explicit
**Mark published** action. Delivery success is surfaced in the same Signal editor and delivery
panel instead.

This means the request is about **delivery visibility**, not a second meaning for the planning
status. The app must continue to label the two facts separately:

- **Planning status** — `DRAFT`, `SCHEDULED`, or `PUBLISHED`, describing the operator's record of
  the plan.
- **Delivery** — the provider's per-publication and per-target answer, including whether every
  selected target confirmed delivery.

## Same-panel behavior

After an answered delivery check, the existing delivery panel shows its fresh result without
requiring a separate navigation or a search through history:

- when every selected target is `CONFIRMED`, show a clearly named **Delivered** summary with the
  provider check time and the confirmed target details;
- when targets differ, show **Partially delivered** and retain each target's state, permalink, and
  error or attention reason;
- when delivery failed or is unconfirmed, show the existing failure or attention state and its
  next action; and
- while delivery is in flight, show the existing in-flight state rather than implying success.

The summary is delivery wording, not a replacement for the **Planning status** value. The explicit
**Mark published** action remains available for the operator when the plan should carry that
claim. A successful provider response must not silently trigger that action.

## Later delivery failure

If a later reconciliation changes a previously successful delivery to `FAILED`, `PARTIAL`, or
`UNCONFIRMED`, the delivery panel updates to that provider answer and shows the resulting
attention state. It does **not** rewrite the planning status in either direction:

- a post still marked `SCHEDULED` stays `SCHEDULED` until the operator changes it;
- a post the operator already marked `PUBLISHED` stays `PUBLISHED`, because that field records
  the operator's planning history and is not a provider-health flag; and
- a later provider failure never automatically resets a planning status to `SCHEDULED` or
  `DRAFT`.

The operator can use the delivery details and the existing Signal editing and status controls to
decide what the plan should say. No automatic retry, resubmission, or status correction is added.

## Historical rows

Existing posts retain their current meaning. A historical `PUBLISHED` value remains an operator
claim about the plan, even when it has no publication row or its delivery history is partial.
Existing publication and target rows retain their provider delivery history and are not converted
into planning statuses. Reconciliation continues to update delivery records only, preserving the
separation established by C65/C66.

This is not a reversal of C65/C66. It confirms that planning status has one writer and delivery
reconciliation has a separate responsibility. No new planning status is added, and no existing
delivery state is renamed or collapsed.

## Single-writer and boundary invariants

1. The publisher and reconciler never write `signal_posts.status`.
2. The Signal editor and explicit **Mark published** action remain the only route that changes
   planning status.
3. Delivery remains per publication and per target, so a partial result is never presented as
   an all-target success.
4. Preview, stale-plan confirmation, and existing reconciliation behavior remain unchanged.
5. No provider call is introduced by opening the panel; the panel reads the delivery state already
   stored by a prior submit or explicit check.

## Consequences for a future implementation

A later implementation card may improve the delivery panel's summary and copy, but it must:

1. keep **Planning status** and **Delivery** as separate headings and values;
2. show successful, partial, in-flight, and attention outcomes using the existing provider state
   vocabulary;
3. leave the planning status unchanged after every provider response;
4. preserve per-target evidence and the existing manual **Mark published** action; and
5. cover a confirmed delivery, a partial or failed delivery, a later failure, an already
   `PUBLISHED` historical row, and the absence of any automatic status mutation.

No README or user-manual change is needed for this decision: both already describe planning status
and delivery as separate, and Signal's editor as the place where planning status is changed.

## Verification

- [x] The decision names planning status as unchanged and delivery summary as the visibility need.
- [x] The safer same-panel behavior is specified for confirmed, partial, in-flight, and attention
  outcomes.
- [x] Later delivery failure does not mutate planning status.
- [x] Historical planning and delivery rows keep their existing meanings.
- [x] C65/C66 are confirmed rather than reversed.
- [x] No application behavior or provider call is introduced by this card.
