import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferProviderError } from './error.ts';
import { bufferGraphqlRequest, fetchBufferTransport } from './transport.ts';

afterEach(() => vi.unstubAllGlobals());

describe('fetchBufferTransport', () => {
  it('posts the request and adapts a JSON response', async () => {
    const headers = new Map([['ratelimit-remaining', '9']]);
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: { forEach: (fn: (value: string, name: string) => void) => headers.forEach(fn) },
      json: async () => ({ data: { ok: true } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const transport = fetchBufferTransport();
    const result = await transport({
      url: 'https://api.example.com/graphql',
      headers: { authorization: 'Bearer key' },
      body: '{"query":"{}"}',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/graphql',
      expect.objectContaining({ method: 'POST', body: '{"query":"{}"}' }),
    );
    expect(result).toEqual({
      status: 200,
      headers: { 'ratelimit-remaining': '9' },
      body: { data: { ok: true } },
    });
  });

  it('treats a body that does not parse as JSON as empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 502,
        headers: { forEach: () => {} },
        json: async () => {
          throw new Error('not JSON');
        },
      }),
    );
    const transport = fetchBufferTransport();
    const result = await transport({ url: 'https://api.example.com', headers: {}, body: '{}' });
    expect(result).toEqual({ status: 502, headers: {}, body: {} });
  });
});

describe('bufferGraphqlRequest', () => {
  const input = {
    apiKey: 'key',
    baseUrl: 'https://api.example.com',
    query: '{}',
    variables: {},
  };

  it('wraps a transport failure as ambiguous when told the write may have landed', async () => {
    const transport = async () => {
      throw new Error('socket hang up');
    };
    await expect(
      bufferGraphqlRequest(transport, { ...input, ambiguousOnTransport: true }),
    ).rejects.toMatchObject({ message: 'socket hang up', ambiguous: true });
  });

  it('defaults to not ambiguous when the caller does not say otherwise', async () => {
    const transport = async () => {
      throw new Error('socket hang up');
    };
    await expect(bufferGraphqlRequest(transport, input)).rejects.toMatchObject({
      ambiguous: false,
    });
  });

  it('returns the response data on a clean success', async () => {
    const transport = async () => ({
      status: 200,
      headers: {},
      body: { data: { ok: true } },
    });
    await expect(bufferGraphqlRequest(transport, input)).resolves.toEqual({ ok: true });
  });

  it('refuses a data envelope that is not an object', async () => {
    const transport = async () => ({ status: 200, headers: {}, body: { data: 'nope' } });
    await expect(bufferGraphqlRequest(transport, input)).rejects.toBeInstanceOf(
      BufferProviderError,
    );
  });
});
