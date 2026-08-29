import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from './db.ts';
import {
  MCP_CHANGE_FEED_EXPIRED_MESSAGE,
  MCP_CHANGE_FEED_RETENTION,
  decodeChangeFeedCursor,
  encodeChangeFeedCursor,
} from '../shared/mcp-change-feeds.ts';
import { readChangeFeed, recordChangeFeedEvent } from './change-feeds.ts';

const databases: Db[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const openDb = (): Db => {
  const db = createDb(':memory:');
  databases.push(db);
  return db;
};

describe('change feeds', () => {
  it('returns a tip cursor with no changes when after is omitted', () => {
    const db = openDb();
    recordChangeFeedEvent(db, {
      feed: 'coordination',
      kind: 'handoff.posted',
      entityType: 'handoff',
      entityId: 'h1',
      summary: 'Posted.',
    });
    const tip = readChangeFeed(db, 'coordination', { limit: 50 });
    expect(tip).toMatchObject({
      status: 'ok',
      changes: [],
      truncated: false,
    });
    if (tip.status !== 'ok') throw new Error('expected ok');
    expect(decodeChangeFeedCursor(tip.cursor)?.seq).toBe(1);
  });

  it('replays exactly the changes after a prior cursor with no duplicates', () => {
    const db = openDb();
    const tip = readChangeFeed(db, 'coordination', { limit: 50 });
    if (tip.status !== 'ok') throw new Error('expected ok');

    recordChangeFeedEvent(db, {
      feed: 'coordination',
      kind: 'handoff.posted',
      entityType: 'handoff',
      entityId: 'h1',
      summary: 'First.',
    });
    recordChangeFeedEvent(db, {
      feed: 'coordination',
      kind: 'handoff.claimed',
      entityType: 'handoff',
      entityId: 'h1',
      summary: 'Claimed.',
    });

    const page = readChangeFeed(db, 'coordination', { after: tip.cursor, limit: 50 });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('expected ok');
    expect(page.changes.map((c) => c.kind)).toEqual(['handoff.posted', 'handoff.claimed']);
    expect(page.truncated).toBe(false);

    const again = readChangeFeed(db, 'coordination', { after: page.cursor, limit: 50 });
    expect(again).toMatchObject({ status: 'ok', changes: [], truncated: false });
  });

  it('survives closing and reopening the database (process restart)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-cf-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'feed.db');
    const first = createDb(file);
    const tip = readChangeFeed(first, 'workspace', { limit: 10 });
    if (tip.status !== 'ok') throw new Error('expected ok');
    recordChangeFeedEvent(first, {
      feed: 'workspace',
      kind: 'task.created',
      entityType: 'task',
      entityId: 't1',
      summary: 'Created task.',
    });
    first.close();

    const second = createDb(file);
    databases.push(second);
    const page = readChangeFeed(second, 'workspace', { after: tip.cursor, limit: 10 });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('expected ok');
    expect(page.changes).toEqual([
      expect.objectContaining({ kind: 'task.created', entityId: 't1' }),
    ]);
  });

  it('returns cursor_expired when the cursor falls behind retention', () => {
    const db = openDb();
    const tip = readChangeFeed(db, 'coordination', { limit: 50 });
    if (tip.status !== 'ok') throw new Error('expected ok');

    for (let i = 0; i < MCP_CHANGE_FEED_RETENTION + 5; i += 1) {
      recordChangeFeedEvent(db, {
        feed: 'coordination',
        kind: 'handoff.posted',
        entityType: 'handoff',
        entityId: `h${i}`,
        summary: `Post ${i}`,
      });
    }

    const expired = readChangeFeed(db, 'coordination', { after: tip.cursor, limit: 50 });
    expect(expired).toEqual({
      status: 'cursor_expired',
      feed: 'coordination',
      message: MCP_CHANGE_FEED_EXPIRED_MESSAGE,
    });
  });

  it('never returns a partial feed for an expired cursor', () => {
    const db = openDb();
    for (let i = 0; i < MCP_CHANGE_FEED_RETENTION + 3; i += 1) {
      recordChangeFeedEvent(db, {
        feed: 'coordination',
        kind: 'handoff.posted',
        entityType: 'handoff',
        entityId: `h${i}`,
        summary: `Post ${i}`,
      });
    }
    const stale = encodeChangeFeedCursor('coordination', 1);
    const result = readChangeFeed(db, 'coordination', { after: stale, limit: 50 });
    expect(result.status).toBe('cursor_expired');
    if (result.status === 'ok') {
      throw new Error(`partial feed returned ${result.changes.length} changes`);
    }
  });

  it('caps a page and reports truncation without skipping seq', () => {
    const db = openDb();
    const tip = readChangeFeed(db, 'workspace', { limit: 50 });
    if (tip.status !== 'ok') throw new Error('expected ok');
    for (let i = 0; i < 5; i += 1) {
      recordChangeFeedEvent(db, {
        feed: 'workspace',
        kind: 'task.updated',
        entityType: 'task',
        entityId: `t${i}`,
        summary: `Update ${i}`,
      });
    }
    const first = readChangeFeed(db, 'workspace', { after: tip.cursor, limit: 2 });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') throw new Error('expected ok');
    expect(first.changes).toHaveLength(2);
    expect(first.truncated).toBe(true);

    const second = readChangeFeed(db, 'workspace', { after: first.cursor, limit: 10 });
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw new Error('expected ok');
    expect(second.changes.map((c) => c.entityId)).toEqual(['t2', 't3', 't4']);
    expect(second.truncated).toBe(false);
  });

  it('keeps coordination and workspace feeds independent', () => {
    const db = openDb();
    recordChangeFeedEvent(db, {
      feed: 'coordination',
      kind: 'handoff.posted',
      entityType: 'handoff',
      entityId: 'h1',
      summary: 'Handoff.',
    });
    recordChangeFeedEvent(db, {
      feed: 'workspace',
      kind: 'project.created',
      entityType: 'project',
      entityId: 'p1',
      summary: 'Project.',
    });
    const coordTip = encodeChangeFeedCursor('coordination', 0);
    const workspaceTip = encodeChangeFeedCursor('workspace', 0);
    const coord = readChangeFeed(db, 'coordination', { after: coordTip, limit: 50 });
    const workspace = readChangeFeed(db, 'workspace', { after: workspaceTip, limit: 50 });
    expect(coord.status === 'ok' && coord.changes.map((c) => c.kind)).toEqual(['handoff.posted']);
    expect(workspace.status === 'ok' && workspace.changes.map((c) => c.kind)).toEqual([
      'project.created',
    ]);
  });

  it('stays gap-free under interleaved writers in one connection', () => {
    const db = openDb();
    const tip = readChangeFeed(db, 'coordination', { limit: 50 });
    if (tip.status !== 'ok') throw new Error('expected ok');

    db.exec('BEGIN');
    recordChangeFeedEvent(db, {
      feed: 'coordination',
      kind: 'handoff.posted',
      entityType: 'handoff',
      entityId: 'a',
      summary: 'A',
    });
    recordChangeFeedEvent(db, {
      feed: 'coordination',
      kind: 'handoff.posted',
      entityType: 'handoff',
      entityId: 'b',
      summary: 'B',
    });
    db.exec('COMMIT');

    const page = readChangeFeed(db, 'coordination', { after: tip.cursor, limit: 50 });
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('expected ok');
    const seqs = page.changes.map((c) => decodeChangeFeedCursor(c.cursor)?.seq);
    expect(seqs).toEqual([1, 2]);
    expect(page.changes.map((c) => c.entityId)).toEqual(['a', 'b']);
  });

  it('treats a cursor from the other feed as expired', () => {
    const db = openDb();
    const foreign = encodeChangeFeedCursor('workspace', 0);
    expect(readChangeFeed(db, 'coordination', { after: foreign, limit: 10 })).toEqual({
      status: 'cursor_expired',
      feed: 'coordination',
      message: MCP_CHANGE_FEED_EXPIRED_MESSAGE,
    });
  });
});
