## Problem and resulting behavior

Explain the operator/caller problem and the intended observable outcome. Link the issue.

## Behavior and safety evidence

| Acceptance outcome or risk | Test / review evidence | Limits or remaining work |
| --- | --- | --- |
| Main user outcome | | |
| Relevant failure, refusal, and unchanged-state guarantees | | |

Use the relevant rows; mark unrelated risks not applicable with a reason. Test counts and coverage
percentages alone do not satisfy this table. See [testing procedure](../docs/testing.md).

- Existing tests reused, strengthened, added, or removed, and why:
- Bug regression: expected failing-before assertion and passing-after result, or reproduction limit:
- For changed high-risk behavior: targeted fault-check evidence, or why another check is sufficient:
- External boundaries, auth/scopes, secrets, transaction/retry safety reviewed where applicable:

## Validation status

Record commands and results separately for local checks, completed remote CI, and authorized
owner-run verification. Include failures/flakiness and untested environments. Do not equate a skipped
check, mocked provider success, or server-health response with production verification.

## Release

Keep draft with `changes/<issue>.md`. Finalized version and all required checks are required before
ready/merge under `AGENTS.md`; do not assign a version during feature review.
