import { describe, expect, it } from 'vitest';
import { clientAddress, type AddressRequest } from './client-address.ts';

const req = (remoteAddress: string | undefined, forwardedFor?: string): AddressRequest => ({
  socket: { remoteAddress },
  headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
});

describe('clientAddress', () => {
  it('uses the socket address and ignores X-Forwarded-For when hops is 0', () => {
    expect(clientAddress(req('10.0.0.5', '1.2.3.4, 10.0.0.5'), 0)).toBe('10.0.0.5');
  });

  it('strips IPv4-mapped IPv6 prefixes so rate-limit keys match', () => {
    expect(clientAddress(req('::ffff:127.0.0.1'), 0)).toBe('127.0.0.1');
  });

  it('falls back to the socket when X-Forwarded-For is missing or empty', () => {
    expect(clientAddress(req('10.0.0.5'), 1)).toBe('10.0.0.5');
    expect(clientAddress(req('10.0.0.5', '  '), 1)).toBe('10.0.0.5');
  });

  it('peels trusted hops from the right and ignores left-side spoofing', () => {
    // Chain: spoofed, real-client, then the socket peer (the trusted proxy).
    expect(clientAddress(req('10.0.0.1', '9.9.9.9, 203.0.113.10'), 1)).toBe('203.0.113.10');
    expect(clientAddress(req('10.0.0.2', '9.9.9.9, 203.0.113.10, 10.0.0.1'), 2)).toBe(
      '203.0.113.10',
    );
  });

  it('with one hop and a single XFF entry, that entry is the client', () => {
    expect(clientAddress(req('10.0.0.1', '203.0.113.10'), 1)).toBe('203.0.113.10');
  });

  it('returns unknown when the socket address is absent and hops is 0', () => {
    expect(clientAddress(req(undefined), 0)).toBe('unknown');
  });
});
