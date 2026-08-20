/* v8 ignore file -- the live transport is `fetch` and a timeout; every decision above it is tested through an injected transport, and no automated test may load this file. */
import type { ProbeHttpRequest, ProbeHttpResponse, ProbeTransport } from './client.ts';

/**
 * Long enough for a signed upload of a few hundred kilobytes on a slow line, short enough that a
 * hung connection does not leave a run half-finished with posts still scheduled.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * `fetch`, a timeout, and nothing else — deliberately.
 *
 * There is no retry. A probe that retries has no request budget it can honour, and a retry after an
 * ambiguous `POST /v1/posts` is how you end up with two scheduled posts and one id to delete. There
 * is no redirect following either: `redirect: 'manual'` means a `3xx` reaches the caller as a status
 * to record rather than as bytes quietly re-sent to somewhere the provider did not name.
 */
export function fetchTransport(timeoutMs = PROBE_TIMEOUT_MS): ProbeTransport {
  return async (request: ProbeHttpRequest): Promise<ProbeHttpResponse> => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      // `Content-Length` is a forbidden header name to `fetch`, which sets it itself from the body's
      // byte length — the same number the caller declared, so the two agree and the evidence stands.
      ...(request.body === undefined ? {} : { body: request.body as BodyInit }),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const text = await response.text().catch(() => '');
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, headers, body };
  };
}
