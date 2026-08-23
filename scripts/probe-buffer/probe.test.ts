import { describe, expect, it } from 'vitest';
import type { BufferPage, BufferPost } from './client.ts';
import type { BufferProbeAsset } from './client.ts';
import type { BufferProbeConfig } from './config.ts';
import { runBufferProbe, type BufferProbeApi } from './probe.ts';

const config: BufferProbeConfig = {
  mode: 'live',
  apiKey: 'not-used',
  baseUrl: 'https://api.buffer.com',
  accountId: 'account_1',
  organizationId: 'org_1',
  scheduledAt: '2026-08-26T12:00:00Z',
  probeLabel: 'hcc-buffer-0826',
  channels: [
    { service: 'tiktok', id: 'tt_1' },
    { service: 'youtube', id: 'yt_1' },
  ],
  media: [{ service: 'tiktok', kind: 'image', url: 'https://static.example.com/probe.png' }],
};

class FakeClient implements BufferProbeApi {
  readonly budget = { used: 0, total: 50 };
  readonly posts = new Map<string, BufferPost>();
  readonly calls: string[] = [];
  failEdit = false;

  async account(): Promise<Record<string, unknown>> {
    this.calls.push('account');
    return { id: 'account_1', organizations: [{ id: 'org_1', name: 'Studio' }] };
  }
  async channels(): Promise<Record<string, unknown>[]> {
    this.calls.push('channels');
    return [
      { id: 'tt_1', name: 'TikTok', service: 'tiktok' },
      { id: 'yt_1', name: 'YouTube', service: 'youtube' },
    ];
  }
  async create(channelId: string, text: string, dueAt: string, asset?: BufferProbeAsset) {
    this.calls.push(`create:${channelId}:${asset?.kind ?? 'text'}`);
    const post = {
      id: `post_${channelId}`,
      text,
      status: 'scheduled',
      dueAt,
      channelId,
    };
    this.posts.set(post.id, post);
    return post;
  }
  async read(id: string) {
    this.calls.push(`read:${id}`);
    const post = this.posts.get(id);
    if (!post) throw new Error('not found');
    return post;
  }
  async edit(id: string, text: string) {
    this.calls.push(`edit:${id}`);
    if (this.failEdit) throw new Error('edit refused');
    const post = await this.read(id);
    const edited = { ...post, text };
    this.posts.set(id, edited);
    return edited;
  }
  async delete(id: string) {
    this.calls.push(`delete:${id}`);
    this.posts.delete(id);
    return id;
  }
  async list(): Promise<BufferPage> {
    this.calls.push('list');
    return { posts: [...this.posts.values()], hasNextPage: false, endCursor: null };
  }
}

describe('Buffer live probe', () => {
  it('creates one post per approved channel, reads, edits, deletes, and proves absence', async () => {
    const client = new FakeClient();
    const result = await runBufferProbe({ client, config });
    expect(result).toMatchObject({
      created: ['post_tt_1', 'post_yt_1'],
      deleted: ['post_yt_1', 'post_tt_1'],
      leftovers: [],
    });
    expect(result.stopped).toBeUndefined();
    expect(result.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: expect.stringContaining('one remote post per channel'),
          state: 'verified',
        }),
        expect.objectContaining({
          claim: expect.stringContaining('proven by absence'),
          state: 'verified',
        }),
      ]),
    );
    expect(client.posts.size).toBe(0);
    expect(client.calls).toContain('create:tt_1:image');
    expect(client.calls).toContain('create:yt_1:text');
  });

  it('runs cleanup in finally when an edit fails', async () => {
    const client = new FakeClient();
    client.failEdit = true;
    const result = await runBufferProbe({ client, config });
    expect(result.stopped).toContain('edit refused');
    expect(result.created).toEqual(['post_tt_1']);
    expect(result.deleted).toEqual(['post_tt_1']);
    expect(result.leftovers).toEqual([]);
    expect(client.posts.size).toBe(0);
  });

  it('stops before writes when the connected channel set differs', async () => {
    const client = new FakeClient();
    client.channels = async () => [{ id: 'different', name: 'Other TikTok', service: 'tiktok' }];
    const result = await runBufferProbe({ client, config });
    expect(result.stopped).toContain('differs from the approved ids');
    expect(result.created).toEqual([]);
    expect(client.calls.some((call) => call.startsWith('create:'))).toBe(false);
  });

  it('stops before writes when the account or organization differs', async () => {
    const wrongAccount = new FakeClient();
    wrongAccount.account = async () => ({
      id: 'someone_else',
      organizations: [{ id: 'org_1' }],
    });
    expect((await runBufferProbe({ client: wrongAccount, config })).stopped).toContain(
      'differs from the approved account id',
    );

    const wrongOrganization = new FakeClient();
    wrongOrganization.account = async () => ({
      id: 'account_1',
      organizations: [{ id: 'other' }],
    });
    expect((await runBufferProbe({ client: wrongOrganization, config })).stopped).toContain(
      'approved organization is not present',
    );
  });

  it('refuses a reused label before creating anything', async () => {
    const client = new FakeClient();
    client.posts.set('existing', {
      id: 'existing',
      text: 'hcc-buffer-0826 already used',
      status: 'scheduled',
      dueAt: config.scheduledAt,
      channelId: 'tt_1',
    });
    const result = await runBufferProbe({ client, config });
    expect(result.stopped).toContain('already present');
    expect(result.created).toEqual([]);
  });

  it('stops when create, read, edit, or edit readback disagrees', async () => {
    const scenarios: Array<(client: FakeClient) => void> = [
      (client) => {
        const original = client.create.bind(client);
        client.create = async (...args) => ({ ...(await original(...args)), channelId: 'wrong' });
      },
      (client) => {
        const original = client.read.bind(client);
        let reads = 0;
        client.read = async (...args) => {
          const value = await original(...args);
          reads += 1;
          return reads === 1 ? { ...value, text: 'wrong' } : value;
        };
      },
      (client) => {
        const original = client.edit.bind(client);
        client.edit = async (...args) => ({ ...(await original(...args)), id: 'wrong' });
      },
      (client) => {
        const original = client.read.bind(client);
        let reads = 0;
        client.read = async (...args) => {
          const value = await original(...args);
          reads += 1;
          return reads === 3 ? { ...value, text: 'wrong after edit' } : value;
        };
      },
    ];
    for (const alter of scenarios) {
      const client = new FakeClient();
      alter(client);
      const result = await runBufferProbe({ client, config });
      expect(result.stopped).toBeDefined();
      expect(result.deleted).toEqual(['post_tt_1']);
      expect(result.leftovers).toEqual([]);
    }
  });

  it('reports delete ambiguity and a post that remains after cleanup', async () => {
    const client = new FakeClient();
    client.failEdit = true;
    client.delete = async () => {
      throw new Error('delete refused');
    };
    const result = await runBufferProbe({ client, config });
    expect(result.leftovers.join('\n')).toMatch(/delete refused/);
    expect(result.leftovers.join('\n')).toMatch(/present in complete paginated read/);
    expect(result.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          claim: expect.stringContaining('proven by absence'),
          state: 'negative',
        }),
      ]),
    );
  });

  it('reports a mismatched delete id and an inconclusive absence read', async () => {
    const client = new FakeClient();
    client.failEdit = true;
    client.delete = async (id) => {
      client.posts.delete(id);
      return 'different';
    };
    let lists = 0;
    const originalList = client.list.bind(client);
    client.list = async (...args) => {
      lists += 1;
      if (lists > 1) throw new Error('inventory unavailable');
      return originalList(...args);
    };
    const result = await runBufferProbe({ client, config });
    expect(result.leftovers.join('\n')).toMatch(/different post id/);
    expect(result.leftovers.join('\n')).toMatch(/absence check: inventory unavailable/);
    expect(result.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'still unverified',
          evidence: expect.stringContaining('did not finish'),
        }),
      ]),
    );
  });

  it('refuses repeated pagination cursors', async () => {
    const client = new FakeClient();
    client.list = async () => ({ posts: [], hasNextPage: true, endCursor: 'same' });
    const result = await runBufferProbe({ client, config });
    expect(result.stopped).toContain('repeated or omitted');
  });

  it('refuses an inventory beyond the 20-page safety bound', async () => {
    const client = new FakeClient();
    let page = 0;
    client.list = async () => ({
      posts: [],
      hasNextPage: true,
      endCursor: `cursor_${page++}`,
    });
    const result = await runBufferProbe({ client, config });
    expect(result.stopped).toContain('exceeded the 20-page safety bound');
  });
});
