import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUEUE_HEALTH_CONFIG,
  QUEUE_ALERT_KINDS,
  QUEUE_ALERT_KIND_LABEL,
  QUEUE_ALERT_KIND_SEVERITY,
  QUEUE_ALERT_SEVERITIES,
  QUEUE_ALERT_SEVERITY_LABEL,
  QUEUE_HEALTH_LIMITS,
  QUEUE_HEALTH_LOOKBACK_DAYS,
  deriveQueueHealth,
  queueCoverageChannels,
  queueHealthHeadline,
  queueHealthIsClear,
  type QueueAlertAcknowledgement,
  type QueueAlertKind,
  type QueueHealthConfig,
  type QueueHealthFacts,
  type QueueHealthNow,
} from './queue-health.ts';
import {
  signalPostName,
  signalSlotMinutesBetween,
  type SignalChannel,
  type SignalPost,
} from './signal.ts';
import type { PublicationState, SignalPublication, SignalPublicationTarget } from './publish.ts';
import type { ProviderInventoryPost } from './provider-inventory.ts';

/**
 * The rules, against fixtures rather than a page.
 *
 * Everything here is plain data in and plain data out: no database, no clock, no React. That is the
 * point of the module — an alert is a conclusion about rows, so its correctness is testable at this
 * level and nothing below it has to be rendered to find out whether the rule holds.
 */

const NOW: QueueHealthNow = {
  instant: '2026-08-19T14:00:00.000Z',
  slot: { date: '2026-08-19', time: '10:00' },
};

const config = (overrides: Partial<QueueHealthConfig> = {}): QueueHealthConfig => ({
  ...DEFAULT_QUEUE_HEALTH_CONFIG,
  ...overrides,
});

const post = (overrides: Partial<SignalPost> = {}): SignalPost => ({
  id: 'post-1',
  text: 'Clarity as competitive advantage',
  channels: ['x'],
  media: [],
  mediaUrls: [],
  date: '2026-08-19',
  time: '18:00',
  format: 'TEXT',
  status: 'SCHEDULED',
  campaigns: [],
  cta: 'NONE',
  position: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const target = (overrides: Partial<SignalPublicationTarget> = {}): SignalPublicationTarget => ({
  channel: 'x',
  platform: 'twitter',
  accountId: 11,
  handle: '@studio',
  mode: 'AUTOMATIC',
  ...overrides,
});

const publication = (overrides: Partial<SignalPublication> = {}): SignalPublication => ({
  id: 'pub-1',
  postId: 'post-1',
  state: 'SUBMITTED',
  provider: 'post-bridge',
  providerPostId: 'remote-1',
  scheduledInstant: '2026-08-19T22:00:00.000Z',
  timezone: 'America/New_York',
  sentCaption: 'Clarity as competitive advantage',
  sentChannels: ['x'],
  targets: [target()],
  checkAttempts: 0,
  createdAt: '2026-08-18T00:00:00.000Z',
  updatedAt: '2026-08-18T00:00:00.000Z',
  ...overrides,
});

const facts = (overrides: Partial<QueueHealthFacts> = {}): QueueHealthFacts => ({
  posts: [],
  publications: [],
  usedChannels: [],
  acknowledgements: [],
  ...overrides,
});

const derive = (
  overrides: Partial<QueueHealthFacts> = {},
  options: Partial<QueueHealthConfig> = {},
) => deriveQueueHealth(facts(overrides), config(options), NOW);

const kindsOf = (summary: { alerts: { kind: QueueAlertKind }[] }) =>
  summary.alerts.map((alert) => alert.kind);

const alertOf = (summary: ReturnType<typeof derive>, kind: QueueAlertKind) =>
  summary.alerts.find((alert) => alert.kind === kind);

describe('the vocabulary', () => {
  it('gives every kind a label and a severity, and every severity a label', () => {
    for (const kind of QUEUE_ALERT_KINDS) {
      expect(QUEUE_ALERT_KIND_LABEL[kind]).toBeTruthy();
      expect(QUEUE_ALERT_SEVERITIES).toContain(QUEUE_ALERT_KIND_SEVERITY[kind]);
    }
    for (const severity of QUEUE_ALERT_SEVERITIES)
      expect(QUEUE_ALERT_SEVERITY_LABEL[severity]).toBeTruthy();
  });

  it('bounds every window at one or more', () => {
    for (const limit of Object.values(QUEUE_HEALTH_LIMITS)) {
      expect(limit.min).toBeGreaterThanOrEqual(1);
      expect(limit.max).toBeGreaterThan(limit.min);
    }
  });
});

describe('slot arithmetic', () => {
  it('counts the distance between two labels without deriving a moment from either', () => {
    expect(
      signalSlotMinutesBetween(
        { date: '2026-08-19', time: '10:00' },
        { date: '2026-08-19', time: '18:00' },
      ),
    ).toBe(480);
    expect(
      signalSlotMinutesBetween(
        { date: '2026-08-19', time: '10:00' },
        { date: '2026-08-20', time: '09:00' },
      ),
    ).toBe(1380);
    expect(
      signalSlotMinutesBetween(
        { date: '2026-08-19', time: '10:00' },
        { date: '2026-08-18', time: '10:00' },
      ),
    ).toBe(-1440);
  });

  it('answers the same across a month, a year, and a leap day', () => {
    expect(
      signalSlotMinutesBetween(
        { date: '2026-08-31', time: '00:00' },
        { date: '2026-09-01', time: '00:00' },
      ),
    ).toBe(1440);
    expect(
      signalSlotMinutesBetween(
        { date: '2026-12-31', time: '23:00' },
        { date: '2027-01-01', time: '00:00' },
      ),
    ).toBe(60);
    expect(
      signalSlotMinutesBetween(
        { date: '2028-02-28', time: '00:00' },
        { date: '2028-03-01', time: '00:00' },
      ),
    ).toBe(2880);
  });

  it('names a post from its first line and says so when there is nothing to name', () => {
    expect(signalPostName('First line\nsecond line')).toBe('First line');
    expect(signalPostName('   ')).toBe('Untitled post');
    expect(signalPostName('a'.repeat(80))).toBe(`${'a'.repeat(60)}…`);
  });
});

describe('an empty workspace', () => {
  it('reports nothing and says so', () => {
    const summary = derive();
    expect(summary.alerts).toEqual([]);
    expect(summary.counts).toEqual({ action: 0, watch: 0, acknowledged: 0 });
    expect(queueHealthIsClear(summary)).toBe(true);
    expect(queueHealthHeadline(summary)).toBe('Nothing needs attention.');
    expect(summary.generatedAt).toBe(NOW.instant);
  });
});

describe('a delivery that went wrong', () => {
  it.each<[PublicationState, string]>([
    ['FAILED', 'Not delivered'],
    ['PARTIAL', 'Partly delivered'],
    ['UNCONFIRMED', 'Unconfirmed'],
  ])('reports %s as needing action', (state, title) => {
    const summary = derive({
      posts: [post()],
      publications: [publication({ state })],
    });
    const alert = alertOf(summary, 'DELIVERY_ATTENTION');
    expect(alert?.title).toBe(title);
    expect(alert?.severity).toBe('ACTION');
    expect(alert?.publicationId).toBe('pub-1');
  });

  it.each<PublicationState>(['SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'CANCELLED'])(
    'says nothing about %s',
    (state) => {
      const summary = derive({ posts: [post()], publications: [publication({ state })] });
      expect(kindsOf(summary)).not.toContain('DELIVERY_ATTENTION');
    },
  );

  it('names the accounts that failed', () => {
    const summary = derive({
      posts: [post()],
      publications: [
        publication({
          state: 'PARTIAL',
          targets: [
            target({ accountId: 11, outcome: 'SUCCESS' }),
            target({ accountId: 12, handle: '@second', outcome: 'FAILURE' }),
          ],
        }),
      ],
    });
    expect(alertOf(summary, 'DELIVERY_ATTENTION')?.detail).toContain('@second did not go out.');
  });

  it('links to the post rather than to the publication', () => {
    const summary = derive({ posts: [post()], publications: [publication({ state: 'FAILED' })] });
    expect(alertOf(summary, 'DELIVERY_ATTENTION')?.href).toBe('/signal?post=post-1');
  });

  it('names the post from the delivery snapshot when the post itself is not to hand', () => {
    const summary = derive({ publications: [publication({ state: 'FAILED' })] });
    expect(alertOf(summary, 'DELIVERY_ATTENTION')?.subject).toBe(
      'Clarity as competitive advantage',
    );
  });
});

describe('a slot coming up with nothing submitted', () => {
  it('reports a scheduled post inside the window', () => {
    const summary = derive({ posts: [post({ time: '18:00' })] });
    const alert = alertOf(summary, 'SLOT_APPROACHING');
    expect(alert?.title).toBe('Nothing submitted yet');
    expect(alert?.detail).toContain('about 8 hours away');
    expect(alert?.postId).toBe('post-1');
  });

  it('says so differently once the slot has passed, and asks again after it does', () => {
    const soon = alertOf(derive({ posts: [post({ time: '18:00' })] }), 'SLOT_APPROACHING');
    const passed = alertOf(derive({ posts: [post({ time: '08:00' })] }), 'SLOT_APPROACHING');
    expect(passed?.title).toBe('Its slot passed with nothing submitted');
    expect(passed?.id).toBe(soon?.id);
    // Same alert, different situation: an acknowledgement taken while it was still coming up does
    // not carry over to the one that says it went by unsent.
    expect(passed?.fingerprint).not.toBe(soon?.fingerprint);
  });

  it('leaves a slot beyond the window alone, and reports it once the window widens', () => {
    const later = [post({ date: '2026-08-22', time: '09:00' })];
    expect(kindsOf(derive({ posts: later }))).not.toContain('SLOT_APPROACHING');
    expect(kindsOf(derive({ posts: later }, { approachingHours: 96 }))).toContain(
      'SLOT_APPROACHING',
    );
  });

  it('lets go of a plan older than the lookback', () => {
    const stale = post({ date: '2026-06-01', time: '09:00' });
    expect(
      signalSlotMinutesBetween(NOW.slot, { date: stale.date as string, time: stale.time }),
    ).toBeLessThan(-QUEUE_HEALTH_LOOKBACK_DAYS * 1440);
    expect(kindsOf(derive({ posts: [stale] }))).not.toContain('SLOT_APPROACHING');
  });

  it('says nothing about a draft or a post already marked published', () => {
    expect(kindsOf(derive({ posts: [post({ status: 'DRAFT' })] }))).not.toContain(
      'SLOT_APPROACHING',
    );
    expect(kindsOf(derive({ posts: [post({ status: 'PUBLISHED' })] }))).not.toContain(
      'SLOT_APPROACHING',
    );
  });

  it('says nothing about an unscheduled post, which has no slot to approach', () => {
    expect(kindsOf(derive({ posts: [post({ date: null })] }))).not.toContain('SLOT_APPROACHING');
  });

  it.each<PublicationState>(['SUBMITTING', 'SUBMITTED', 'CONFIRMED', 'PARTIAL'])(
    'treats %s as something being with the provider',
    (state) => {
      const summary = derive({ posts: [post()], publications: [publication({ state })] });
      expect(kindsOf(summary)).not.toContain('SLOT_APPROACHING');
    },
  );

  it.each<PublicationState>(['FAILED', 'CANCELLED', 'UNCONFIRMED'])(
    'still reports the slot when the only submission is %s',
    (state) => {
      const summary = derive({ posts: [post()], publications: [publication({ state })] });
      expect(kindsOf(summary)).toContain('SLOT_APPROACHING');
    },
  );
});

describe('a delivery waiting on a person', () => {
  it('reports a manual-finish target the provider accepted', () => {
    const summary = derive({
      posts: [post()],
      publications: [
        publication({
          state: 'CONFIRMED',
          targets: [target({ mode: 'MANUAL_FINISH', outcome: 'SUCCESS' })],
        }),
      ],
    });
    const alert = alertOf(summary, 'MANUAL_FINISH_WAITING');
    expect(alert?.title).toBe('@studio is waiting for you to finish it');
    expect(alert?.severity).toBe('ACTION');
    expect(alert?.id).toBe('MANUAL_FINISH_WAITING:pub-1:11');
  });

  it('reports a provider draft the same way, because both stop short of a reader', () => {
    const summary = derive({
      publications: [
        publication({ targets: [target({ mode: 'PROVIDER_DRAFT', outcome: 'SUCCESS' })] }),
      ],
    });
    expect(kindsOf(summary)).toContain('MANUAL_FINISH_WAITING');
  });

  it('stops once the person has recorded it', () => {
    const summary = derive({
      publications: [
        publication({
          targets: [
            target({
              mode: 'MANUAL_FINISH',
              outcome: 'SUCCESS',
              manualCompletedAt: '2026-08-19T12:00:00.000Z',
            }),
          ],
        }),
      ],
    });
    expect(kindsOf(summary)).not.toContain('MANUAL_FINISH_WAITING');
  });

  it('says nothing about an automatic target, which has nothing for anyone to finish', () => {
    const summary = derive({
      publications: [publication({ targets: [target({ outcome: 'SUCCESS' })] })],
    });
    expect(kindsOf(summary)).not.toContain('MANUAL_FINISH_WAITING');
  });

  it('says nothing before the provider has accepted it', () => {
    const summary = derive({
      publications: [publication({ targets: [target({ mode: 'MANUAL_FINISH' })] })],
    });
    expect(kindsOf(summary)).not.toContain('MANUAL_FINISH_WAITING');
  });

  it('names the channel when the handle was never recorded', () => {
    const summary = derive({
      publications: [
        publication({
          targets: [target({ handle: '', mode: 'MANUAL_FINISH', outcome: 'SUCCESS' })],
        }),
      ],
    });
    expect(alertOf(summary, 'MANUAL_FINISH_WAITING')?.title).toBe(
      'X is waiting for you to finish it',
    );
  });
});

describe('a provider answer that moved', () => {
  it('reports the move the last check made, both states named', () => {
    const summary = derive({
      publications: [
        publication({
          state: 'CONFIRMED',
          checkedState: 'CONFIRMED',
          priorState: 'SUBMITTED',
          checkedAt: '2026-08-19T13:00:00.000Z',
        }),
      ],
    });
    const alert = alertOf(summary, 'PROVIDER_STATE_CHANGED');
    expect(alert?.title).toBe('Accepted, not out yet → Delivered');
    expect(alert?.severity).toBe('WATCH');
  });

  it('says nothing when the check found the state it already had', () => {
    const summary = derive({
      publications: [publication({ checkedState: 'SUBMITTED' })],
    });
    expect(kindsOf(summary)).not.toContain('PROVIDER_STATE_CHANGED');
  });

  it('says nothing before the provider has been asked once', () => {
    expect(kindsOf(derive({ publications: [publication()] }))).not.toContain(
      'PROVIDER_STATE_CHANGED',
    );
  });

  it('stops reporting a move the user has already answered', () => {
    // A cancel after the check leaves `state` and `checkedState` apart, which is the guard: the
    // provider's news has been overtaken by the person's own action.
    const summary = derive({
      publications: [
        publication({ state: 'CANCELLED', checkedState: 'SUBMITTED', priorState: 'SUBMITTING' }),
      ],
    });
    expect(kindsOf(summary)).not.toContain('PROVIDER_STATE_CHANGED');
  });
});

describe('a channel with nothing planned', () => {
  const used: SignalChannel[] = ['x', 'li'];

  it('reports every used channel with no future post inside the window', () => {
    const summary = derive({ usedChannels: used });
    expect(summary.alerts.filter((alert) => alert.kind === 'CHANNEL_UNCOVERED')).toHaveLength(2);
    const alert = alertOf(summary, 'CHANNEL_UNCOVERED');
    expect(alert?.title).toBe('Nothing planned for the next 14 days');
    expect(alert?.href).toBe('/signal');
    expect(alert?.postId).toBeUndefined();
  });

  it('counts a dated draft inside the window as something planned', () => {
    const summary = derive({
      usedChannels: used,
      posts: [post({ channels: ['x'], status: 'DRAFT', date: '2026-08-25' })],
    });
    expect(summary.alerts.filter((alert) => alert.kind === 'CHANNEL_UNCOVERED')).toHaveLength(1);
    expect(alertOf(summary, 'CHANNEL_UNCOVERED')?.channel).toBe('li');
  });

  it('does not count a post already published, whatever its date says', () => {
    const summary = derive({
      usedChannels: ['x'],
      posts: [post({ channels: ['x'], status: 'PUBLISHED', date: '2026-08-25' })],
    });
    expect(kindsOf(summary)).toContain('CHANNEL_UNCOVERED');
  });

  it('does not count a post whose slot has already passed', () => {
    const summary = derive({
      usedChannels: ['x'],
      posts: [post({ channels: ['x'], date: '2026-08-19', time: '08:00' })],
    });
    expect(kindsOf(summary)).toContain('CHANNEL_UNCOVERED');
  });

  it('does not count a post beyond the window, and does once the window reaches it', () => {
    const ahead = [post({ channels: ['x'], date: '2026-09-20' })];
    expect(kindsOf(derive({ usedChannels: ['x'], posts: ahead }))).toContain('CHANNEL_UNCOVERED');
    expect(
      kindsOf(derive({ usedChannels: ['x'], posts: ahead }, { coverageDays: 60 })),
    ).not.toContain('CHANNEL_UNCOVERED');
  });

  it('asks only about configured channels once a list is given', () => {
    const summary = derive({ usedChannels: used }, { coverageChannels: ['ig'] });
    const channels = summary.alerts
      .filter((alert) => alert.kind === 'CHANNEL_UNCOVERED')
      .map((alert) => alert.channel);
    expect(channels).toEqual(['ig']);
  });

  it('says nothing at all about a workspace that has used no channels', () => {
    expect(kindsOf(derive())).not.toContain('CHANNEL_UNCOVERED');
  });

  it('reads a window of one day as a day', () => {
    expect(
      alertOf(derive({ usedChannels: ['x'] }, { coverageDays: 1 }), 'CHANNEL_UNCOVERED')?.title,
    ).toBe('Nothing planned for the next 1 day');
  });

  it('resolves the coverage list from the configuration, then from what is used', () => {
    expect(queueCoverageChannels({ coverageChannels: ['li', 'x'] }, ['ig'])).toEqual(['li', 'x']);
    expect(queueCoverageChannels({ coverageChannels: [] }, ['x', 'ig', 'x'])).toEqual(['ig', 'x']);
  });
});

describe('a synchronisation that is behind', () => {
  const awaiting = [publication({ state: 'SUBMITTED' })];

  it('reports a rate limit the provider is still holding us to', () => {
    const summary = derive({
      sync: { rateLimitedUntil: '2026-08-19T15:00:00.000Z', lastSyncedAt: NOW.instant },
    });
    const alert = alertOf(summary, 'SYNC_BEHIND');
    expect(alert?.title).toBe('The provider is rate-limiting us');
    expect(alert?.severity).toBe('WATCH');
  });

  it('lets go of a rate limit that has expired', () => {
    const summary = derive({ sync: { rateLimitedUntil: '2026-08-19T13:00:00.000Z' } });
    expect(kindsOf(summary)).not.toContain('SYNC_BEHIND');
  });

  it('reports a stale synchronisation while an answer is outstanding', () => {
    const summary = derive({
      publications: awaiting,
      sync: { lastSyncedAt: '2026-08-19T01:00:00.000Z' },
    });
    expect(alertOf(summary, 'SYNC_BEHIND')?.detail).toContain('1 submission is waiting');
  });

  it('counts more than one outstanding submission as more than one', () => {
    const summary = derive({
      publications: [publication(), publication({ id: 'pub-2', postId: 'post-2' })],
      sync: { lastSyncedAt: '2026-08-19T01:00:00.000Z' },
    });
    expect(alertOf(summary, 'SYNC_BEHIND')?.detail).toContain('2 submissions are waiting');
  });

  it('says nothing while the last synchronisation is inside the window', () => {
    const summary = derive({
      publications: awaiting,
      sync: { lastSyncedAt: '2026-08-19T10:00:00.000Z' },
    });
    expect(kindsOf(summary)).not.toContain('SYNC_BEHIND');
  });

  it('says nothing when nothing is waiting on the provider', () => {
    const summary = derive({
      publications: [publication({ state: 'CONFIRMED' })],
      sync: { lastSyncedAt: '2026-08-01T00:00:00.000Z' },
    });
    expect(kindsOf(summary)).not.toContain('SYNC_BEHIND');
  });

  it('does not treat a publication with no provider id as waiting on the provider', () => {
    const summary = derive({
      publications: [publication({ providerPostId: undefined })],
      sync: { lastSyncedAt: '2026-08-01T00:00:00.000Z' },
    });
    expect(kindsOf(summary)).not.toContain('SYNC_BEHIND');
  });

  it('makes no claim about a workspace that has never synchronised', () => {
    expect(kindsOf(derive({ publications: awaiting }))).not.toContain('SYNC_BEHIND');
    expect(kindsOf(derive({ publications: awaiting, sync: {} }))).not.toContain('SYNC_BEHIND');
  });
});

describe('acknowledgement', () => {
  // Published, so the failed delivery is the only alert the fixture raises and the counts below
  // are about acknowledgement rather than about which other rules happened to fire.
  const failed = {
    posts: [post({ status: 'PUBLISHED' as const })],
    publications: [publication({ state: 'FAILED' as const })],
  };
  const seen = (fingerprint: string): QueueAlertAcknowledgement => ({
    alertId: 'DELIVERY_ATTENTION:pub-1',
    fingerprint,
    acknowledgedAt: '2026-08-19T13:00:00.000Z',
  });

  it('marks the alert seen and takes it out of the live counts', () => {
    const live = derive(failed);
    const alert = alertOf(live, 'DELIVERY_ATTENTION');
    const summary = derive({ ...failed, acknowledgements: [seen(alert?.fingerprint as string)] });
    const acknowledged = alertOf(summary, 'DELIVERY_ATTENTION');
    expect(acknowledged?.acknowledged).toBe(true);
    expect(acknowledged?.acknowledgedAt).toBe('2026-08-19T13:00:00.000Z');
    expect(summary.counts).toEqual({ action: 0, watch: 0, acknowledged: 1 });
    expect(queueHealthIsClear(summary)).toBe(true);
    expect(queueHealthHeadline(summary)).toBe('Nothing needs attention. 1 acknowledged.');
  });

  it('brings the alert back once the facts move', () => {
    const summary = derive({ ...failed, acknowledgements: [seen('FAILED|')] });
    const worse = deriveQueueHealth(
      facts({
        posts: [post({ status: 'PUBLISHED' })],
        publications: [
          publication({
            state: 'FAILED',
            targets: [target({ accountId: 12, outcome: 'FAILURE' })],
          }),
        ],
        acknowledgements: [seen('FAILED|')],
      }),
      config(),
      NOW,
    );
    expect(alertOf(summary, 'DELIVERY_ATTENTION')?.acknowledged).toBe(true);
    expect(alertOf(worse, 'DELIVERY_ATTENTION')?.acknowledged).toBe(false);
  });

  it('ignores an acknowledgement for an alert that is not there', () => {
    const summary = derive({
      ...failed,
      acknowledgements: [{ ...seen('x'), alertId: 'CHANNEL_UNCOVERED:ig' }],
    });
    expect(summary.counts.acknowledged).toBe(0);
    expect(summary.alerts.every((alert) => !alert.acknowledged)).toBe(true);
  });
});

describe('order and headline', () => {
  it('puts live alerts before acknowledged ones and action before watch', () => {
    const summary = derive({
      posts: [post({ id: 'post-1', time: '18:00' })],
      publications: [
        publication({
          state: 'FAILED',
          checkedState: 'FAILED',
          priorState: 'SUBMITTED',
          targets: [target({ mode: 'MANUAL_FINISH', outcome: 'SUCCESS' })],
        }),
      ],
      usedChannels: ['ig'],
    });
    expect(kindsOf(summary)).toEqual([
      'DELIVERY_ATTENTION',
      'MANUAL_FINISH_WAITING',
      'SLOT_APPROACHING',
      'PROVIDER_STATE_CHANGED',
      'CHANNEL_UNCOVERED',
    ]);
    expect(summary.counts).toEqual({ action: 3, watch: 2, acknowledged: 0 });
    expect(queueHealthHeadline(summary)).toBe('3 need action, 2 worth watching.');
  });

  it('sorts alerts of one kind by the subject they name', () => {
    const summary = derive({ usedChannels: ['x', 'ig', 'li'] });
    expect(summary.alerts.map((alert) => alert.subject)).toEqual(['Instagram', 'LinkedIn', 'X']);
  });

  it('reads a single alert in the singular', () => {
    expect(queueHealthHeadline(derive({ usedChannels: ['x'] }))).toBe('1 worth watching.');
    expect(
      queueHealthHeadline(
        derive({
          posts: [post({ status: 'PUBLISHED' })],
          publications: [publication({ state: 'FAILED' })],
        }),
      ),
    ).toBe('1 needs action.');
  });

  it('carries the configuration it was measured with', () => {
    expect(derive({}, { coverageDays: 3 }).config.coverageDays).toBe(3);
  });
});

describe('posts in the provider this app did not send', () => {
  const listed = (overrides: Partial<ProviderInventoryPost> = {}): ProviderInventoryPost => ({
    providerPostId: 'remote-9',
    state: 'SCHEDULED',
    scheduledInstant: '2026-08-20T13:00:00.000Z',
    captionExcerpt: 'Scheduled straight in Post Bridge',
    accountIds: [11],
    ...overrides,
  });

  it('says nothing at all when nobody has read the provider', () => {
    expect(kindsOf(derive({ publications: [publication()] }))).not.toContain('PROVIDER_ORPHAN');
  });

  it('raises exactly one alert for a listed post with no local publication', () => {
    const summary = derive({ providerPosts: [listed()], knownProviderPostIds: [] });
    const orphan = alertOf(summary, 'PROVIDER_ORPHAN');
    expect(summary.alerts.filter((alert) => alert.kind === 'PROVIDER_ORPHAN')).toHaveLength(1);
    expect(orphan?.severity).toBe('WATCH');
    expect(orphan?.title).toBe('1 post in Post Bridge this app did not send');
    expect(orphan?.detail).toContain('Scheduled straight in Post Bridge');
    expect(orphan?.detail).toContain('nothing here can adopt, change, or withdraw it');
    expect(orphan?.href).toBe('/signal');
    // It is about the provider rather than about one of this workspace's posts, so it names no post.
    expect(orphan?.postId).toBeUndefined();
    expect(orphan?.publicationId).toBeUndefined();
  });

  it('raises none for a listed post a publication claims', () => {
    const summary = derive({
      providerPosts: [listed({ providerPostId: 'remote-1' })],
      knownProviderPostIds: ['remote-1'],
    });
    expect(kindsOf(summary)).not.toContain('PROVIDER_ORPHAN');
  });

  it('counts them together, names the first three, and says how many more there are', () => {
    const summary = derive({
      providerPosts: [
        listed({ providerPostId: 'a', captionExcerpt: 'One' }),
        listed({ providerPostId: 'b', captionExcerpt: 'Two' }),
        listed({ providerPostId: 'c', captionExcerpt: 'Three' }),
        listed({ providerPostId: 'd', captionExcerpt: 'Four' }),
      ],
      knownProviderPostIds: [],
    });
    const orphan = alertOf(summary, 'PROVIDER_ORPHAN');
    expect(orphan?.title).toBe('4 posts in Post Bridge this app did not send');
    expect(orphan?.detail).toContain('and 1 more');
    expect(orphan?.detail).not.toContain('Four');
  });

  it('names a post with no caption by its state and its id', () => {
    const summary = derive({
      providerPosts: [listed({ captionExcerpt: '', state: 'DRAFT', providerPostId: 'remote-3' })],
      knownProviderPostIds: [],
    });
    expect(alertOf(summary, 'PROVIDER_ORPHAN')?.detail).toContain('Held as a draft · remote-3');
  });

  it('acknowledges, and comes back live once one of them is published', () => {
    const orphans = { providerPosts: [listed()], knownProviderPostIds: [] };
    const live = alertOf(derive(orphans), 'PROVIDER_ORPHAN');
    const acknowledgement: QueueAlertAcknowledgement = {
      alertId: live?.id as string,
      fingerprint: live?.fingerprint as string,
      acknowledgedAt: '2026-08-19T13:00:00.000Z',
    };
    expect(
      alertOf(derive({ ...orphans, acknowledgements: [acknowledgement] }), 'PROVIDER_ORPHAN')
        ?.acknowledged,
    ).toBe(true);
    const published = derive({
      providerPosts: [listed({ state: 'PUBLISHED' })],
      knownProviderPostIds: [],
      acknowledgements: [acknowledgement],
    });
    expect(alertOf(published, 'PROVIDER_ORPHAN')?.acknowledged).toBe(false);
  });

  it('comes back live when a second one appears, rather than hiding under the first', () => {
    const live = alertOf(
      derive({ providerPosts: [listed({ providerPostId: 'a' })], knownProviderPostIds: [] }),
      'PROVIDER_ORPHAN',
    );
    const both = derive({
      providerPosts: [listed({ providerPostId: 'a' }), listed({ providerPostId: 'b' })],
      knownProviderPostIds: [],
      acknowledgements: [
        {
          alertId: live?.id as string,
          fingerprint: live?.fingerprint as string,
          acknowledgedAt: '2026-08-19T13:00:00.000Z',
        },
      ],
    });
    expect(alertOf(both, 'PROVIDER_ORPHAN')?.acknowledged).toBe(false);
  });

  it('reads last of the watch alerts, after the ones about this workspace itself', () => {
    const summary = derive({
      usedChannels: ['x'],
      providerPosts: [listed()],
      knownProviderPostIds: [],
    });
    expect(kindsOf(summary)).toEqual(['CHANNEL_UNCOVERED', 'PROVIDER_ORPHAN']);
  });
});
