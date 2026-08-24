import { PUBLISH_RATE_LIMIT_FALLBACK_SECONDS } from '../provider.ts';
import { BufferProviderError } from './error.ts';

export const BUFFER_REQUEST_TIMEOUT_MS = 20_000;

const RATE_LIMIT_HEADERS = [
  'retry-after',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-policy',
] as const;

/** Rate-limit headers only, lower-cased, with credential-shaped values scrubbed. */
export const bufferRecordedHeaders = (headers: Record<string, string>): Record<string, string> => {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  const kept: Record<string, string> = {};
  for (const name of RATE_LIMIT_HEADERS) if (lower[name] !== undefined) kept[name] = lower[name];
  return kept;
};

const providerMessage = (body: unknown): string => {
  if (!body || typeof body !== 'object') return '';
  const row = body as Record<string, unknown>;
  if (Array.isArray(row.errors)) {
    const first = row.errors[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  return '';
};

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BufferProviderError(`${label} is not an object.`);
  return value as Record<string, unknown>;
};

const rateLimitFrom = (
  status: number,
  headers: Record<string, string>,
): { rateLimited?: boolean; retryAfterSeconds?: number } => {
  if (status !== 429) return {};
  const retryAfter = Number(headers['retry-after']);
  return {
    rateLimited: true,
    retryAfterSeconds:
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : PUBLISH_RATE_LIMIT_FALLBACK_SECONDS,
  };
};

export type BufferTransport = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; headers: Record<string, string>; body: unknown }>;

export function fetchBufferTransport(): BufferTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: request.signal ?? AbortSignal.timeout(BUFFER_REQUEST_TIMEOUT_MS),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => (headers[name] = value));
    return { status: response.status, headers, body };
  };
}

/**
 * One GraphQL round trip. Top-level `errors` and HTTP failures refuse; response bodies and full
 * header dumps never reach a log line.
 */
export async function bufferGraphqlRequest(
  transport: BufferTransport,
  input: {
    apiKey: string;
    baseUrl: string;
    query: string;
    variables: Record<string, unknown>;
    /** A write whose transport never answered may have landed and must never be retried blindly. */
    ambiguousOnTransport?: boolean;
  },
): Promise<Record<string, unknown>> {
  let response: { status: number; headers: Record<string, string>; body: unknown };
  try {
    response = await transport({
      url: input.baseUrl,
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: input.query, variables: input.variables }),
    });
  } catch (error) {
    throw new BufferProviderError((error as Error).message, {
      ambiguous: input.ambiguousOnTransport ?? false,
    });
  }
  const headers = bufferRecordedHeaders(response.headers);
  if (response.status < 200 || response.status >= 300)
    throw new BufferProviderError(
      `Buffer returned HTTP ${response.status}: ${providerMessage(response.body) || 'no safe message'}`,
      rateLimitFrom(response.status, headers),
    );
  const envelope = object(response.body, 'Buffer GraphQL response');
  if (Array.isArray(envelope.errors) && envelope.errors.length) {
    const first = object(envelope.errors[0], 'Buffer GraphQL error');
    const extensions = first.extensions ? object(first.extensions, 'Buffer error extensions') : {};
    const code = typeof extensions.code === 'string' ? extensions.code : '';
    const rateLimited = response.status === 429 || code === 'RATE_LIMIT_EXCEEDED';
    throw new BufferProviderError(
      `Buffer GraphQL error${code ? ` (${code})` : ''}: ${typeof first.message === 'string' ? first.message : 'no safe message'}`,
      rateLimited ? rateLimitFrom(response.status, headers) : {},
    );
  }
  return object(envelope.data, 'Buffer GraphQL data');
}
