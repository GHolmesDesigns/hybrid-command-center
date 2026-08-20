import https from 'node:https';
import { once } from 'node:events';
import { PublishProviderError, type PublishMediaSource } from './provider.ts';

export const UPLOAD_CONNECT_TIMEOUT_MS = 10_000;
export const UPLOAD_BODY_TIMEOUT_MS = 60_000;

interface UploadResponse {
  statusCode?: number;
  resume(): void;
  once(event: 'end' | 'error', listener: (error?: unknown) => void): unknown;
}

interface UploadSocket {
  setTimeout(milliseconds: number): unknown;
  once(event: 'secureConnect' | 'timeout', listener: () => void): unknown;
}

interface UploadRequest {
  once(event: 'socket', listener: (socket: UploadSocket) => void): unknown;
  once(event: 'error', listener: (error: unknown) => void): unknown;
  write(chunk: Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
}

export type UploadRequestFactory = (
  url: URL,
  options: {
    method: 'PUT';
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
  onResponse: (response: UploadResponse) => void,
) => UploadRequest;

const nodeRequest: UploadRequestFactory = (url, options, onResponse) =>
  https.request(url, options, onResponse) as UploadRequest;

/**
 * Streams directly to the signed HTTPS URL. Node's client never follows redirects, and a body
 * transfer is never retried because a broken connection cannot say how many bytes landed.
 */
export async function putSignedMedia(
  uploadUrl: URL,
  source: PublishMediaSource,
  signal?: AbortSignal,
  createRequest: UploadRequestFactory = nodeRequest,
): Promise<void> {
  let responseResolve!: (value: { status: number }) => void;
  let responseReject!: (reason: unknown) => void;
  const response = new Promise<{ status: number }>((resolve, reject) => {
    responseResolve = resolve;
    responseReject = reject;
  });
  const request = createRequest(
    uploadUrl,
    {
      method: 'PUT',
      headers: {
        'Content-Type': source.mimeType,
        'Content-Length': String(source.sizeBytes),
      },
      ...(signal ? { signal } : {}),
    },
    (incoming) => {
      incoming.resume();
      incoming.once('end', () => responseResolve({ status: incoming.statusCode ?? 0 }));
      incoming.once('error', responseReject);
    },
  );
  request.once('socket', (socket) => {
    socket.setTimeout(UPLOAD_CONNECT_TIMEOUT_MS);
    socket.once('secureConnect', () => socket.setTimeout(UPLOAD_BODY_TIMEOUT_MS));
    socket.once('timeout', () => request.destroy(new Error('Post Bridge media upload timed out.')));
  });
  request.once('error', responseReject);
  let beganBody = false;
  try {
    for await (const chunk of source.body) {
      beganBody = true;
      if (!request.write(chunk)) await once(request as never, 'drain');
    }
    request.end();
    const result = await response;
    if (result.status < 200 || result.status >= 300)
      throw new PublishProviderError(
        result.status >= 300 && result.status < 400
          ? 'Post Bridge media upload refused a redirect.'
          : `Post Bridge media upload failed (${result.status}).`,
        beganBody,
      );
  } catch (error) {
    request.destroy();
    // A source error can race the request's own error event. Consume the response rejection so a
    // precise Drive failure never creates an unhandled promise rejection after this function exits.
    void response.catch(() => undefined);
    if (error instanceof PublishProviderError) throw error;
    if (error instanceof Error && error.name === 'DriveMediaError') throw error;
    throw new PublishProviderError('Post Bridge media upload did not complete.', beganBody, {
      rateLimited: false,
    });
  }
}
