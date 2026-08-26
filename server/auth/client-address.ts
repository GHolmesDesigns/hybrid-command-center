/**
 * Client address for login rate limiting and session records (C51 / #177).
 *
 * When `trustedProxyHops` is 0 the socket peer is the only truth — `X-Forwarded-For` is ignored
 * so a client cannot spoof an address on a direct bind. When hops > 0 the header is read with
 * standard trusted-hop semantics (as Express / proxy-addr): the chain is the XFF list plus the
 * socket peer, and the client is the address `hops` steps left of the rightmost entry. Anything
 * further left is untrusted and never chosen.
 */
export type AddressRequest = {
  socket: { remoteAddress?: string | null };
  headers: { [key: string]: string | string[] | undefined };
};

function normalizeAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Node reports IPv4-mapped IPv6 as ::ffff:a.b.c.d; strip the mapping so rate-limit keys match.
  if (trimmed.toLowerCase().startsWith('::ffff:')) return trimmed.slice(7);
  return trimmed;
}

function forwardedAddresses(header: string | string[] | undefined): string[] | null {
  if (header === undefined) return null;
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw
    .split(',')
    .map((part) => normalizeAddress(part))
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts : null;
}

/**
 * The address of the operator's client for this request.
 * @param trustedProxyHops How many reverse proxies sit in front of the process (0 = ignore XFF).
 */
export function clientAddress(req: AddressRequest, trustedProxyHops: number): string {
  const socketAddress = normalizeAddress(req.socket.remoteAddress) ?? 'unknown';
  if (trustedProxyHops <= 0) return socketAddress;

  const forwarded = forwardedAddresses(req.headers['x-forwarded-for']);
  if (!forwarded) return socketAddress;

  // XFF entries then the immediate peer — same chain proxy-addr builds — then peel `hops`
  // trusted addresses from the right and take the next one as the client.
  const chain = [...forwarded, socketAddress];
  const index = chain.length - 1 - trustedProxyHops;
  if (index < 0) return chain[0]!;
  return chain[index]!;
}
