import { describe, expect, it } from 'vitest';
import {
  describeShape,
  pickScalars,
  providerMessage,
  recordedHeaders,
  redactSecrets,
  redactUrl,
} from './redact.ts';

describe('redactSecrets', () => {
  it('removes the probe’s own key shape, named or not', () => {
    expect(redactSecrets('Authorization: Bearer pb_live_abc123')).not.toContain('pb_live_abc123');
    expect(redactSecrets('the key pb_live_abc123 was rejected')).toBe(
      'the key [redacted] was rejected',
    );
    expect(redactSecrets('api_key=pb_live_abc123&x=1')).not.toContain('pb_live_abc123');
  });

  it('keeps the name of the credential and drops only its value', () => {
    expect(redactSecrets('"client_secret": "hunter2"')).toContain('client_secret');
    expect(redactSecrets('"client_secret": "hunter2"')).not.toContain('hunter2');
  });

  it('strips a signed URL’s query, which is the signature', () => {
    const scrubbed = redactSecrets(
      'PUT https://storage.example.test/bucket/object?X-Amz-Signature=deadbeef&expires=1 failed',
    );
    expect(scrubbed).toContain('https://storage.example.test/bucket/object?[redacted]');
    expect(scrubbed).not.toContain('deadbeef');
  });

  it('removes a JWT even with no naming key beside it', () => {
    expect(redactSecrets('token eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig')).not.toContain(
      'eyJhbGciOiJIUzI1NiJ9',
    );
  });

  it('truncates, so no payload fits in a message', () => {
    expect(redactSecrets('x'.repeat(900))).toHaveLength(300);
  });
});

describe('redactUrl', () => {
  it('keeps origin and path and says only that there was a query', () => {
    expect(redactUrl('https://api.example.test/v1/posts?limit=10&offset=0')).toBe(
      'https://api.example.test/v1/posts?[redacted]',
    );
  });

  it('keeps a query-free URL whole', () => {
    expect(redactUrl('https://api.example.test/v1/posts/42')).toBe(
      'https://api.example.test/v1/posts/42',
    );
  });

  it('flags embedded credentials rather than printing them', () => {
    const scrubbed = redactUrl('https://user:secret@api.example.test/v1/posts');
    expect(scrubbed).toBe('https://[credentials]@api.example.test/v1/posts');
    expect(scrubbed).not.toContain('secret');
  });

  it('refuses to pass half of an unparseable string through', () => {
    expect(redactUrl('not a url at all')).toBe('[unparseable url]');
  });
});

describe('describeShape', () => {
  it('records field names and types and never a value', () => {
    const shape = describeShape({ id: 'p1', caption: 'somebody’s real post', is_draft: false });
    expect(shape).toBe('{caption: string, id: string, is_draft: boolean}');
    expect(shape).not.toContain('somebody');
  });

  it('describes a list by its length and its first element', () => {
    expect(describeShape([{ a: 1 }, { a: 2 }])).toBe('array(2) of {a: number}');
    expect(describeShape([])).toBe('array(0)');
  });

  it('stops at its depth bound rather than walking into a nested string', () => {
    expect(describeShape({ a: { b: { c: 'deep secret' } } }, 2)).not.toContain('deep secret');
  });

  it('sorts keys, so two reads of the same shape compare equal', () => {
    expect(describeShape({ b: 1, a: 2 })).toBe(describeShape({ a: 2, b: 1 }));
  });

  it('names null as null rather than as an object', () => {
    expect(describeShape({ scheduled_at: null })).toBe('{scheduled_at: null}');
  });
});

describe('pickScalars', () => {
  it('copies only the named keys', () => {
    expect(
      pickScalars({ match_confidence: 'exact', caption: 'private' }, ['match_confidence']),
    ).toEqual({
      match_confidence: 'exact',
    });
  });

  it('scrubs an allowed field that came back holding something it should not', () => {
    expect(pickScalars({ note: 'Bearer pb_live_abc' }, ['note']).note).toBe('Bearer [redacted]');
  });

  it('describes rather than copies an object under an allowed key', () => {
    expect(pickScalars({ meta: { next: null } }, ['meta']).meta).toBe('{next: null}');
  });

  it('keeps an explicit null and skips an absent key', () => {
    expect(pickScalars({ a: null }, ['a', 'b'])).toEqual({ a: null });
  });

  it('returns nothing for a non-object', () => {
    expect(pickScalars([1, 2], ['0'])).toEqual({});
    expect(pickScalars(null, ['a'])).toEqual({});
  });
});

describe('recordedHeaders', () => {
  it('keeps the rate-limit headers, lower-cased, and drops everything else', () => {
    expect(
      recordedHeaders({
        'Retry-After': '30',
        'X-RateLimit-Remaining': '0',
        'Set-Cookie': 'session=abc',
        Location: 'https://elsewhere.example.test/?token=abc',
      }),
    ).toEqual({ 'retry-after': '30', 'x-ratelimit-remaining': '0' });
  });
});

describe('providerMessage', () => {
  it('joins a framework’s list of messages', () => {
    expect(providerMessage({ message: ['mime_type must be one of', 'image/png'] })).toBe(
      'mime_type must be one of; image/png',
    );
  });

  it('scrubs the provider’s own words too', () => {
    expect(providerMessage({ error: 'bad key pb_live_abc' })).toBe('bad key [redacted]');
  });

  it('is empty for a body that says nothing', () => {
    expect(providerMessage({ data: [] })).toBe('');
    expect(providerMessage(undefined)).toBe('');
  });
});
