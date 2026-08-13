import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { campaignArchive, importCampaignArchive } from './archive.ts';
import { listPostsInRange } from './read.ts';
import { createPost, getPost, listQueue, signalPostInput, updatePost } from './service.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const count = () => (db.prepare('SELECT COUNT(*) n FROM signal_posts').get() as { n: number }).n;

describe('the archived campaign content', () => {
  it('parses against the same vocabulary the API enforces', () => {
    // `campaignArchive` validates on read, so a file edited into an unknown channel, status,
    // format, or CTA fails here rather than at the moment someone runs the import.
    expect(() => campaignArchive()).not.toThrow();
    expect(campaignArchive().length).toBeGreaterThan(0);
  });

  it('carries both campaigns, their written copy, and their links', () => {
    const posts = campaignArchive();
    const campaigns = new Set(posts.map((post) => post.campaign));
    expect([...campaigns].some((name) => name?.startsWith('Clarity Campaign'))).toBe(true);
    expect([...campaigns].some((name) => name?.startsWith('Explain It Clearly'))).toBe(true);

    // The long-form copy is the thing that could not be retyped; assert it survived intact
    // rather than only that a row exists.
    const longest = posts.reduce((a, b) => (a.text.length > b.text.length ? a : b));
    expect(longest.text.length).toBeGreaterThan(500);
    expect(longest.text).toContain('\n');
    expect(posts.some((post) => post.text.includes('utm_source'))).toBe(true);
  });

  it('gives every post a distinct id', () => {
    const posts = campaignArchive();
    expect(new Set(posts.map((post) => post.id)).size).toBe(posts.length);
  });

  it('numbers the unscheduled queue from zero without a gap', () => {
    const queued = campaignArchive().filter((post) => post.date === null);
    expect(queued.map((post) => post.position).sort((a, b) => a - b)).toEqual(
      queued.map((_, index) => index),
    );
  });
});

describe('importing the archive', () => {
  it('writes every post, dated ones onto their days and the rest into the queue', () => {
    const archive = campaignArchive();
    const result = importCampaignArchive(db);

    expect(result).toEqual({ imported: archive.length, skipped: 0 });
    expect(count()).toBe(archive.length);
    expect(listPostsInRange(db, '0001-01-01', '9999-12-31').posts).toHaveLength(
      archive.filter((post) => post.date !== null).length,
    );
    expect(listQueue(db)).toHaveLength(archive.filter((post) => post.date === null).length);
  });

  it('reads back through the provider with channels attached', () => {
    importCampaignArchive(db);
    const { posts } = listPostsInRange(db, '0001-01-01', '9999-12-31');
    const withChannels = posts.filter((post) => post.channels.length > 0);
    expect(withChannels.length).toBeGreaterThan(0);
    for (const post of withChannels) {
      expect(new Set(post.channels).size).toBe(post.channels.length);
    }
  });

  it('changes nothing on a second run', () => {
    const first = importCampaignArchive(db);
    const second = importCampaignArchive(db);

    expect(second).toEqual({ imported: 0, skipped: first.imported });
    expect(count()).toBe(first.imported);
  });

  it('leaves an edit made after an import alone, rather than duplicating or reverting it', () => {
    importCampaignArchive(db);
    const target = listPostsInRange(db, '0001-01-01', '9999-12-31').posts[0]!;
    updatePost(db, target.id, { text: 'Reworded after the import', status: 'PUBLISHED' });

    const again = importCampaignArchive(db);
    expect(again.imported).toBe(0);
    expect(getPost(db, target.id)).toMatchObject({
      text: 'Reworded after the import',
      status: 'PUBLISHED',
    });
  });

  it('leaves posts written here untouched, and does not count them as its own', () => {
    const mine = createPost(db, signalPostInput.parse({ text: 'My own idea' }));
    const result = importCampaignArchive(db);

    expect(result.skipped).toBe(0);
    expect(getPost(db, mine.id)).toMatchObject({ text: 'My own idea' });
    expect(count()).toBe(result.imported + 1);
  });

  it('imports nothing at all when part of it cannot be written', () => {
    // An archive holding the same id twice is what a corrupted file looks like: the first row
    // writes, the second collides on the primary key. The transaction is what keeps the posts
    // written before the collision off the books.
    const archive = campaignArchive();
    const broken = [...archive.slice(0, 5), archive[0]!];

    expect(() => importCampaignArchive(db, broken)).toThrow();
    expect(count()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_post_channels').get()).toEqual({ n: 0 });
  });
});
