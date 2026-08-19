import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.ts';
import { backfillSignalCampaigns, createDb, type Db } from '../db.ts';
import {
  SignalCampaignInUseError,
  SignalCampaignNameTakenError,
  SignalCampaignNotFoundError,
  countCampaignPosts,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  signalCampaignInput,
  updateCampaign,
} from './campaigns.ts';
import { createPost, getPost, signalPostInput } from './service.ts';
import { importCampaignArchive, campaignArchive } from './archive.ts';

let db: Db;
beforeEach(() => {
  db = createDb(':memory:');
});

const app = () => createApp(db);
const add = (overrides: Record<string, unknown> = {}) =>
  createPost(db, signalPostInput.parse({ text: 'Clarity as competitive advantage', ...overrides }));
const names = () => listCampaigns(db).map((campaign) => campaign.name);

/** Writes the frozen free-text column directly, which is the only thing that ever did. */
const setLegacyCampaign = (postId: string, value: string | null) =>
  db.prepare('UPDATE signal_posts SET campaign=? WHERE id=?').run(value, postId);

describe('the campaign vocabulary', () => {
  it('creates a campaign, and picks the existing one when the name is already there', () => {
    const first = createCampaign(db, signalCampaignInput.parse({ name: '  Clarity Campaign  ' }));
    expect(first).toEqual({
      campaign: { id: expect.any(String), name: 'Clarity Campaign' },
      created: true,
    });

    // Case- and whitespace-insensitively, through the one shared rule.
    const again = createCampaign(db, signalCampaignInput.parse({ name: 'clarity   campaign' }));
    expect(again.created).toBe(false);
    expect(again.campaign.id).toBe(first.campaign.id);
    expect(names()).toEqual(['Clarity Campaign']);
  });

  it('refuses a name that is only whitespace, and one past the shared bound', () => {
    expect(() => signalCampaignInput.parse({ name: '   ' })).toThrow();
    expect(() => signalCampaignInput.parse({ name: 'x'.repeat(61) })).toThrow();
    expect(() => signalCampaignInput.parse({ name: 'x'.repeat(60) })).not.toThrow();
  });

  it('counts the posts carrying a campaign, and reports zero for one nothing carries', () => {
    const created = add({ campaigns: ['Clarity Campaign'] });
    add({ campaigns: ['Clarity Campaign'] });
    createCampaign(db, signalCampaignInput.parse({ name: 'Unused idea' }));
    expect(listCampaigns(db)).toEqual([
      { id: created.campaigns[0]!.id, name: 'Clarity Campaign', postCount: 2 },
      { id: expect.any(String), name: 'Unused idea', postCount: 0 },
    ]);
  });

  /**
   * The acceptance criterion, and the reason a campaign is a row rather than a string on a post:
   * one `UPDATE` reaches every post, because no post holds a copy of the name.
   */
  it('renames a campaign with one write, and every post reads the new name', () => {
    const first = add({ campaigns: ['Wk4'] });
    const second = add({ campaigns: ['Wk4'] });
    const campaignId = first.campaigns[0]!.id;

    updateCampaign(db, campaignId, { name: 'Week four' });
    expect(getPost(db, first.id)?.campaigns).toEqual([{ id: campaignId, name: 'Week four' }]);
    expect(getPost(db, second.id)?.campaigns).toEqual([{ id: campaignId, name: 'Week four' }]);
    // Nothing was rewritten on either post: the join rows still point at the same campaign.
    expect(countCampaignPosts(db, campaignId)).toBe(2);
  });

  it('refuses a rename onto a name another campaign holds, and takes a re-spelling of its own', () => {
    const clarity = createCampaign(db, signalCampaignInput.parse({ name: 'Clarity' })).campaign;
    const explain = createCampaign(db, signalCampaignInput.parse({ name: 'Explain' })).campaign;

    expect(() => updateCampaign(db, explain.id, { name: 'clarity' })).toThrow(
      SignalCampaignNameTakenError,
    );
    // Its own name in a different case is not a clash — that is the campaign renaming itself.
    expect(updateCampaign(db, clarity.id, { name: 'CLARITY' }).name).toBe('CLARITY');
    expect(() => updateCampaign(db, 'nope', { name: 'Anything' })).toThrow(
      SignalCampaignNotFoundError,
    );
  });

  it('sets and clears a colour without touching the name', () => {
    const campaign = createCampaign(db, signalCampaignInput.parse({ name: 'Clarity' })).campaign;
    expect(updateCampaign(db, campaign.id, { color: '#315f79' }).color).toBe('#315f79');
    expect(updateCampaign(db, campaign.id, { name: 'Clarity Campaign' })).toEqual({
      id: campaign.id,
      name: 'Clarity Campaign',
      color: '#315f79',
    });
    expect(updateCampaign(db, campaign.id, { color: null })).not.toHaveProperty('color');
  });

  /** The other acceptance criterion: a deletion detaches and never reaches a post. */
  it('detaches a campaign on deletion and deletes no post', () => {
    const first = add({ campaigns: ['Wk4', 'Clarity Campaign'] });
    const second = add({ campaigns: ['Wk4'] });
    const campaignId = first.campaigns.find((campaign) => campaign.name === 'Wk4')!.id;

    expect(() => deleteCampaign(db, campaignId, false)).toThrow(SignalCampaignInUseError);
    expect(deleteCampaign(db, campaignId, true)).toEqual({ name: 'Wk4', detachedFromPosts: 2 });

    expect(getPost(db, first.id)?.campaigns.map((campaign) => campaign.name)).toEqual([
      'Clarity Campaign',
    ]);
    expect(getPost(db, second.id)?.campaigns).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_posts').get()).toEqual({ n: 2 });
    expect(names()).toEqual(['Clarity Campaign']);
  });

  it('deletes a campaign nothing carries without asking, and refuses one that is not there', () => {
    const campaign = createCampaign(db, signalCampaignInput.parse({ name: 'Unused' })).campaign;
    expect(deleteCampaign(db, campaign.id, false)).toEqual({
      name: 'Unused',
      detachedFromPosts: 0,
    });
    expect(() => deleteCampaign(db, 'nope', true)).toThrow(SignalCampaignNotFoundError);
  });

  it('takes the join rows with a post when the post is deleted', () => {
    const created = add({ campaigns: ['Wk4'] });
    db.prepare('DELETE FROM signal_posts WHERE id=?').run(created.id);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_post_campaigns').get()).toEqual({ n: 0 });
    // The campaign itself survives: a post going away is not the workspace changing its mind.
    expect(names()).toEqual(['Wk4']);
  });
});

describe('backfilling the free-text campaign column', () => {
  it('creates one campaign per distinct name and attaches the post that carried it', () => {
    const first = add();
    const second = add();
    setLegacyCampaign(first.id, 'Clarity Campaign — Wk1: The Problem');
    setLegacyCampaign(second.id, 'Clarity Campaign — Wk2: The Cause');

    expect(backfillSignalCampaigns(db)).toEqual({ campaigns: 2, attachments: 2 });
    expect(names()).toEqual([
      'Clarity Campaign — Wk1: The Problem',
      'Clarity Campaign — Wk2: The Cause',
    ]);
    expect(getPost(db, first.id)?.campaigns.map((campaign) => campaign.name)).toEqual([
      'Clarity Campaign — Wk1: The Problem',
    ]);
  });

  /**
   * The duplicate-spelling answer this card had to decide: two spellings resolve to one campaign,
   * and the spelling kept is the one the earliest post used. Deterministic from the rows themselves,
   * so the same database migrates the same way twice.
   */
  it('resolves two spellings to one campaign, keeping the earliest post’s spelling', () => {
    const early = add();
    const late = add();
    db.prepare('UPDATE signal_posts SET created_at=? WHERE id=?').run(
      '2026-03-01T00:00:00.000Z',
      early.id,
    );
    db.prepare('UPDATE signal_posts SET created_at=? WHERE id=?').run(
      '2026-05-01T00:00:00.000Z',
      late.id,
    );
    setLegacyCampaign(early.id, 'CLARITY campaign');
    setLegacyCampaign(late.id, '  clarity   Campaign ');

    expect(backfillSignalCampaigns(db)).toEqual({ campaigns: 1, attachments: 2 });
    expect(names()).toEqual(['CLARITY campaign']);
    expect(getPost(db, late.id)?.campaigns[0]!.id).toBe(getPost(db, early.id)?.campaigns[0]!.id);
  });

  it('leaves a post whose column is empty or whitespace with no campaign at all', () => {
    const blank = add();
    const spaces = add();
    setLegacyCampaign(blank.id, '');
    setLegacyCampaign(spaces.id, '   ');
    expect(backfillSignalCampaigns(db)).toEqual({ campaigns: 0, attachments: 0 });
    expect(names()).toEqual([]);
  });

  it('writes nothing on a second run, and never re-attaches a post detached by hand', () => {
    const created = add();
    setLegacyCampaign(created.id, 'Wk4');
    expect(backfillSignalCampaigns(db)).toEqual({ campaigns: 1, attachments: 1 });
    expect(backfillSignalCampaigns(db)).toEqual({ campaigns: 0, attachments: 0 });

    // Detached deliberately. The column still says Wk4, and the backfill leaves it that way:
    // it reads posts with no join row, and this post's row was removed on purpose.
    db.prepare('DELETE FROM signal_post_campaigns WHERE post_id=?').run(created.id);
    expect(backfillSignalCampaigns(db)).toEqual({ campaigns: 0, attachments: 1 });
  });

  it('runs on every boot, so a database created before campaigns existed arrives migrated', () => {
    const created = add();
    setLegacyCampaign(created.id, 'Wk4');
    // `createDb` on the same file would be the real path; the boot sequence is what is asserted,
    // and calling it again against this handle is the same three statements in the same order.
    expect(backfillSignalCampaigns(db).campaigns).toBe(1);
    expect(getPost(db, created.id)?.campaigns.map((campaign) => campaign.name)).toEqual(['Wk4']);
  });

  it('leaves the frozen column exactly as it found it', () => {
    const created = add();
    setLegacyCampaign(created.id, 'Wk4');
    backfillSignalCampaigns(db);
    expect(db.prepare('SELECT campaign FROM signal_posts WHERE id=?').get(created.id)).toEqual({
      campaign: 'Wk4',
    });
    // And nothing written afterwards touches it.
    const fresh = add({ campaigns: ['Wk5'] });
    expect(db.prepare('SELECT campaign FROM signal_posts WHERE id=?').get(fresh.id)).toEqual({
      campaign: null,
    });
  });
});

describe('the archive importer, afterwards', () => {
  it('writes the join rather than the frozen column, one campaign per label in the file', () => {
    const result = importCampaignArchive(db);
    expect(result.imported).toBeGreaterThan(0);

    const labels = new Set(
      campaignArchive()
        .map((post) => post.campaign)
        .filter((name): name is string => Boolean(name)),
    );
    expect(names().sort()).toEqual([...labels].sort());
    expect(
      db.prepare('SELECT COUNT(*) n FROM signal_posts WHERE campaign IS NOT NULL').get(),
    ).toEqual({ n: 0 });
  });

  it('stays idempotent: a second run writes no campaign, no attachment, and no post', () => {
    importCampaignArchive(db);
    const campaignsAfterFirst = listCampaigns(db);
    const attachments = db.prepare('SELECT COUNT(*) n FROM signal_post_campaigns').get();

    expect(importCampaignArchive(db).imported).toBe(0);
    expect(listCampaigns(db)).toEqual(campaignsAfterFirst);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_post_campaigns').get()).toEqual(attachments);
  });

  it('joins a campaign the workspace already has rather than creating a second spelling', () => {
    const label = campaignArchive().find((post) => post.campaign)!.campaign as string;
    const mine = add({ campaigns: [label.toUpperCase()] });

    importCampaignArchive(db);
    const campaign = listCampaigns(db).find(
      (candidate) => candidate.name.toLowerCase() === label.toLowerCase(),
    );
    // One row, under the spelling that was there first, carrying my post and the archive's.
    expect(campaign?.name).toBe(label.toUpperCase());
    expect(campaign?.postCount).toBeGreaterThan(1);
    expect(getPost(db, mine.id)?.campaigns[0]!.id).toBe(campaign?.id);
  });
});

describe('the campaign HTTP boundary', () => {
  it('lists, creates, renames, and deletes over HTTP', async () => {
    const created = await request(app())
      .post('/api/signal/campaigns')
      .send({ name: '  Clarity Campaign  ' })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Clarity Campaign' });

    // A name already in the list is picked rather than duplicated, and answers 200 to say so.
    const again = await request(app())
      .post('/api/signal/campaigns')
      .send({ name: 'clarity campaign' })
      .expect(200);
    expect(again.body.id).toBe(created.body.id);

    const listed = await request(app()).get('/api/signal/campaigns').expect(200);
    expect(listed.body).toEqual([{ id: created.body.id, name: 'Clarity Campaign', postCount: 0 }]);

    const renamed = await request(app())
      .patch(`/api/signal/campaigns/${created.body.id}`)
      .send({ name: 'Clarity' })
      .expect(200);
    expect(renamed.body.name).toBe('Clarity');

    await request(app()).delete(`/api/signal/campaigns/${created.body.id}`).expect(200);
    expect((await request(app()).get('/api/signal/campaigns').expect(200)).body).toEqual([]);
  });

  it('answers 404 for a campaign that is not there and 400 for a name that is not one', async () => {
    await request(app()).patch('/api/signal/campaigns/nope').send({ name: 'A' }).expect(404);
    await request(app()).delete('/api/signal/campaigns/nope').expect(404);
    await request(app()).post('/api/signal/campaigns').send({ name: '   ' }).expect(400);
    await request(app()).patch('/api/signal/campaigns/nope').send({}).expect(400);
  });

  it('names the campaign that already holds a name rather than reporting a constraint', async () => {
    const first = await request(app()).post('/api/signal/campaigns').send({ name: 'Clarity' });
    await request(app()).post('/api/signal/campaigns').send({ name: 'Explain' });
    const clash = await request(app())
      .patch(`/api/signal/campaigns/${first.body.id}`)
      .send({ name: 'explain' })
      .expect(409);
    expect(clash.body).toMatchObject({ code: 'SIGNAL_CAMPAIGN_NAME_TAKEN' });
    expect(clash.body.error).toContain('Explain');
  });

  it('names how many posts a deletion would detach, and detaches them once confirmed', async () => {
    const post = await request(app())
      .post('/api/signal/posts')
      .send({ text: 'Clarity as competitive advantage', campaigns: ['Wk4'] })
      .expect(201);
    const campaignId = post.body.campaigns[0].id as string;

    const refused = await request(app()).delete(`/api/signal/campaigns/${campaignId}`).expect(409);
    expect(refused.body).toMatchObject({ code: 'SIGNAL_CAMPAIGN_IN_USE', attachedPostCount: 1 });

    const confirmed = await request(app())
      .delete(`/api/signal/campaigns/${campaignId}?confirm=true`)
      .expect(200);
    expect(confirmed.body).toMatchObject({ deleted: 'signalCampaign', detachedFromPosts: 1 });
    const reread = await request(app()).get(`/api/signal/posts/${post.body.id}`).expect(200);
    expect(reread.body.campaigns).toEqual([]);
  });

  it('takes campaigns with the post, by name, and answers with the resolved records', async () => {
    const created = await request(app())
      .post('/api/signal/posts')
      .send({
        text: 'Clarity as competitive advantage',
        campaigns: ['Clarity Campaign', 'clarity campaign', 'Wk1'],
      })
      .expect(201);
    // Deduplicated case-insensitively before the join could refuse a repeat as an error.
    expect(created.body.campaigns.map((campaign: { name: string }) => campaign.name)).toEqual([
      'Clarity Campaign',
      'Wk1',
    ]);

    const patched = await request(app())
      .patch(`/api/signal/posts/${created.body.id}`)
      .send({ campaigns: [] })
      .expect(200);
    expect(patched.body.campaigns).toEqual([]);
    // Detaching a post leaves the workspace's list alone.
    expect((await request(app()).get('/api/signal/campaigns')).body).toHaveLength(2);
  });

  it('refuses more campaigns on one post than the shared bound allows', async () => {
    await request(app())
      .post('/api/signal/posts')
      .send({
        text: 'Clarity as competitive advantage',
        campaigns: Array.from({ length: 13 }, (_, index) => `Campaign ${index}`),
      })
      .expect(400);
  });
});
