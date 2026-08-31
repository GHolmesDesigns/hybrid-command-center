# MCP client parity verification — 31 August 2026

**Card:** C176 ([#468](https://github.com/GHolmesDesigns/hybrid-command-center/issues/468))

This note records what was actually verified for Codex, ChatGPT Chat, and ChatGPT Work. A
successful connection from one client is not evidence for another client, even when both use the
same HCC backend.

## Evidence rules

- A client is verified only when it reaches the hosted HTTPS MCP endpoint and returns
  `system_connection_status` with its own agent identity, granted scopes, store ID, server version,
  and capability version.
- Discovery evidence includes the actual tool names and schemas available to that client. A tool
  count alone is insufficient.
- A read proves only a read. Scope grants and a successful diagnostic do not prove write access.
- Writes are validated against the deterministic fixture suite. No live write is performed as part
  of this reconciliation.
- Client evidence and deployment evidence are separate. Repository code and a successful Git pull
  do not establish what the hosted origin is running.

## Surface matrix

| Surface | Endpoint/authentication | Identity and store | Discovery/read | Write status | Result |
| --- | --- | --- | --- | --- | --- |
| Codex desktop session used for this verification | Hosted HTTPS MCP; bearer credential | `codex-desktop`; scopes `coordination:read`, `coordination:write`, `workspace:read`, `workspace:write`; store `c11bf2bb-8af9-4680-9c02-b347720fb532` | `system_connection_status` passed at `2026-08-31T18:52:34.223Z`; 60 tools, 4 resources; bounded `hcc://workspace/context` read passed | Not exercised live; fixture writes only | **Verified for authenticated discovery and bounded read** |
| Another Codex installation | Must be checked independently | No dated client evidence supplied | Not verified | Not verified | **Unverified** |
| ChatGPT Chat custom MCP app | Requires the hosted MCP OAuth connector route; bearer paste-in compatibility is not assumed | No client session was operated for this card | Not verified | Not verified | **Unverified** |
| ChatGPT Work | Uses its installed connector/plugin configuration, independently of local Codex files | No client session was operated for this card | Not verified | Not verified | **Unverified** |

The Codex result is a bounded read result, not a write proof. The ChatGPT rows remain explicitly
unverified because this repository session cannot operate those account-level clients.

## Discovery and capability comparison

The verified Codex session returned 60 tools and 4 resources. The exact client-visible schemas were
not exported by the hosted diagnostic, so this note does not claim that a count proves parity.
The source registry currently defines the shared tool surface, but a client must be checked with its
own discovery result after connection:

1. Run `system_connection_status`.
2. Capture the client's `tools/list` names and input schemas, plus `resources/list` and
   `prompts/list` when the client exposes them.
3. Compare enabled actions against the source registry and record unavailable resources/prompts as
   client UI limitations, using `system_capabilities` as the read-equivalent where supported.
4. Read the same existing workspace record through every client that reaches the same store.

No client should be marked write-capable from scopes alone. The fixture suite covers stale
revisions, idempotent retries, evidence-required completion, independent identities, credential
impersonation refusal, revocation isolation, rate limits, and the publish/Drive approval boundary.

## OAuth assessment and deployment lag

MCP OAuth for Claude chat and Cowork was shipped in repository version 5.10.0 and is the
implementation tracked by closed issue [#427](https://github.com/GHolmesDesigns/hybrid-command-center/issues/427).
That source change adds protected-resource and authorization-server discovery, dynamic client
registration, browser approval, and token exchange. It does not by itself prove that ChatGPT Chat
or Work can connect to the deployed host.

The live hosted diagnostic on 31 August 2026 reported server **5.9.5** and capability
`mcp-d3c51687`; the repository on this branch is **5.11.0**. This is deployment lag, not client
authentication evidence. Until the hosted origin reports a release containing the OAuth route, do
not promise compatibility for a name-and-URL-only ChatGPT connector. Do not disable HCC
authentication, add a no-auth bridge, or paste a bearer into ordinary chat.

## Fixture and live verification commands

The deterministic fixture evidence is produced without contacting production:

```bash
npm run test:eval-mcp
```

The owner-run production smoke is read-only and does not establish write parity:

```bash
HCC_EVAL_SMOKE_PASSWORD=… npm run eval:mcp-smoke -- --live --yes \
  --base-url https://hcc.gholmesdesigns.com
```

For a future client-specific verification, record the timestamp, endpoint, agent label, scopes,
store ID, server/capability versions, exact discovery comparison, same-record read result, and
fixture/live write result. Any live write must name an explicitly approved target and action and
must be read back from the other client.

## Remaining risks

- Another Codex installation, ChatGPT Chat, and ChatGPT Work still need operator-run verification.
- The hosted origin must be redeployed before the repository's OAuth implementation can be assessed
  from ChatGPT Chat or Work.
- A client that hides resources or prompts may still have equivalent tools; that distinction must be
  recorded rather than reported as lost backend capability.
