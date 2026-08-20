import { describe, expect, it } from 'vitest';
import {
  analyticsRequest,
  createPostRequest,
  createUploadUrlRequest,
  deleteMediaRequest,
  deletePostRequest,
  encodeAccountConfigurations,
  encodeRepeatable,
  getMediaRequest,
  getPostRequest,
  listPostsRequest,
  listSocialAccountsRequest,
  probePostBody,
  PROBE_MIME_TYPES,
  updatePostRequest,
} from './requests.ts';

const SCHEDULED = '2026-08-25T14:00:00.000Z';

describe('encodeRepeatable', () => {
  it('spells the same values both of the two ways the API could mean', () => {
    expect(encodeRepeatable('status', ['scheduled', 'draft'], 'bracket')).toEqual([
      'status%5B%5D=scheduled',
      'status%5B%5D=draft',
    ]);
    expect(encodeRepeatable('status', ['scheduled', 'draft'], 'repeat')).toEqual([
      'status=scheduled',
      'status=draft',
    ]);
  });

  it('encodes the value, so a platform key with an underscore or a space cannot break the query', () => {
    expect(encodeRepeatable('platform', ['google business'], 'repeat')).toEqual([
      'platform=google%20business',
    ]);
  });

  it('is empty for no values, so no stray separator reaches the path', () => {
    expect(encodeRepeatable('status', [], 'bracket')).toEqual([]);
  });
});

describe('list requests', () => {
  it('always sends an explicit limit, because the endpoints default to ten', () => {
    expect(listSocialAccountsRequest()).toEqual({
      method: 'GET',
      path: '/social-accounts?limit=100',
    });
    expect(listPostsRequest({ limit: 100, offset: 0 }).path).toBe('/posts?limit=100&offset=0');
  });

  it('adds the repeatable filters in the requested style and nothing else', () => {
    expect(
      listPostsRequest({ limit: 5, offset: 0, status: ['scheduled'], style: 'bracket' }).path,
    ).toBe('/posts?limit=5&offset=0&status%5B%5D=scheduled');
    expect(
      listPostsRequest({ limit: 5, offset: 0, status: ['scheduled'], style: 'repeat' }).path,
    ).toBe('/posts?limit=5&offset=0&status=scheduled');
    expect(
      listPostsRequest({ limit: 5, offset: 10, platform: ['linkedin', 'youtube'], style: 'repeat' })
        .path,
    ).toBe('/posts?limit=5&offset=10&platform=linkedin&platform=youtube');
  });

  it('encodes an id into a path rather than concatenating it', () => {
    expect(getPostRequest('a/b').path).toBe('/posts/a%2Fb');
    expect(deletePostRequest('a b').path).toBe('/posts/a%20b');
    expect(getMediaRequest('m/1').path).toBe('/media/m%2F1');
    expect(deleteMediaRequest('m 1').path).toBe('/media/m%201');
    expect(deletePostRequest('p1').method).toBe('DELETE');
  });
});

describe('probePostBody', () => {
  it('sends the caption, the instant, and the accounts, and nothing it was not given', () => {
    expect(
      probePostBody({ caption: 'hello', scheduledAt: SCHEDULED, accountIds: [101, 102] }),
    ).toEqual({
      caption: 'hello',
      scheduled_at: SCHEDULED,
      social_accounts: [101, 102],
    });
  });

  it('refuses to build a request with no instant, because omitting it publishes immediately', () => {
    expect(() => probePostBody({ caption: 'x', scheduledAt: '', accountIds: [1] })).toThrow(
      /explicit scheduled_at/,
    );
  });

  it('refuses to build a request with no account, because there is no default', () => {
    expect(() => probePostBody({ caption: 'x', scheduledAt: SCHEDULED, accountIds: [] })).toThrow(
      /names its accounts explicitly/,
    );
  });

  it('carries both media keys when a caller means to ask which one wins', () => {
    const body = probePostBody({
      caption: 'x',
      scheduledAt: SCHEDULED,
      accountIds: [1],
      mediaIds: ['m1'],
      mediaUrls: ['https://probe.invalid/x.png'],
    });
    expect(body.media).toEqual(['m1']);
    expect(body.media_urls).toEqual(['https://probe.invalid/x.png']);
  });

  it('passes platform configurations through under the vendor’s key', () => {
    const body = probePostBody({
      caption: 'x',
      scheduledAt: SCHEDULED,
      accountIds: [1],
      platformConfigurations: { linkedin: { document_title: 'Probe' } },
    });
    expect(body.platform_configurations).toEqual({ linkedin: { document_title: 'Probe' } });
  });
});

describe('encodeAccountConfigurations', () => {
  const configurations = [
    { accountId: 101, caption: 'one' },
    { accountId: 102, caption: 'two', mediaIds: ['m1'] },
  ];

  it('writes the list form as objects each carrying account_id', () => {
    expect(encodeAccountConfigurations(configurations, 'list')).toEqual([
      { account_id: 101, caption: 'one' },
      { account_id: 102, caption: 'two', media: ['m1'] },
    ]);
  });

  it('writes the keyed form without repeating the id inside the value', () => {
    expect(encodeAccountConfigurations(configurations, 'keyed')).toEqual({
      '101': { caption: 'one' },
      '102': { caption: 'two', media: ['m1'] },
    });
  });

  it('omits a field that was not given rather than sending an empty one', () => {
    expect(encodeAccountConfigurations([{ accountId: 1 }], 'list')).toEqual([{ account_id: 1 }]);
  });
});

describe('create and update', () => {
  it('posts to /posts and patches the id, both with the whole body', () => {
    const input = {
      caption: 'x',
      scheduledAt: SCHEDULED,
      accountIds: [101, 102],
      accountConfigurations: [
        { accountId: 101, caption: 'one' },
        { accountId: 102, caption: 'two' },
      ],
    };
    expect(createPostRequest(input)).toEqual({
      method: 'POST',
      path: '/posts',
      body: {
        caption: 'x',
        scheduled_at: SCHEDULED,
        social_accounts: [101, 102],
        account_configurations: [
          { account_id: 101, caption: 'one' },
          { account_id: 102, caption: 'two' },
        ],
      },
    });
    const update = updatePostRequest('p1', input);
    expect(update.method).toBe('PATCH');
    expect(update.path).toBe('/posts/p1');
    // The whole body again, `scheduled_at` included: the vendor processes a post immediately when a
    // PATCH omits it, so there is no shape of this request that leaves the instant to a default.
    expect(update.body).toEqual(createPostRequest(input).body);
  });
});

describe('media requests', () => {
  it('sends all three documented fields, under the vendor’s names', () => {
    expect(
      createUploadUrlRequest({ name: 'probe-image.png', mimeType: 'image/png', sizeBytes: 136 }),
    ).toEqual({
      method: 'POST',
      path: '/media/create-upload-url',
      body: { name: 'probe-image.png', mime_type: 'image/png', size_bytes: 136 },
    });
  });

  it('knows the five documented types and no others', () => {
    expect(PROBE_MIME_TYPES).toEqual([
      'image/png',
      'image/jpeg',
      'video/mp4',
      'video/quicktime',
      'application/pdf',
    ]);
  });
});

describe('analyticsRequest', () => {
  it('always sends limit and offset', () => {
    expect(analyticsRequest({ limit: 5, offset: 0 }).path).toBe('/analytics?limit=5&offset=0');
  });

  it('repeats post_result_id and sends the two single-valued filters plainly', () => {
    expect(analyticsRequest({ limit: 5, offset: 0, postResultIds: ['r1', 'r2'] }).path).toBe(
      '/analytics?limit=5&offset=0&post_result_id=r1&post_result_id=r2',
    );
    expect(
      analyticsRequest({ limit: 5, offset: 0, platform: 'instagram', timeframe: '7d' }).path,
    ).toBe('/analytics?limit=5&offset=0&platform=instagram&timeframe=7d');
  });
});
