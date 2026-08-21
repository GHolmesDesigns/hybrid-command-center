import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.ts';
import { createDb, type Db } from './db.ts';
import { readCalendarRange } from './calendar.ts';
import { importCampaignArchive } from './signal/archive.ts';
import { LocalSignalProvider } from './signal/read.ts';
import { UnavailableSignalProvider, type SignalProvider } from './signal/provider.ts';
import { createPost, signalPostInput } from './signal/service.ts';
import { calendarDays } from '../shared/calendar.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const stamp = '2026-09-01T00:00:00.000Z';

function workspace({ archived = false }: { archived?: boolean } = {}) {
  const status = archived ? 'ARCHIVED' : 'ACTIVE';
  db.prepare(
    `INSERT INTO clients(id,name,slug,status,drive_status,created_at,updated_at)
     VALUES('c1','Acme Studio','acme-c1',?, 'DISCONNECTED',?,?)`,
  ).run(status, stamp, stamp);
  db.prepare(
    `INSERT INTO projects(id,client_id,name,status,priority,position,drive_status,created_at,updated_at)
     VALUES('p1','c1','Spring Campaign',?, 'MEDIUM',0,'DISCONNECTED',?,?)`,
  ).run(status, stamp, stamp);
}

function task(id: string, title: string, dueDate: string, status = 'BACKLOG') {
  db.prepare(
    `INSERT INTO tasks(id,project_id,title,status,priority,due_date,position,created_at,updated_at)
     VALUES(?,'p1',?,?,'MEDIUM',?,0,?,?)`,
  ).run(id, title, status, dueDate, stamp, stamp);
}

const post = (text: string, date: string, overrides: Record<string, unknown> = {}) =>
  createPost(db, signalPostInput.parse({ text, date, ...overrides }));

/** A provider that fails the way a real one would, rather than being merely unavailable. */
const throwingProvider: SignalProvider = {
  available: true,
  listPosts: () => Promise.reject(new Error('The schedule store is locked.')),
  // The calendar never asks for content overrides; a provider that failed differently for this
  // method would make that harder to notice, not easier.
  listVariants: () => Promise.reject(new Error('The schedule store is locked.')),
  listPublishTargets: () => Promise.reject(new Error('The schedule store is locked.')),
};

describe('reading a calendar range', () => {
  it('returns the two kinds as two lists, never merged', async () => {
    workspace();
    task('t1', 'Ship the explainer', '2026-09-14');
    await post('Teach first. Sell second.', '2026-09-14');

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '2026-09-01',
      '2026-09-30',
    );

    expect(range.posts).toHaveLength(1);
    expect(range.tasks).toHaveLength(1);
    expect(range).not.toHaveProperty('events');
    // The shape itself is the guarantee: there is no field a caller could read that has both.
    expect(Object.keys(range).sort()).toEqual(['from', 'posts', 'signal', 'tasks', 'to']);
  });

  it('keeps both kinds inside the range and lets neither leak', async () => {
    workspace();
    task('t1', 'In range', '2026-09-14');
    task('t2', 'Out of range', '2026-10-14');
    await post('In range', '2026-09-14');
    await post('Out of range', '2026-10-14');

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '2026-09-01',
      '2026-09-30',
    );
    expect(range.posts.map((p) => p.text)).toEqual(['In range']);
    expect(range.tasks.map((t) => t.title)).toEqual(['In range']);
  });

  it('holds both bounds of the range', async () => {
    workspace();
    task('t1', 'First day', '2026-09-01');
    task('t2', 'Last day', '2026-09-30');
    await post('First day', '2026-09-01');
    await post('Last day', '2026-09-30');

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '2026-09-01',
      '2026-09-30',
    );
    expect(range.posts).toHaveLength(2);
    expect(range.tasks).toHaveLength(2);
  });

  it('leaves the unscheduled queue out entirely', async () => {
    workspace();
    await createPost(db, signalPostInput.parse({ text: 'Unscheduled idea' }));

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '0001-01-01',
      '9999-12-31',
    );
    expect(range.posts).toEqual([]);
  });

  it('shows every post status, including a dated draft', async () => {
    workspace();
    await post('A draft with a date', '2026-09-14', { status: 'DRAFT' });
    await post('Scheduled', '2026-09-15', { status: 'SCHEDULED' });
    await post('Already out', '2026-09-16', { status: 'PUBLISHED' });

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '2026-09-01',
      '2026-09-30',
    );
    expect(range.posts.map((p) => p.status)).toEqual(['DRAFT', 'SCHEDULED', 'PUBLISHED']);
  });

  it('includes a completed task rather than dropping it out of hindsight', async () => {
    workspace();
    task('t1', 'Finished work', '2026-09-14', 'COMPLETE');

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '2026-09-01',
      '2026-09-30',
    );
    expect(range.tasks.map((t) => t.status)).toEqual(['COMPLETE']);
  });

  it('leaves work under an archived client off the calendar', async () => {
    workspace({ archived: true });
    task('t1', 'Archived work', '2026-09-14');

    const range = await readCalendarRange(
      db,
      new LocalSignalProvider(db),
      '2026-09-01',
      '2026-09-30',
    );
    expect(range.tasks).toEqual([]);
  });

  it('degrades to tasks alone when the provider is unavailable', async () => {
    workspace();
    task('t1', 'Still due', '2026-09-14');

    const range = await readCalendarRange(
      db,
      new UnavailableSignalProvider(),
      '2026-09-01',
      '2026-09-30',
    );
    expect(range.tasks.map((t) => t.title)).toEqual(['Still due']);
    expect(range.posts).toEqual([]);
    expect(range.signal).toMatchObject({ available: false });
    expect(range.signal.error).toBeTruthy();
  });

  it('degrades the same way when the provider throws, and carries the reason', async () => {
    workspace();
    task('t1', 'Still due', '2026-09-14');

    const range = await readCalendarRange(db, throwingProvider, '2026-09-01', '2026-09-30');
    expect(range.tasks).toHaveLength(1);
    expect(range.signal).toMatchObject({
      available: false,
      error: 'The schedule store is locked.',
    });
  });
});

describe('grouping a range into days', () => {
  it('groups both kinds under one day, still apart', async () => {
    workspace();
    task('t1', 'Ship it', '2026-09-14');
    await post('Post one', '2026-09-14');
    await post('Post two', '2026-09-14');

    const [day, ...rest] = calendarDays(
      await readCalendarRange(db, new LocalSignalProvider(db), '2026-09-01', '2026-09-30'),
    );
    expect(rest).toEqual([]);
    expect(day!.date).toBe('2026-09-14');
    expect(day!.posts).toHaveLength(2);
    expect(day!.tasks).toHaveLength(1);
  });

  it('drops days that carry nothing, and orders the rest', async () => {
    workspace();
    await post('Later', '2026-09-20');
    task('t1', 'Earlier', '2026-09-04');

    const days = calendarDays(
      await readCalendarRange(db, new LocalSignalProvider(db), '2026-09-01', '2026-09-30'),
    );
    expect(days.map((d) => d.date)).toEqual(['2026-09-04', '2026-09-20']);
  });

  it('invents no day for a post handed over without a date', () => {
    const days = calendarDays({
      posts: [{ date: null } as never],
      tasks: [],
    });
    expect(days).toEqual([]);
  });
});

describe('the calendar route', () => {
  const app = () => createApp(db);

  it('answers a range with both kinds and a healthy signal state', async () => {
    workspace();
    task('t1', 'Ship the explainer', '2026-09-14');
    await post('Teach first. Sell second.', '2026-09-14');

    const response = await request(app())
      .get('/api/calendar?from=2026-09-01&to=2026-09-30')
      .expect(200);

    expect(response.body.posts).toHaveLength(1);
    expect(response.body.tasks).toHaveLength(1);
    expect(response.body.signal).toEqual({ available: true, error: null, truncated: false });
  });

  it('refuses a malformed or backwards range', async () => {
    await request(app()).get('/api/calendar?from=2026-09-30&to=2026-09-01').expect(400);
    await request(app()).get('/api/calendar?from=nope&to=2026-09-30').expect(400);
    await request(app()).get('/api/calendar?from=2026-02-31&to=2026-09-30').expect(400);
  });

  it('has no route that writes a schedule', async () => {
    await request(app()).post('/api/calendar').send({ text: 'nope' }).expect(404);
    await request(app()).patch('/api/calendar').send({ text: 'nope' }).expect(404);
    await request(app()).delete('/api/calendar').expect(404);
  });

  it('renders the imported campaign months', async () => {
    importCampaignArchive(db);
    const response = await request(app())
      .get('/api/calendar?from=2026-09-01&to=2026-09-30')
      .expect(200);

    expect(response.body.posts.length).toBeGreaterThan(0);
    for (const item of response.body.posts) expect(item.date.startsWith('2026-09')).toBe(true);
  });
});
