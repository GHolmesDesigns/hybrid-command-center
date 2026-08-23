import { describe, expect, it } from 'vitest';
import { resolveBufferOrganizationId } from '../buffer-accounts.ts';
import { BufferProviderError } from './error.ts';
import { bufferGraphqlRequest } from './transport.ts';
import {
  mapBufferChannel,
  parseBufferAccount,
  parseBufferChannel,
  parseBufferPostsPage,
} from './wire.ts';

describe('buffer wire parsers', () => {
  it('parses account, channel, and post shapes', () => {
    expect(
      parseBufferAccount({
        id: 'acct',
        organizations: [{ id: 'org-1', name: 'Studio' }],
      }),
    ).toEqual({ id: 'acct', organizations: [{ id: 'org-1', name: 'Studio' }] });

    const channel = parseBufferChannel({
      id: 'ch-tiktok',
      name: '@studio',
      service: 'tiktok',
      isDisconnected: false,
      isLocked: false,
      isQueuePaused: false,
    });
    expect(mapBufferChannel(channel)).toMatchObject({ platform: 'tiktok' });
    expect(
      mapBufferChannel({
        ...channel,
        service: 'pinterest',
      }),
    ).toBeUndefined();
    expect(
      mapBufferChannel({
        ...channel,
        isQueuePaused: true,
      })?.unavailable,
    ).toBe('Queue paused in Buffer');

    expect(
      parseBufferPostsPage({
        edges: [
          { node: { id: 'p1', text: 'a', status: 'scheduled', dueAt: null, channelId: 'c1' } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      }).posts,
    ).toHaveLength(1);
  });

  it('refuses HTTP failures and GraphQL errors inside HTTP 200', async () => {
    await expect(
      bufferGraphqlRequest(async () => ({ status: 401, headers: {}, body: { message: 'nope' } }), {
        apiKey: 'key',
        baseUrl: 'https://api.buffer.com',
        query: 'q',
        variables: {},
      }),
    ).rejects.toBeInstanceOf(BufferProviderError);

    await expect(
      bufferGraphqlRequest(
        async () => ({
          status: 200,
          headers: {},
          body: { errors: [{ message: 'bad key', extensions: { code: 'UNAUTHORIZED' } }] },
        }),
        { apiKey: 'key', baseUrl: 'https://api.buffer.com', query: 'q', variables: {} },
      ),
    ).rejects.toThrow(/GraphQL error/);
  });
});

describe('buffer organization resolution', () => {
  it('requires an explicit organization when several exist', () => {
    expect(() => resolveBufferOrganizationId([{ id: 'a' }, { id: 'b' }])).toThrow(
      /BUFFER_ORGANIZATION_ID/,
    );
  });

  it('accepts the configured organization id', () => {
    expect(resolveBufferOrganizationId([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b');
  });
});

describe('buffer graphql transport', () => {
  it('maps HTTP 429 to rate-limit metadata without logging secrets', async () => {
    await expect(
      bufferGraphqlRequest(
        async () => ({
          status: 429,
          headers: { 'retry-after': '45' },
          body: { message: 'Bearer secret-token' },
        }),
        { apiKey: 'key', baseUrl: 'https://api.buffer.com', query: 'q', variables: {} },
      ),
    ).rejects.toMatchObject({ rateLimited: true, retryAfterSeconds: 45 });
  });
});
