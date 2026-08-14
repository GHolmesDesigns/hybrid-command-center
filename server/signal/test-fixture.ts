import type { SignalPost } from '../../shared/signal.ts';
import type { Db } from '../db.ts';

let sequence = 0;

/** Inserts a valid Signal post without importing Signal's write service into consumer tests. */
export function seedSignalPost(db: Db, overrides: Partial<SignalPost> = {}): SignalPost {
  const post: SignalPost = {
    id: `signal-fixture-${++sequence}`,
    text: 'A clear campaign post',
    channels: ['x'],
    mediaUrls: [],
    date: '2027-08-14',
    time: '09:00',
    format: 'TEXT',
    status: 'DRAFT',
    campaign: null,
    cta: 'NONE',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  db.prepare(
    `INSERT INTO signal_posts(id,text,date,time,format,status,campaign,cta,position,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    post.id,
    post.text,
    post.date,
    post.time,
    post.format,
    post.status,
    post.campaign,
    post.cta,
    post.position,
    post.createdAt,
    post.updatedAt,
  );
  const channel = db.prepare('INSERT INTO signal_post_channels(post_id,channel) VALUES(?,?)');
  for (const value of post.channels) channel.run(post.id, value);
  const media = db.prepare('INSERT INTO signal_post_media(post_id,position,url) VALUES(?,?,?)');
  post.mediaUrls.forEach((url, position) => media.run(post.id, position, url));
  return post;
}
