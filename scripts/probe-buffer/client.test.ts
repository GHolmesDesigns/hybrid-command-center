import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestBudget } from '../probe-post-bridge/budget.ts';
import {
  BufferProbeClient,
  BufferProbeError,
  fetchBufferTransport,
  type BufferTransport,
} from './client.ts';

const response =
  (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  async () => ({ status, headers, body });

afterEach(() => vi.unstubAllGlobals());

describe('Buffer GraphQL probe client', () => {
  it('sends the bearer key without serializing it into the GraphQL body', async () => {
    let request: Parameters<BufferTransport>[0] | undefined;
    const transport: BufferTransport = async (input) => {
      request = input;
      return {
        status: 200,
        headers: { RateLimit: '"100-in-15min";r=99;t=800' },
        body: { data: { account: { id: 'account_1', organizations: [] } } },
      };
    };
    const client = new BufferProbeClient({
      apiKey: 'buffer-secret',
      baseUrl: 'https://api.buffer.com',
      transport,
    });
    await client.account();
    expect(request?.headers.authorization).toBe('Bearer buffer-secret');
    expect(request?.body).not.toContain('buffer-secret');
  });

  it('reads create success and spends one request', async () => {
    const budget = new RequestBudget(10, 2);
    const client = new BufferProbeClient({
      apiKey: 'key',
      baseUrl: 'https://api.buffer.com',
      budget,
      transport: response({
        data: {
          createPost: {
            __typename: 'PostActionSuccess',
            post: {
              id: 'post_1',
              text: 'probe',
              status: 'scheduled',
              dueAt: '2026-08-26T12:00:00Z',
              channelId: 'channel_1',
            },
          },
        },
      }),
    });
    await expect(
      client.create('channel_1', 'probe', '2026-08-26T12:00:00Z'),
    ).resolves.toMatchObject({
      id: 'post_1',
      status: 'scheduled',
    });
    expect(budget.used).toBe(1);
  });

  it('fails closed on typed mutation errors', async () => {
    const client = new BufferProbeClient({
      apiKey: 'key',
      baseUrl: 'https://api.buffer.com',
      transport: response({
        data: { createPost: { __typename: 'InvalidInputError', message: 'Invalid channel' } },
      }),
    });
    await expect(client.create('bad', 'probe', '2026-08-26T12:00:00Z')).rejects.toMatchObject({
      kind: 'typed',
      message: expect.stringContaining('InvalidInputError'),
    });
  });

  it('maps channels, read, edit, delete, and paginated list operations', async () => {
    const bodies = [
      { data: { channels: [{ id: 'tt_1', name: 'TikTok', service: 'tiktok' }] } },
      {
        data: {
          post: {
            id: 'post_1',
            text: 'probe',
            status: 'scheduled',
            dueAt: null,
            channelId: 'tt_1',
          },
        },
      },
      {
        data: {
          editPost: {
            __typename: 'PostActionSuccess',
            post: {
              id: 'post_1',
              text: 'edited',
              status: 'scheduled',
              dueAt: null,
              channelId: 'tt_1',
            },
          },
        },
      },
      { data: { deletePost: { __typename: 'DeletePostSuccess', id: 'post_1' } } },
      {
        data: {
          posts: {
            edges: [
              {
                node: {
                  id: 'post_2',
                  text: 'next',
                  status: 'sent',
                  dueAt: '2026-08-20T12:00:00Z',
                  channelId: 'yt_1',
                },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'cursor_1' },
          },
        },
      },
    ];
    const client = new BufferProbeClient({
      apiKey: 'key',
      baseUrl: 'https://api.buffer.com',
      transport: async () => ({ status: 200, headers: {}, body: bodies.shift() }),
    });
    await expect(client.channels('org_1')).resolves.toHaveLength(1);
    await expect(client.read('post_1')).resolves.toMatchObject({ id: 'post_1', dueAt: null });
    await expect(client.edit('post_1', 'edited')).resolves.toMatchObject({ text: 'edited' });
    await expect(client.delete('post_1')).resolves.toBe('post_1');
    await expect(client.list('org_1', null)).resolves.toMatchObject({
      hasNextPage: true,
      endCursor: 'cursor_1',
      posts: [expect.objectContaining({ id: 'post_2' })],
    });
  });

  it('fails closed on HTTP errors and keeps only allowlisted headers', async () => {
    const client = new BufferProbeClient({
      apiKey: 'key',
      baseUrl: 'https://api.buffer.com',
      transport: response({ message: 'Gateway refused Authorization: Bearer hidden' }, 503, {
        'Retry-After': '12',
        'Set-Cookie': 'secret=cookie',
      }),
    });
    await expect(client.account()).rejects.toMatchObject({
      kind: 'http',
      headers: { 'retry-after': '12' },
      message: expect.not.stringContaining('hidden'),
    });
  });

  it('refuses malformed envelopes, posts, pages, cursors, channels, and delete payloads', async () => {
    const cases: Array<{
      body: unknown;
      call: (client: BufferProbeClient) => Promise<unknown>;
      message: RegExp;
    }> = [
      { body: [], call: (client) => client.account(), message: /response is not an object/ },
      { body: { data: [] }, call: (client) => client.account(), message: /data is not an object/ },
      {
        body: { data: { account: null } },
        call: (client) => client.account(),
        message: /account is not an object/,
      },
      {
        body: { data: { channels: {} } },
        call: (client) => client.channels('org'),
        message: /channels is not a list/,
      },
      {
        body: { data: { post: { id: 'only-id' } } },
        call: (client) => client.read('post'),
        message: /unreadable identity or state/,
      },
      {
        body: { data: { deletePost: { __typename: 'VoidMutationError', message: 'No' } } },
        call: (client) => client.delete('post'),
        message: /VoidMutationError/,
      },
      {
        body: { data: { posts: { edges: {}, pageInfo: { hasNextPage: false } } } },
        call: (client) => client.list('org', null),
        message: /page is unreadable/,
      },
      {
        body: {
          data: { posts: { edges: [], pageInfo: { hasNextPage: true, endCursor: 4 } } },
        },
        call: (client) => client.list('org', null),
        message: /endCursor/,
      },
    ];
    for (const item of cases) {
      const client = new BufferProbeClient({
        apiKey: 'key',
        baseUrl: 'https://api.buffer.com',
        transport: response(item.body),
      });
      await expect(item.call(client)).rejects.toThrow(item.message);
    }
  });

  it('records safe rate-limit headers on GraphQL system errors', async () => {
    const client = new BufferProbeClient({
      apiKey: 'key',
      baseUrl: 'https://api.buffer.com',
      transport: response(
        {
          errors: [
            {
              message: 'Too many requests api_key=do-not-print',
              extensions: { code: 'RATE_LIMIT_EXCEEDED', window: '15m' },
            },
          ],
        },
        200,
        { 'Retry-After': '90', Authorization: 'Bearer do-not-print' },
      ),
    });
    let caught: unknown;
    try {
      await client.account();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BufferProbeError);
    expect(caught).toMatchObject({
      kind: 'graphql',
      headers: { 'retry-after': '90' },
      message: expect.not.stringContaining('do-not-print'),
    });
  });

  it('adapts fetch responses and treats a non-JSON body as an empty shape', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { account: { id: 'a' } } }), {
          status: 200,
          headers: { RateLimit: 'remaining' },
        }),
      )
      .mockResolvedValueOnce(new Response('not-json', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);
    const transport = fetchBufferTransport();
    await expect(
      transport({
        url: 'https://api.buffer.com',
        headers: { authorization: 'Bearer key' },
        body: '{}',
      }),
    ).resolves.toMatchObject({
      status: 200,
      headers: { ratelimit: 'remaining' },
      body: { data: { account: { id: 'a' } } },
    });
    await expect(
      transport({ url: 'https://api.buffer.com', headers: {}, body: '{}' }),
    ).resolves.toMatchObject({ status: 502, body: {} });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.buffer.com',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});
