/**
 * The one place a live request goes out, and the reason every other module in this directory is
 * testable without a network.
 *
 * `ProbeTransport` is the seam. Everything above it — the guards, the request shapes, the parsing,
 * the budget, the redaction, the teardown — is ordinary code exercised by ordinary tests with a
 * function that returns a canned response. Below it is `transport.ts`, which is `fetch` and nothing
 * else, and which no automated test loads. The provider name appears in this file only as a base
 * URL a caller passes in.
 */
import { RequestBudget } from './budget.ts';
import { recordedHeaders, redactSecrets, redactUrl } from './redact.ts';

export interface ProbeHttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** A JSON string for an API call, raw bytes for a signed upload. Never logged either way. */
  body?: string | Uint8Array;
}

export interface ProbeHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON where the response had a JSON body, `undefined` where it had none. */
  body: unknown;
}

export type ProbeTransport = (request: ProbeHttpRequest) => Promise<ProbeHttpResponse>;

/** One API call, in the vendor's vocabulary, before an authorization header exists. */
export interface ProbeApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Rooted at the versioned base URL — `/posts`, `/posts?limit=1&offset=0`. */
  path: string;
  body?: unknown;
}

/** What the report is allowed to say happened. No URL query, no request body, no response body. */
export interface ProbeCall {
  label: string;
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  teardown: boolean;
}

export interface ProbeCallResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** The transport threw. The message is scrubbed because a DNS or TLS error can quote the URL. */
export class ProbeTransportError extends Error {
  constructor(label: string, cause: unknown) {
    super(
      `The request "${label}" did not complete: ${redactSecrets(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
    this.name = 'ProbeTransportError';
  }
}

/**
 * A stop condition tripped. Raised so the run unwinds into its `finally` and cleans up now, rather
 * than continuing to poke a provider that has just said something unexpected.
 */
export class ProbeStopError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Stopping and cleaning up: ${reason}`);
    this.name = 'ProbeStopError';
    this.reason = reason;
  }
}

export interface ProbeClientOptions {
  apiKey: string;
  baseUrl: string;
  transport: ProbeTransport;
  budget: RequestBudget;
}

/**
 * Why the upload URL is validated here rather than trusted.
 *
 * It is the one address in the run that the provider chooses and this code sends bytes to. `https:`
 * because the bytes and the signature are both in flight; no embedded credentials, because a
 * `user:pass@` form would put them in every log line that survived redaction; no fragment, because
 * a fragment on a `PUT` target means the string is not the URL it looks like. A refusal here costs
 * one question and leaves nothing behind, which is the cheap outcome.
 *
 * It checks the string and returns nothing, deliberately. `new URL(x).toString()` re-encodes, and a
 * signed URL's signature covers the exact bytes the provider handed over — so the request is sent
 * with the original string and only the *inspection* goes through `URL`.
 */
function assertUsableUploadUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProbeStopError('the provider returned an upload URL that is not a URL.');
  }
  if (parsed.protocol !== 'https:')
    throw new ProbeStopError(`the upload URL is ${parsed.protocol} rather than https:.`);
  if (parsed.username || parsed.password)
    throw new ProbeStopError('the upload URL carries embedded credentials.');
  if (parsed.hash) throw new ProbeStopError('the upload URL carries a fragment.');
}

export class ProbeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: ProbeTransport;
  readonly budget: RequestBudget;
  readonly calls: ProbeCall[] = [];
  /** Every `429` seen, in the order they arrived. Question 7 reads this and nothing else. */
  readonly rateLimits: ProbeCall[] = [];

  constructor(options: ProbeClientOptions) {
    if (!options.apiKey) throw new Error('A probe client needs an API key.');
    if (!options.baseUrl.startsWith('https://')) throw new Error('A probe base URL must be https.');
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.transport = options.transport;
    this.budget = options.budget;
  }

  /**
   * One API call: budget, bearer token, JSON, and a log line that could be pasted into a review.
   *
   * A `429` is recorded and then stops the run. The probe has a documented rule that it never
   * creates load to discover a limit, so the only honest thing to do with a limit it did not ask
   * for is to write the headers down and stop asking.
   */
  async api(
    label: string,
    request: ProbeApiRequest,
    options: { teardown?: boolean } = {},
  ): Promise<ProbeCallResult> {
    const teardown = options.teardown === true;
    this.budget.spend(label, { teardown });
    const url = `${this.baseUrl}${request.path}`;
    let response: ProbeHttpResponse;
    try {
      response = await this.transport({
        method: request.method,
        url,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      this.record(label, request.method, url, 0, {}, teardown);
      throw new ProbeTransportError(label, error);
    }
    const call = this.record(
      label,
      request.method,
      url,
      response.status,
      response.headers,
      teardown,
    );
    if (response.status === 429) {
      this.rateLimits.push(call);
      throw new ProbeStopError(
        `the provider answered 429 on "${label}". Its headers are recorded; the probe does not retry or wait it out.`,
      );
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: recordedHeaders(response.headers),
      body: response.body,
    };
  }

  /**
   * The signed `PUT`, which is the one call that deliberately carries **no** `Authorization`.
   *
   * The upload URL already carries its own authority in its query string and the host on the other
   * end is object storage rather than the provider's API. Sending the bearer token there would hand
   * this account's API key to a third party for no reason at all, so the header is absent by
   * construction rather than by a caller remembering to leave it out.
   */
  async upload(
    label: string,
    upload: { uploadUrl: string; mimeType: string; bytes: Uint8Array },
  ): Promise<ProbeCallResult> {
    assertUsableUploadUrl(upload.uploadUrl);
    this.budget.spend(label);
    let response: ProbeHttpResponse;
    try {
      response = await this.transport({
        method: 'PUT',
        url: upload.uploadUrl,
        headers: {
          'Content-Type': upload.mimeType,
          'Content-Length': String(upload.bytes.byteLength),
        },
        body: upload.bytes,
      });
    } catch (error) {
      this.record(label, 'PUT', upload.uploadUrl, 0, {}, false);
      throw new ProbeTransportError(label, error);
    }
    const call = this.record(
      label,
      'PUT',
      upload.uploadUrl,
      response.status,
      response.headers,
      false,
    );
    if (response.status === 429) {
      this.rateLimits.push(call);
      throw new ProbeStopError(
        `the storage endpoint answered 429 on "${label}". Its headers are recorded; the probe does not retry.`,
      );
    }
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: recordedHeaders(response.headers),
      body: response.body,
    };
  }

  private record(
    label: string,
    method: string,
    url: string,
    status: number,
    headers: Record<string, string>,
    teardown: boolean,
  ): ProbeCall {
    const call: ProbeCall = {
      label,
      method,
      url: redactUrl(url),
      status,
      headers: recordedHeaders(headers),
      teardown,
    };
    this.calls.push(call);
    return call;
  }
}
