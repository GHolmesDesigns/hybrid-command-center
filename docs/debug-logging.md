# Debug logging

The operator-facing path for debug logging is the server environment variable
`LOG_LEVEL`. Set it to `debug` or `trace` while diagnosing a problem, then
restore the normal level afterward. The default remains `info`.

This repository deliberately does not provide a log panel. A panel would
duplicate the server log, create another surface on which credentials could be
rendered, and blur the boundary between diagnostics and the append-only
integration activity log. The integration activity log remains the audit trail
for integration operations; request debug output is not an audit record.

The request logger uses `pino-http`. It keeps the request path and operational
metadata, but does not serialize request headers or query strings. Error
objects are reduced to their type/name; messages, stacks, causes, and custom
properties are not logged. Consequently credentials, bearer values, token
hashes, Drive tokens, provider keys, and session secrets are not loggable at
any level.

`LOG_LEVEL` is validated when the server starts. An unknown value falls back to
`info`, and `silent` disables request logging. Logs are for private server
diagnostics only and must not be treated as a replacement for integration
events or security audit records.
