---
name: housekeeping
description: >-
  Perform housekeeping on this repository's local checkout: sync main, remove worktrees and local
  branches whose pull requests have merged, clear disposable test output, check card hygiene
  against AGENTS.md, and report what was removed, kept, and needs a decision. Use whenever the
  user says "perform housekeeping", "housekeeping", "tidy up", "clean up the repo", "prune merged
  branches", "clean up worktrees", "what's stale", or asks for a dry run of any of these — even
  when they name only one part, such as stale worktrees.
---

# Housekeeping

Housekeeping returns the local checkout to a clean, known state without changing how the app
behaves. It cleans up and reports. It builds no features, and it does not prepare a release.

The rule that governs every step: **remove only what can be recovered from GitHub, and leave
everything else where it is.** A branch whose every commit is in a merged pull request can be
restored from `refs/pull/<n>/head`; a clean worktree of that branch holds nothing else. Anything
that does not meet that bar goes in the report for the user, untouched.

## Dry run

If the user asks for a dry run, a report only, or what housekeeping *would* do, run steps 1–2,
then write the report with **Would remove** in place of **Removed**, and stop.

## What housekeeping never does

- Delete unmerged or uncommitted work, or drop a stash.
- Touch `.env`, anything under `data/` (the real SQLite database and its backups), or credentials.
  `data/e2e.db` is left alone too: Playwright deletes it at the start of every run, and removing it
  mid-run breaks that run.
- Use `--force` on `git worktree remove`, `git clean`, `git reset --hard`, or force-push.
- Close, merge, or mark ready a pull request, run `finalize:card`, or bump a version.
- Contact Drive, the production MCP server, Buffer, or Post Bridge.
- Commit, move, ignore, or delete an untracked or modified file. Those get a suggested outcome in
  the report, and the user decides.

## Steps

1. **Sync.** `git fetch origin --prune`.

2. **Inventory.** From the repository root, run:

   ```bash
   node --experimental-strip-types .claude/skills/housekeeping/scripts/inventory.ts
   ```

   It prints JSON classifying every worktree, local branch, stash, open pull request, and
   disposable output, each with a `verdict` (`remove`, `keep`, or `decide`) and a `reason`. It
   makes no changes. Act on its verdicts rather than re-deriving them: it handles squash merges,
   upstreams that are gone, detached worktrees, and Dependabot branches checked out under another
   name. If a verdict looks wrong to you, treat that item as `decide` and say why in the report.
   If `githubReadable` is `false`, no branch can be proven merged, so remove no branches or
   worktrees, and report that `gh` could not be read.

3. **Fast-forward main.**
   - If `main.ahead` is above 0, local main holds commits that are not on origin. Report it and
     leave main alone.
   - Otherwise, if `main.behind` is above 0 and `main.checkedOutAt` is `null`, run
     `git fetch origin main:main`. If main is checked out and that checkout is clean, run
     `git -C <checkedOutAt> merge --ff-only origin/main`. Otherwise report it.

4. **Remove worktrees** with verdict `remove`: `git worktree remove "<path>"`, then
   `git worktree prune` once at the end. If git refuses, leave the worktree and quote git's message
   in the report. On Windows, a deep `node_modules` can make removal fail partway; report what is
   left. Do not retry with `--force`. A worktree under `.codex/worktrees/` or `.claude/worktrees/`
   belongs to another agent's session; remove it when its verdict is `remove`, and name the owner
   in the report.

5. **Delete branches** with verdict `remove`: `git branch -D <name>`. Use `-D` because this repo
   squash-merges, so `-d` refuses even when the work is merged; the inventory has already proved
   every local commit is in the merged pull request. Remove worktrees before branches, since git
   will not delete a branch that is checked out. If a `remove` branch is checked out in this
   session's checkout and the checkout is clean, `git switch main` first. If the checkout is not
   clean, the inventory has already marked it `decide`.

6. **Clear disposable output.** Delete exactly the paths in `disposables`, and nothing else. The
   inventory lists only git-ignored test output in the primary checkout and this one.

7. **Confirm.** Run the inventory again. Everything removed should be gone, and every `keep` and
   `decide` item should be unchanged.

8. **Report**, using the format below.

## Suggesting outcomes for `decide` items

For each `decide` item, and each uncommitted or untracked change, suggest one outcome:

- commit it to its card (name the branch)
- move it out of the repository
- add it to `.gitignore`
- discard it
- leave it as it is

Give the evidence in one line. For example: *uncommitted edit to
`docs/google-ads-module-plan.md` on `docs/703-google-ads-plan`, whose pull request #704 has
already merged → needs a new card, or discard*. Suggest only. Do not carry it out.

## Report format

Keep the tone plain and factual. Leave out any section that would be empty, except
**Needs your decision**, which says "Nothing." when there is nothing.

```markdown
## Housekeeping — YYYY-MM-DD

**Removed**

- Worktree `<path>` — <reason>
- Branch `<name>` — <reason>
- `<disposable path>`
- main fast-forwarded <n> commit(s)

**Kept**

- `<item>` — <reason, e.g. open pull request #708>

**Needs your decision**

- `<item>` — <evidence> → suggested: <outcome>

**Card hygiene**

- <each entry from cardFindings, or "No findings.">
```
