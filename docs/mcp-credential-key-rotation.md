# MCP credential key rotation

## Decision

MCP agent credentials continue to use the configured `SESSION_SECRET` as the server-side
keying secret for their lookup derivation. This keeps the existing storage contract: SQLite
contains only a non-recoverable digest, and the server never needs to retain or recover a raw
credential. A separate key would not make rotation seamless without storing a second digest or
requiring every agent to present its raw token during migration.

The operational consequence is explicit: rotating `SESSION_SECRET` invalidates all existing
MCP agent credentials and operator MCP bearers after the process restarts. This is a deliberate
all-at-once security boundary, not a silent migration.

## Rotation procedure

1. Announce the maintenance window to connected MCP agents.
2. Replace `SESSION_SECRET` in the deployment secret store and restart the server.
3. Issue a new credential for every MCP agent from **Settings → MCP Agents**.
4. Update each agent's saved configuration and verify it can call the MCP endpoint.
5. Treat the old credentials as unusable; do not attempt to recover or re-key their digests.

An MCP request carrying a bearer that cannot be resolved receives HTTP `401` with
`MCP_CREDENTIAL_INVALID`. The response explains that the credential may belong to a previous
`SESSION_SECRET` and directs the operator to issue a replacement, so this condition is not
reported as an unreachable server.

Changing `SESSION_SECRET` still invalidates browser sessions, cookies, and OAuth approval tokens.
It does not remove the ability to rotate the secret; it makes the dependent credential refresh
part of that same planned operation.
