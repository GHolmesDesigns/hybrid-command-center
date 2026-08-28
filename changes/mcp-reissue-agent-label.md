## Fixed

- Re-issuing an MCP agent credential after revoke no longer fails when you reuse the same agent
  name. Settings kept the registration row for audit, which blocked the unique label; issue now
  reuses that registration when nothing active still holds the name, and refuses a clear conflict
  when one does.

## Breaking changes

None.
