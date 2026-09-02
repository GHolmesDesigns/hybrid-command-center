# Calendar → Signal entry decision — 2026-09-02

Status: **decided (C159 / #451).** This record settles how a person opens a scheduled Signal
post from Calendar. It changes no application behavior and does not authorize a second editor.

## Decision

Calendar links to the existing Signal planner with the post selected:

`/signal?post=<post-id>`

The `post` value is the URL-encoded Signal post id. The Signal route resolves that id, loads the
same editor used by every other Signal entry point, and opens it in edit mode. Calendar remains a
read-only view: clicking a post changes navigation only; it does not make Calendar an edit
surface or add a calendar-side form.

## Unknown and stale ids

An absent, malformed, unknown, or stale `post` id is handled as a safe navigation failure:

- `/signal` still renders normally;
- no new-post form opens;
- no post is created, changed, or deleted;
- the invalid `post` parameter is removed with a history-replacing navigation; and
- the page shows a visible message such as “That Signal post is no longer available.”

The message is transient UI state after the failed lookup. Refreshing the cleaned `/signal` URL
does not repeat the lookup or the message. A valid id that becomes unavailable before the editor
finishes loading follows the same behavior. The implementation must not silently substitute the
new-post flow, because an old bookmark must never create an unrelated post.

## Reasoning

Signal Campaign owns the schedule and its editor. The calendar is deliberately composed from
read-only `SignalProvider` data and task due dates; hosting the editor there would turn Calendar
into an additional edit entry point and duplicate Signal editor state. A deep link keeps one
owner, one form, and one validation/confirmation path while allowing Calendar to be useful as a
navigation window onto scheduled content.

The explicit `post` parameter extends the existing query-addressable Signal entry-point pattern.
It is distinct from `new=1`: `new=1` creates an unscheduled or date-prefilled post, while `post`
selects an existing post. The parameters must not be combined; if both appear, the existing-post
selection wins and `new=1` is ignored.

## Single-editor invariant

There will be exactly one Signal editor implementation. Calendar, the Signal planner, deep links,
and future entry points all invoke that same editor state and component. No Calendar modal,
embedded copy, or second save path may be added.

## Consequences for implementation

The implementation card should:

1. make each calendar post an accessible link or keyboard-reachable navigation control to the
   canonical `/signal?post=<post-id>` form;
2. preserve the normal Signal URL state that is intentionally retained by the existing view-state
   convention, without deriving a calendar instant from a post's date/time labels;
3. validate the selected id through the normal Signal read path before opening edit mode;
4. clean stale and unknown ids as described above; and
5. cover valid selection, malformed/unknown selection, no accidental creation, and browser Back
   behavior.

This decision requires no README or user-manual claim that Calendar edits Signal posts. The
README and manual should continue to describe Calendar as read-only and Signal as the editing
surface. If later product scope changes to host the editor in Calendar, that would require a new
decision and explicit updates to both documents before implementation.

## Verification

- [x] The deep-link option is selected over hosting the editor in Calendar.
- [x] The exact query-addressable form is `/signal?post=<post-id>`.
- [x] Unknown, malformed, and stale ids have explicit behavior.
- [x] Calendar remains read-only.
- [x] Exactly one Signal editor implementation is required.
- [x] No application behavior or provider call is introduced by this card.
