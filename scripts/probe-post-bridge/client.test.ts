import { describe, expect, it } from 'vitest';
import { ProbeBudgetExhaustedError, RequestBudget } from './budget.ts';
import {
  ProbeClient,
  ProbeStopError,
  ProbeTransportError,
  type ProbeHttpRequest,
  type ProbeHttpResponse,
} from './client.ts';

const BASE = 'https://api.example.test/v1';

function recorder(response: Partial<ProbeHttpResponse> = {}) {
  const sent: ProbeHttpRequest[] = [];
  const client = new ProbeClient({
    apiKey: 'pb_live_secret',
    baseUrl: BASE,
    budget: new RequestBudget(10, 2),
    transport: async (request) => {
      sent.push(request);
      return { status: 200, headers: {}, body: {}, ...response };
    },
  });
  return { client, sent };
}

describe('ProbeClient construction', () => {
  it('needs a key and an https base URL', () => {
    const budget = new RequestBudget();
    const transport = async () => ({ status: 200, headers: {}, body: {} });
    expect(() => new ProbeClient({ apiKey: '', baseUrl: BASE, budget, transport })).toThrow();
    expect(
      () =>
        new ProbeClient({ apiKey: 'k', baseUrl: 'http://api.example.test/v1', budget, transport }),
    ).toThrow(/must be https/);
  });

  it('tolerates a trailing slash on the base URL rather than doubling it', async () => {
    const sent: ProbeHttpRequest[] = [];
    const client = new ProbeClient({
      apiKey: 'k',
      baseUrl: `${BASE}/`,
      budget: new RequestBudget(),
      transport: async (request) => {
        sent.push(request);
        return { status: 200, headers: {}, body: {} };
      },
    });
    await client.api('posts', { method: 'GET', path: '/posts' });
    expect(sent[0].url).toBe(`${BASE}/posts`);
  });
});

describe('api', () => {
  it('sends the bearer token and JSON, and serializes the body once', async () => {
    const { client, sent } = recorder();
    await client.api('create', { method: 'POST', path: '/posts', body: { caption: 'x' } });
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe(`${BASE}/posts`);
    expect(sent[0].headers.Authorization).toBe('Bearer pb_live_secret');
    expect(sent[0].headers['Content-Type']).toBe('application/json');
    expect(sent[0].body).toBe('{"caption":"x"}');
  });

  it('sends no body at all for a request that has none', async () => {
    const { client, sent } = recorder();
    await client.api('list', { method: 'GET', path: '/posts' });
    expect(sent[0].body).toBeUndefined();
  });

  it('reports a refusal rather than throwing, so a step can record it as evidence', async () => {
    const { client } = recorder({ status: 400, body: { message: 'no' } });
    const result = await client.api('create', { method: 'POST', path: '/posts' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ message: 'no' });
  });

  it('spends the budget before the call and refuses when it is gone', async () => {
    const budget = new RequestBudget(3, 2);
    const sent: ProbeHttpRequest[] = [];
    const client = new ProbeClient({
      apiKey: 'k',
      baseUrl: BASE,
      budget,
      transport: async (request) => {
        sent.push(request);
        return { status: 200, headers: {}, body: {} };
      },
    });
    await client.api('one', { method: 'GET', path: '/posts' });
    await expect(client.api('two', { method: 'GET', path: '/posts' })).rejects.toThrow(
      ProbeBudgetExhaustedError,
    );
    // The refused question never reached the transport, and teardown still has its reserve.
    expect(sent).toHaveLength(1);
    await expect(
      client.api('cleanup', { method: 'DELETE', path: '/posts/1' }, { teardown: true }),
    ).resolves.toBeDefined();
  });

  it('records a 429 and then stops the run, rather than waiting it out', async () => {
    const { client } = recorder({ status: 429, headers: { 'Retry-After': '60' } });
    await expect(client.api('sync', { method: 'GET', path: '/analytics' })).rejects.toThrow(
      ProbeStopError,
    );
    expect(client.rateLimits).toHaveLength(1);
    expect(client.rateLimits[0].headers).toEqual({ 'retry-after': '60' });
  });

  it('scrubs a transport failure that quotes the URL, and still logs the attempt', async () => {
    const client = new ProbeClient({
      apiKey: 'pb_live_secret',
      baseUrl: BASE,
      budget: new RequestBudget(),
      transport: async () => {
        throw new Error(
          'connect failed for https://api.example.test/v1/posts?api_key=pb_live_secret',
        );
      },
    });
    await expect(client.api('create', { method: 'POST', path: '/posts' })).rejects.toThrow(
      ProbeTransportError,
    );
    const failure = await client
      .api('create', { method: 'POST', path: '/posts' })
      .catch((error: Error) => error.message);
    expect(failure).not.toContain('pb_live_secret');
    expect(client.calls.map((call) => call.status)).toEqual([0, 0]);
  });
});

describe('the call log', () => {
  it('holds no query string, no request body, and no response body', async () => {
    const { client } = recorder({ headers: { 'Set-Cookie': 'session=abc' } });
    await client.api('list', { method: 'GET', path: '/posts?limit=100&offset=0' });
    expect(client.calls).toEqual([
      {
        label: 'list',
        method: 'GET',
        url: `${BASE}/posts?[redacted]`,
        status: 200,
        headers: {},
        teardown: false,
      },
    ]);
  });

  it('marks a teardown call as one, so a reader can tell cleanup from questions', async () => {
    const { client } = recorder();
    await client.api('cleanup', { method: 'DELETE', path: '/posts/1' }, { teardown: true });
    expect(client.calls[0].teardown).toBe(true);
  });
});

describe('upload', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const signed = 'https://storage.example.test/bucket/object?X-Amz-Signature=deadbeef';

  it('never sends the API key to the storage host', async () => {
    const { client, sent } = recorder();
    await client.upload('image', { uploadUrl: signed, mimeType: 'image/png', bytes });
    expect(sent[0].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(sent[0].headers)).not.toContain('pb_live_secret');
  });

  it('sends the bytes with an explicit content type and length', async () => {
    const { client, sent } = recorder();
    await client.upload('image', { uploadUrl: signed, mimeType: 'image/png', bytes });
    expect(sent[0].method).toBe('PUT');
    expect(sent[0].headers['Content-Type']).toBe('image/png');
    expect(sent[0].headers['Content-Length']).toBe('4');
    expect(sent[0].body).toBe(bytes);
  });

  it('keeps the signature out of the log', async () => {
    const { client } = recorder();
    await client.upload('image', { uploadUrl: signed, mimeType: 'image/png', bytes });
    expect(client.calls[0].url).toBe('https://storage.example.test/bucket/object?[redacted]');
  });

  it('refuses an upload URL that is not https, carries credentials, has a fragment, or is not a URL', async () => {
    const { client, sent } = recorder();
    for (const url of [
      'http://storage.example.test/object',
      'https://user:pass@storage.example.test/object',
      'https://storage.example.test/object#part',
      'storage.example.test/object',
    ])
      await expect(
        client.upload('image', { uploadUrl: url, mimeType: 'image/png', bytes }),
      ).rejects.toThrow(ProbeStopError);
    // None of them spent a request, and none of them sent a byte.
    expect(sent).toHaveLength(0);
    expect(client.budget.used).toBe(0);
  });

  it('records a 429 from storage and stops', async () => {
    const { client } = recorder({ status: 429, headers: { 'retry-after': '5' } });
    await expect(
      client.upload('image', { uploadUrl: signed, mimeType: 'image/png', bytes }),
    ).rejects.toThrow(ProbeStopError);
    expect(client.rateLimits).toHaveLength(1);
  });

  it('scrubs a failed upload’s message and logs the attempt', async () => {
    const client = new ProbeClient({
      apiKey: 'pb_live_secret',
      baseUrl: BASE,
      budget: new RequestBudget(),
      transport: async () => {
        throw new Error(`socket hang up for ${signed}`);
      },
    });
    const failure = await client
      .upload('image', { uploadUrl: signed, mimeType: 'image/png', bytes })
      .catch((error: Error) => error.message);
    expect(failure).not.toContain('deadbeef');
    expect(client.calls[0].url).toBe('https://storage.example.test/bucket/object?[redacted]');
  });

  it('spends from the questions’ share, never from the teardown reserve', async () => {
    const { client } = recorder();
    await client.upload('image', { uploadUrl: signed, mimeType: 'image/png', bytes });
    expect(client.budget.used).toBe(1);
    expect(client.calls[0].teardown).toBe(false);
  });
});
