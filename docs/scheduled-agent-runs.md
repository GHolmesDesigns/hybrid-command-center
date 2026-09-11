# Scheduled agent runs

Scheduled runs (C215 / #601) are coordination metadata. A due schedule creates one ordinary `OPEN`
handoff for its run window; the receiving agent must still claim and complete that handoff. A
schedule never publishes, writes Drive, or runs agent code by itself.

## Tick expectation

The deployment should invoke `POST /api/agent-schedules/run-due` at least once per minute through
the hosted HTTPS origin. The endpoint is behind the ordinary operator authentication and CSRF
middleware, so an external scheduler must use a dedicated operator session and its current CSRF
token. A request may be repeated safely: the `(schedule_id, run_window)` record prevents a second
handoff for the same window.

Local development has no background timer. Use the **Run due schedules** action on the Agents page,
or call the endpoint after authenticating as the operator. This keeps tests and development from
creating unattended work unexpectedly.

The app does not promise sub-minute precision. A paused schedule is ignored by the tick, while
**Run now** is an explicit operator action and creates a handoff immediately even when the schedule
is paused. A failed due run records its failure and follows the schedule's retry-or-pause policy.
