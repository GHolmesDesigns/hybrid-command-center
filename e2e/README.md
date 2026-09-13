# End-to-end tests

Playwright specs in this folder run **serially** against one API server and one SQLite file
(`data/e2e.db`, deleted at the start of every run). `playwright.config.ts` sets `workers: 1` and
**no retries** on purpose: a red run should name a real ordering or state problem, not invite a
reroll.

## Isolating data

Every spec must scope assertions to rows it created in the same run:

- Stamp names and external ids with `Date.now()` (or another run-unique suffix).
- Read counts and identities back through the API for those rows rather than assuming an empty
  workspace.
- Do not rely on another spec having left the database in a particular shape.

When a flow depends on asynchronous UI planning — merge preview reads, font swap after navigation —
wait for the boundary the spec is about (`layoutSettled`, `waitForMergePreview`) before measuring or
confirming. Masking timing with `retries` or bare `waitForTimeout` hides the cause the suite is
meant to surface.
