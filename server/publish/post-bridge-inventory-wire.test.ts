import { describe, expect, it } from 'vitest';
import {
  parsePostBridgeInventoryPage,
  parsePostBridgeInventoryRow,
  postBridgeInventoryPath,
  postBridgeRecordState,
} from './post-bridge-inventory-wire.ts';
import { PublishProviderError } from './provider.ts';
import { PROVIDER_INVENTORY_CAPTION_MAX } from '../../shared/provider-inventory.ts';

/**
 * `GET /v1/posts` against mocked responses, which is the only way this can be tested at all: the
 * live adapter is `fetch` and a bearer token, so what a page *means* has to be decided here.
 *
 * The row fixture is the shape C73 read out of a live response
 * (`docs/post-bridge-api-surface.md` §14, question 4), field for field, so a case here is a claim
 * about the provider rather than about a shape this app imagined.
 */

/** The row shape §14 recorded, verbatim in its field names. */
const listedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'remote-1',
  caption: 'Scheduled straight in Post Bridge',
  created_at: '2026-08-18T09:00:00.000Z',
  updated_at: '2026-08-18T09:05:00.000Z',
  is_draft: false,
  status: 'scheduled',
  scheduled_at: '2026-08-20T13:00:00.000Z',
  social_accounts: [901],
  media: ['https://example.com/a.png'],
  account_configurations: null,
  platform_configurations: null,
  ...overrides,
});

const page = (rows: unknown[], next: unknown = null) => ({
  data: rows,
  meta: { total: rows.length, offset: 0, limit: 100, next },
});

describe('the request', () => {
  it('always sends a limit and an offset, because the endpoint defaults to ten rows', () => {
    expect(postBridgeInventoryPath({ limit: 100, offset: 200 })).toBe(
      '/posts?limit=100&offset=200',
    );
  });

  // The encoding is unresolved across the two probe runs and the app sends no filter (§14). This
  // pins the shape the builder would send, so a filter cannot be added without a case saying which.
  it('repeats a bare name for a filter, which is the shape the builder would send', () => {
    expect(
      postBridgeInventoryPath({
        limit: 100,
        offset: 0,
        statuses: ['scheduled', 'draft'],
        platforms: ['twitter'],
      }),
    ).toBe('/posts?limit=100&offset=0&status=scheduled&status=draft&platform=twitter');
  });

  it('escapes a value rather than letting it become another parameter', () => {
    expect(postBridgeInventoryPath({ limit: 10, offset: 0, statuses: ['a&b=c'] })).toBe(
      '/posts?limit=10&offset=0&status=a%26b%3Dc',
    );
  });
});

describe('the state a listed post is in', () => {
  it('reads the three states the vendor names, and lets a draft win over any of them', () => {
    expect(postBridgeRecordState('posted', false)).toBe('PUBLISHED');
    expect(postBridgeRecordState('failed', false)).toBe('FAILED');
    expect(postBridgeRecordState('scheduled', false)).toBe('SCHEDULED');
    expect(postBridgeRecordState('scheduled', true)).toBe('DRAFT');
  });

  it('fails closed on a status it has never seen, and on no status at all', () => {
    expect(postBridgeRecordState('queued_for_review', false)).toBe('PROCESSING');
    expect(postBridgeRecordState(undefined, false)).toBe('PROCESSING');
  });
});

describe('one listed row', () => {
  it('reads the shape the live probe recorded', () => {
    expect(parsePostBridgeInventoryRow(listedRow())).toEqual({
      providerPostId: 'remote-1',
      state: 'SCHEDULED',
      scheduledInstant: '2026-08-20T13:00:00.000Z',
      captionExcerpt: 'Scheduled straight in Post Bridge',
      accountIds: [901],
    });
  });

  it('bounds the caption rather than storing the whole of somebody else’s content', () => {
    const row = parsePostBridgeInventoryRow(listedRow({ caption: 'z'.repeat(400) }));
    expect(row.captionExcerpt).toHaveLength(PROVIDER_INVENTORY_CAPTION_MAX);
  });

  it('takes a numeric id, and a missing caption as no words rather than as a failure', () => {
    const row = parsePostBridgeInventoryRow({ id: 42, status: 'posted' });
    expect(row).toMatchObject({ providerPostId: '42', state: 'PUBLISHED', captionExcerpt: '' });
    expect(row.scheduledInstant).toBeNull();
    expect(row.accountIds).toEqual([]);
  });

  it('reads an account as the id, as the id in a string, or as an object carrying one', () => {
    expect(
      parsePostBridgeInventoryRow(listedRow({ social_accounts: [901, '902', { id: 903 }] }))
        .accountIds,
    ).toEqual([901, 902, 903]);
    expect(
      parsePostBridgeInventoryRow(listedRow({ social_accounts: [{ social_account_id: 904 }] }))
        .accountIds,
    ).toEqual([904]);
  });

  it('keeps an https address where the provider supplies one, and invents none where it does not', () => {
    expect(parsePostBridgeInventoryRow(listedRow({ url: 'https://p.example/x' }))).toMatchObject({
      providerUrl: 'https://p.example/x',
    });
    expect(
      parsePostBridgeInventoryRow(listedRow({ share_url: 'https://s.example/y' })),
    ).toMatchObject({ providerUrl: 'https://s.example/y' });
    // Not a string, and not https: absent rather than stored, because no verified row carries this
    // field at all and refusing a whole generation over it would be brittle.
    expect(
      parsePostBridgeInventoryRow(listedRow({ url: { href: 'x' } })).providerUrl,
    ).toBeUndefined();
    expect(
      parsePostBridgeInventoryRow(listedRow({ url: 'http://p.example/x' })).providerUrl,
    ).toBeUndefined();
  });

  it('refuses a row whose identity or state it cannot read, one reason at a time', () => {
    const refusals: [unknown, string][] = [
      [null, 'a row is null'],
      ['remote-1', 'a row is "remote-1"'],
      [listedRow({ id: undefined }), 'a row carries no id'],
      [listedRow({ id: '   ' }), 'a row carries no id'],
      [listedRow({ status: 7 }), 'the status of remote-1 is 7'],
      [listedRow({ is_draft: 'yes' }), 'the draft flag of remote-1 is "yes"'],
      [listedRow({ caption: 12 }), 'the caption of remote-1 is not text'],
      [listedRow({ scheduled_at: 'soon' }), 'the scheduled instant of remote-1 is "soon"'],
      [listedRow({ social_accounts: 901 }), 'the accounts of remote-1 are 901'],
      [listedRow({ social_accounts: [0] }), 'an account it names is 0'],
      [listedRow({ social_accounts: [{ name: 'x' }] }), 'an account it names is {"name":"x"}'],
    ];
    for (const [value, detail] of refusals) {
      expect(() => parsePostBridgeInventoryRow(value)).toThrow(PublishProviderError);
      expect(() => parsePostBridgeInventoryRow(value)).toThrow(detail);
    }
  });
});

describe('one page', () => {
  it('reads the rows and the provider’s own answer about the next page', () => {
    expect(parsePostBridgeInventoryPage(page([listedRow()]))).toEqual({
      posts: [
        {
          providerPostId: 'remote-1',
          state: 'SCHEDULED',
          scheduledInstant: '2026-08-20T13:00:00.000Z',
          captionExcerpt: 'Scheduled straight in Post Bridge',
          accountIds: [901],
        },
      ],
      next: { done: true },
    });
    expect(parsePostBridgeInventoryPage(page([listedRow()], 100)).next).toEqual({ offset: 100 });
  });

  it('reads an empty page as an empty inventory, which is a real answer', () => {
    expect(parsePostBridgeInventoryPage(page([]))).toEqual({ posts: [], next: { done: true } });
  });

  it('hands an envelope it cannot read to the caller rather than calling it the last page', () => {
    expect(parsePostBridgeInventoryPage({ data: [] }).next).toEqual({ unknown: 'META' });
    expect(
      parsePostBridgeInventoryPage({ data: [], meta: { next: { cursor: 'x' } } }).next,
    ).toEqual({ unknown: 'NEXT' });
  });

  it('refuses a body that is not a page at all, rather than reading it as nothing', () => {
    expect(() => parsePostBridgeInventoryPage(undefined)).toThrow('a page is null');
    expect(() => parsePostBridgeInventoryPage({ meta: { next: null } })).toThrow(
      'a page carried no list of posts',
    );
    expect(() => parsePostBridgeInventoryPage({ data: {} })).toThrow(
      'a page carried no list of posts',
    );
  });

  it('fails the whole page when one row in it is malformed', () => {
    expect(() => parsePostBridgeInventoryPage(page([listedRow(), { caption: 'no id' }]))).toThrow(
      'a row carries no id',
    );
  });
});
