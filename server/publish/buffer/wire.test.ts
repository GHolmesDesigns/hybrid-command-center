import { describe, expect, it } from 'vitest';
import { resolveBufferOrganizationId } from '../buffer-accounts.ts';
import { BufferProviderError } from './error.ts';
import { BufferWriteError, UnavailableBufferWriteProvider } from './write-provider.ts';
import { bufferGraphqlRequest } from './transport.ts';
import {
  mapBufferChannel,
  parseBufferAccount,
  parseBufferChannel,
  parseBufferPost,
  parseBufferPostMutation,
  parseBufferPostsPage,
  parseBufferWritePost,
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

    expect(
      parseBufferPost({
        id: 'p2',
        text: 'b',
        status: 'scheduled',
        dueAt: '2030-01-01T00:00:00.000Z',
        channelId: 'c2',
      }),
    ).toMatchObject({ id: 'p2', dueAt: '2030-01-01T00:00:00.000Z' });
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

  it('drops raw provider errors at the parser boundary', () => {
    expect(
      parseBufferWritePost({
        id: 'post-1',
        channelId: 'channel-1',
        text: 'safe',
        status: 'failed',
        dueAt: null,
        allowedActions: ['editPost', 'futureAction'],
        error: {
          message: 'safe message',
          rawError: 'Authorization: Bearer should-never-escape',
          supportUrl: 'https://support.buffer.com/case/1',
        },
      }),
    ).toEqual({
      id: 'post-1',
      channelId: 'channel-1',
      text: 'safe',
      state: 'FAILED',
      dueAt: null,
      allowedActions: ['editPost'],
      error: 'safe message',
      supportUrl: 'https://support.buffer.com/case/1',
    });
  });

  it('normalizes every Buffer write state and defaults optional fields safely', () => {
    const post = (status: string, extra: Record<string, unknown> = {}) =>
      parseBufferWritePost({
        id: 'post-1',
        channelId: 'channel-1',
        text: 123,
        status,
        dueAt: null,
        ...extra,
      });
    expect(post('buffer')).toMatchObject({ state: 'SCHEDULED', text: '', allowedActions: [] });
    expect(post('approved').state).toBe('SCHEDULED');
    expect(post('draft').state).toBe('DRAFT');
    expect(post('approval_pending').state).toBe('DRAFT');
    expect(post('sent').state).toBe('PUBLISHED');
    expect(post('failed', { error: [], allowedActions: 'editPost' }).state).toBe('FAILED');
    expect(post('sending').state).toBe('PROCESSING');
  });

  it('classifies typed mutation refusals and rejects unknown members', () => {
    expect(() =>
      parseBufferPostMutation({ __typename: 'InvalidInputError', message: 'bad input' }),
    ).toThrow(/bad input/);
    expect(() =>
      parseBufferPostMutation({ __typename: 'LimitReachedError', message: 'quota' }),
    ).toThrow(/quota/);
    expect(() =>
      parseBufferPostMutation({ __typename: 'VoidMutationError', message: 'refused' }),
    ).toThrow(/refused/);
    expect(() => parseBufferPostMutation({ __typename: 'FutureResult' })).toThrow(
      /Unknown Buffer mutation result/,
    );
    expect(
      parseBufferPostMutation({
        __typename: 'PostActionSuccess',
        post: {
          id: 'post-1',
          channelId: 'channel-1',
          text: 'safe',
          status: 'buffer',
          dueAt: null,
          allowedActions: [],
        },
      }).id,
    ).toBe('post-1');
  });

  it('refuses malformed write evidence', () => {
    expect(() => parseBufferWritePost([])).toThrow(/not an object/);
    expect(() =>
      parseBufferWritePost({
        id: 'post',
        channelId: 'channel',
        status: 'buffer',
        dueAt: 123,
      }),
    ).toThrow(/dueAt/);
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

describe('unavailable Buffer writes', () => {
  it('refuses every write capability without widening into another provider', async () => {
    const provider = new UnavailableBufferWriteProvider('evidence missing');
    expect(provider.available).toBe(false);
    await expect(
      provider.create({
        channelId: 'channel',
        text: 'text',
        dueAt: '2099-01-01T00:00:00.000Z',
        mode: 'customScheduled',
        needsApproval: false,
        source: 'hybrid-command-center',
        assets: [],
      }),
    ).rejects.toBeInstanceOf(BufferWriteError);
    await expect(provider.read('post')).rejects.toThrow('evidence missing');
    await expect(provider.edit({ id: 'post', text: 'next' })).rejects.toThrow('evidence missing');
    await expect(provider.cancel('post')).rejects.toThrow('evidence missing');
  });
});
