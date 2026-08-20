import type { SignalPost } from '../../shared/signal.ts';
import { urlPostMedia } from '../../shared/signal-media.ts';
import type { Db } from '../db.ts';

let sequence = 0;

/** Inserts a valid Signal post without importing Signal's write service into consumer tests. */
export function seedSignalPost(db: Db, overrides: Partial<SignalPost> = {}): SignalPost {
  const base: SignalPost = {
    id: `signal-fixture-${++sequence}`,
    text: 'A clear campaign post',
    channels: ['x'],
    media: [],
    mediaUrls: [],
    date: '2027-08-14',
    time: '09:00',
    format: 'TEXT',
    status: 'DRAFT',
    campaigns: [],
    cta: 'NONE',
    position: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  // A fixture may state its media either way, and the two stay consistent whichever it chose:
  // `media` is the descriptors, `mediaUrls` is derived from them, exactly as the row reader does
  // it. Overriding `mediaUrls` alone is the shorthand for a list of public references.
  const media =
    overrides.media ?? (overrides.mediaUrls ?? base.mediaUrls).map((url) => urlPostMedia(url));
  const post: SignalPost = { ...base, media, mediaUrls: media.map((item) => item.url) };
  db.prepare(
    `INSERT INTO signal_posts(id,text,date,time,format,status,cta,position,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    post.id,
    post.text,
    post.date,
    post.time,
    post.format,
    post.status,
    post.cta,
    post.position,
    post.createdAt,
    post.updatedAt,
  );
  const channel = db.prepare('INSERT INTO signal_post_channels(post_id,channel) VALUES(?,?)');
  for (const value of post.channels) channel.run(post.id, value);
  const mediaRow = db.prepare(
    `INSERT INTO signal_post_media(
       post_id,position,url,source,drive_file_id,drive_name,mime_type,size_bytes,
       drive_version,drive_modified_at,drive_checksum,drive_verified_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  post.media.forEach((item, position) =>
    mediaRow.run(
      post.id,
      position,
      item.url,
      item.source,
      item.driveFileId,
      item.driveName,
      item.mimeType,
      item.sizeBytes,
      item.driveVersion,
      item.driveModifiedAt,
      item.driveChecksum,
      item.driveVerifiedAt,
    ),
  );
  // Campaigns are given as whole records here rather than as names: a fixture states the workspace
  // it wants, and going through the resolve-or-create would put the write service back into tests
  // that deliberately do not import it.
  const campaign = db.prepare(
    'INSERT OR IGNORE INTO signal_campaigns(id,name,color) VALUES(?,?,?)',
  );
  const attach = db.prepare(
    'INSERT OR IGNORE INTO signal_post_campaigns(post_id,campaign_id) VALUES(?,?)',
  );
  for (const value of post.campaigns) {
    campaign.run(value.id, value.name, value.color ?? null);
    attach.run(post.id, value.id);
  }
  return post;
}
