# MCP agent evaluation

**Card:** C134 ([#384](https://github.com/GHolmesDesigns/hybrid-command-center/issues/384))
**Plan:** [`mcp-capability-plan.md`](mcp-capability-plan.md) §C134

This suite proves scripted agent workflows against a **non-production fixture database**. It is
not a model-quality benchmark. Scores follow the Codex report's guidance: task success, evidence
completeness, latency, and approximate token use.

Production is exercised only by an owner-run, read-only smoke that creates nothing.

## Fixture suite

```bash
npm test -- server/mcp/agent-evaluation.test.ts
```

The suite seeds a known workspace (Acme Studio, a directed open handoff, a claimed decoy, and a
target task), then runs scenarios for every C134 acceptance bullet, including one case per §2
defect (D1–D5) that would fail on the pre-fix commit.

| Scenario | Defect |
| --- | --- |
| Discovering the correct task | — |
| Avoiding already-claimed work | — |
| Recovering after a lost response | D2 |
| Rejecting a stale revision | — |
| Resuming from a checkpoint | — |
| Reporting validation evidence | D4 |
| Respecting the publish and Drive approval boundary | D5 |
| Avoiding duplicate mutations after retries | D2 |
| Handling an expired lease | — |
| Producing a useful operator handoff | — |
| Two independent agent identities | — |
| Credential cannot impersonate by header | D3 |
| Revoking one agent without interrupting others | — |
| Network write rate limit persists | D1 |
| Change cursor recovers after restart | — |
| Read-only diagnostic leaves checksums unchanged | — |

Transcripts stay out of the repository. The Vitest run is deterministic and rides ordinary
`npm test` / CI coverage; it never contacts production.

### Fixture evaluation matrix — 29 August 2026

Recorded by the deterministic Vitest suite on this branch. Re-run the command above to refresh
figures; commit only this reviewed table, never a raw transcript.

| Scenario | Defect | Success | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Discovering the correct task | — | **pass** | complete | Search + list resolve the seeded Acme caption task |
| Avoiding already-claimed work | — | **pass** | complete | Second claim → `COORDINATION_INVALID_STATE` |
| Recovering after a lost response | D2 | **pass** | complete | Identical `clientRequestId` note replay |
| Rejecting a stale revision | — | **pass** | complete | `WORKSPACE_REVISION_CONFLICT` |
| Resuming from a checkpoint | — | **pass** | complete | `work_get_resume_context` restores step |
| Reporting validation evidence | D4 | **pass** | complete | Complete requires summary + outcome |
| Respecting publish / Drive boundary | D5 | **pass** | complete | `approvalBoundaries` present; no publish tools |
| Avoiding duplicate mutations | D2 | **pass** | complete | Signal create replay inserts once |
| Handling an expired lease | — | **pass** | complete | Reclaim abandons; heartbeat fails |
| Useful operator handoff | — | **pass** | complete | Summary, references, validations |
| Two independent identities | — | **pass** | complete | Distinct server-bound labels |
| Header impersonation refused | D3 | **pass** | complete | `COORDINATION_CREDENTIAL_LABEL_MISMATCH` |
| Revoke one agent | — | **pass** | complete | Sibling bearer still authenticates |
| Rate limit across HTTP posts | D1 | **pass** | complete | 11th write refused with persistent budget |
| Cursor after restart | — | **pass** | complete | File DB reopen reads after-cursor page |
| Read-only checksum smoke | — | **pass** | complete | `system_connection_status` leaves checksum intact |

## Production smoke (owner-run)

```bash
npm run eval:mcp-smoke -- --base-url https://hcc.gholmesdesigns.com
HCC_EVAL_SMOKE_PASSWORD=… npm run eval:mcp-smoke -- --live --yes \
  --base-url https://hcc.gholmesdesigns.com
```

Plan mode contacts nothing. Live mode logs in as the operator and calls
`POST /api/mcp/health/test` only — the same diagnostic C124 uses — which performs discovery and
one bounded resource read and returns `workspaceChecksumUnchanged`. No write tool runs. The
password and transcript are never committed.

### Production smoke matrix — still unverified

| Claim | Result | Evidence |
| --- | --- | --- |
| Discovery (tools/list and resources/list) succeeds | **still unverified** | Owner has not run `--live` against production on this card |
| One bounded resource read succeeds | **still unverified** | — |
| Workspace table checksums unchanged (no writes) | **still unverified** | — |
| Overall diagnostic ok | **still unverified** | — |

Append a dated verified table after an owner live run; leave the transcript out of git.
