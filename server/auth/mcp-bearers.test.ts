import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { createSession } from './sessions.ts';
import {
  createMcpBearer,
  hashMcpBearerToken,
  readMcpBearerToken,
  resolveMcpBearer,
  revokeAllMcpBearers,
  revokeBearersForSession,
} from './mcp-bearers.ts';
import { MCP_BEARER_TOKEN_PREFIX } from '../../shared/mcp-network.ts';

const SECRET = 'session-secret-at-least-thirty-two-chars!!';

describe('mcp bearers', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('creates, resolves, and revokes a bearer bound to a live session', () => {
    const session = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const issued = createMcpBearer(db, {
      sessionTokenHash: session.record.tokenHash,
      sessionSecret: SECRET,
      now: 1_000,
    });
    expect(issued.rawToken.startsWith(MCP_BEARER_TOKEN_PREFIX)).toBe(true);

    const resolved = resolveMcpBearer(db, {
      rawToken: issued.rawToken,
      sessionSecret: SECRET,
      now: 1_001,
    });
    expect(resolved?.session.tokenHash).toBe(session.record.tokenHash);

    revokeBearersForSession(db, session.record.tokenHash, 1_002);
    expect(
      resolveMcpBearer(db, {
        rawToken: issued.rawToken,
        sessionSecret: SECRET,
        now: 1_003,
      }),
    ).toBeNull();
  });

  it('revokeAllMcpBearers invalidates every live bearer', () => {
    const first = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const second = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
      now: 1_000,
    });
    const bearerA = createMcpBearer(db, {
      sessionTokenHash: first.record.tokenHash,
      sessionSecret: SECRET,
    });
    const bearerB = createMcpBearer(db, {
      sessionTokenHash: second.record.tokenHash,
      sessionSecret: SECRET,
    });

    revokeAllMcpBearers(db, 2_000);
    expect(
      resolveMcpBearer(db, { rawToken: bearerA.rawToken, sessionSecret: SECRET, now: 2_001 }),
    ).toBeNull();
    expect(
      resolveMcpBearer(db, { rawToken: bearerB.rawToken, sessionSecret: SECRET, now: 2_001 }),
    ).toBeNull();
  });

  it('stores only a hash of the bearer token', () => {
    const session = createSession(db, {
      sessionSecret: SECRET,
      clientAddress: '127.0.0.1',
    });
    const issued = createMcpBearer(db, {
      sessionTokenHash: session.record.tokenHash,
      sessionSecret: SECRET,
    });
    const rows = db.prepare('SELECT token_hash FROM operator_mcp_bearers').all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashMcpBearerToken(issued.rawToken, SECRET));
    expect(rows[0]!.token_hash).not.toBe(issued.rawToken);
  });

  it('parses Authorization bearer headers', () => {
    expect(readMcpBearerToken(`Bearer ${MCP_BEARER_TOKEN_PREFIX}abc`)).toBe(
      `${MCP_BEARER_TOKEN_PREFIX}abc`,
    );
    expect(readMcpBearerToken('Basic nope')).toBeNull();
    expect(readMcpBearerToken(undefined)).toBeNull();
  });
});
