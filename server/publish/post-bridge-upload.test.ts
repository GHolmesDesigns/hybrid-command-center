import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { PublishMediaSource } from './provider.ts';
import {
  putSignedMedia,
  UPLOAD_BODY_TIMEOUT_MS,
  UPLOAD_CONNECT_TIMEOUT_MS,
  type UploadRequestFactory,
} from './post-bridge-upload.ts';

const source = (): PublishMediaSource => ({
  name: 'probe.png',
  mimeType: 'image/png',
  sizeBytes: 3,
  body: (async function* () {
    yield new Uint8Array([1, 2, 3]);
  })(),
});

function transport(status: number | null = 200) {
  let requestOptions: Parameters<UploadRequestFactory>[1] | undefined;
  const request = new EventEmitter() as EventEmitter & {
    writes: Uint8Array[];
    write(chunk: Uint8Array): boolean;
    end(): void;
    destroy(error?: Error): void;
  };
  const socket = new EventEmitter() as EventEmitter & {
    timeouts: number[];
    setTimeout(milliseconds: number): void;
  };
  socket.timeouts = [];
  socket.setTimeout = (milliseconds) => void socket.timeouts.push(milliseconds);
  request.writes = [];
  request.write = (chunk) => Boolean(request.writes.push(chunk));
  request.destroy = (error) => {
    if (error) request.emit('error', error);
  };
  let respond!: () => void;
  const factory: UploadRequestFactory = (_url, options, onResponse) => {
    requestOptions = options;
    respond = () => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        resume(): void;
      };
      response.statusCode = status ?? 0;
      response.resume = () => undefined;
      onResponse(response);
      queueMicrotask(() => response.emit('end'));
    };
    request.end = status === null ? () => undefined : respond;
    queueMicrotask(() => request.emit('socket', socket));
    return request;
  };
  return {
    factory,
    request,
    socket,
    options: () => requestOptions,
    timeout: () => socket.emit('timeout'),
  };
}

describe('signed Post Bridge upload transport', () => {
  it('sends the exact headers and accepts one successful body without buffering it', async () => {
    const fake = transport();
    await putSignedMedia(
      new URL('https://uploads.example/object?signature=secret'),
      source(),
      undefined,
      fake.factory,
    );
    expect(fake.request.writes).toHaveLength(1);
    expect(fake.options()).toEqual({
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
    });
    expect(fake.socket.timeouts).toEqual([UPLOAD_CONNECT_TIMEOUT_MS]);
    fake.socket.emit('secureConnect');
    expect(fake.socket.timeouts).toEqual([UPLOAD_CONNECT_TIMEOUT_MS, UPLOAD_BODY_TIMEOUT_MS]);
  });

  it('refuses a redirect instead of following it', async () => {
    const fake = transport(307);
    await expect(
      putSignedMedia(new URL('https://uploads.example/object'), source(), undefined, fake.factory),
    ).rejects.toThrow(/refused a redirect/);
  });

  it('turns a connect or body timeout into an ambiguous transport failure after writing', async () => {
    const fake = transport(null);
    const pending = putSignedMedia(
      new URL('https://uploads.example/object'),
      source(),
      undefined,
      fake.factory,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.timeout();
    await expect(pending).rejects.toMatchObject({ ambiguous: true });
  });
});
