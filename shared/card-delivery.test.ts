import { describe, expect, it } from 'vitest';
import {
  CARD_DELIVERY_LABEL,
  CARD_DELIVERY_STATES,
  cardDeliveryFor,
  cardDeliveryFromPublication,
  deriveCardDeliveries,
} from './card-delivery.ts';
import type { SignalPublication, SignalPublicationTarget } from './publish.ts';

/**
 * Card delivery derivation, against fixtures rather than a page.
 *
 * The claim of the card is that planning status and delivery status stay two named facts, and that
 * partial / ambiguous / manual-finish answers survive rather than collapsing into "scheduled".
 */

const target = (overrides: Partial<SignalPublicationTarget> = {}): SignalPublicationTarget => ({
  channel: 'x',
  platform: 'twitter',
  accountId: 4,
  handle: '@gholmes',
  mode: 'AUTOMATIC',
  ...overrides,
});

const publication = (overrides: Partial<SignalPublication> = {}): SignalPublication => ({
  id: 'publication-1',
  postId: 'post-1',
  state: 'SUBMITTED',
  provider: 'post-bridge',
  providerPostId: 'provider-1',
  scheduledInstant: '2026-09-20T13:00:00.000Z',
  timezone: 'America/New_York',
  sentCaption: 'A campaign post',
  sentMedia: [],
  sentChannels: ['x'],
  targets: [target()],
  checkAttempts: 0,
  createdAt: '2026-09-14T09:00:00.000Z',
  updatedAt: '2026-09-14T09:00:00.000Z',
  ...overrides,
});

describe('card delivery derivation', () => {
  it('names every card state without reusing planning-status words', () => {
    expect([...CARD_DELIVERY_STATES]).toEqual([
      'NONE',
      'IN_FLIGHT',
      'DELIVERED',
      'PARTIAL',
      'FAILED',
      'AMBIGUOUS',
      'MANUAL',
    ]);
    for (const state of CARD_DELIVERY_STATES) {
      expect(CARD_DELIVERY_LABEL[state]).toBeTruthy();
      expect(CARD_DELIVERY_LABEL[state]).not.toMatch(/draft|scheduled|published/i);
    }
  });

  it('reports not submitted when there is no live publication', () => {
    expect(cardDeliveryFor('post-1', [])).toEqual({
      postId: 'post-1',
      state: 'NONE',
      label: 'Not submitted',
    });
    expect(cardDeliveryFor('post-1', [publication({ state: 'CANCELLED' })])).toEqual({
      postId: 'post-1',
      state: 'NONE',
      label: 'Not submitted',
    });
  });

  it('keeps in-flight, delivered, partial, failed, and ambiguous as distinct answers', () => {
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'SUBMITTING' })).state).toBe(
      'IN_FLIGHT',
    );
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'SUBMITTED' })).state).toBe(
      'IN_FLIGHT',
    );
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'CONFIRMED' })).state).toBe(
      'DELIVERED',
    );
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'PARTIAL' })).state).toBe(
      'PARTIAL',
    );
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'FAILED' })).state).toBe(
      'FAILED',
    );
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'UNCONFIRMED' })).state).toBe(
      'AMBIGUOUS',
    );
  });

  it('does not collapse partial or ambiguous into failed or not submitted', () => {
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'PARTIAL' }))).toEqual({
      postId: 'post-1',
      state: 'PARTIAL',
      label: 'Partly delivered',
    });
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'UNCONFIRMED' }))).toEqual({
      postId: 'post-1',
      state: 'AMBIGUOUS',
      label: 'Unconfirmed',
    });
  });

  it('maps a cancelled publication to not submitted when asked directly', () => {
    expect(cardDeliveryFromPublication('post-1', publication({ state: 'CANCELLED' }))).toEqual({
      postId: 'post-1',
      state: 'NONE',
      label: 'Not submitted',
    });
  });

  it('stays in flight for a manual-finish target the provider has not accepted yet', () => {
    const pending = publication({
      targets: [
        target({
          channel: 'tt',
          platform: 'tiktok',
          mode: 'MANUAL_FINISH',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', pending).state).toBe('IN_FLIGHT');
  });

  it('stays in flight when a manual-finish target failed', () => {
    const failed = publication({
      targets: [
        target({
          channel: 'tt',
          platform: 'tiktok',
          mode: 'MANUAL_FINISH',
          outcome: 'FAILURE',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', failed).state).toBe('IN_FLIGHT');
  });

  it('treats a provider-draft wait the same as a manual finish', () => {
    const draft = publication({
      targets: [
        target({
          mode: 'PROVIDER_DRAFT',
          outcome: 'SUCCESS',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', draft).state).toBe('MANUAL');
  });

  it('does not treat a finished automatic target as a manual completion', () => {
    const automatic = publication({
      targets: [
        target({
          mode: 'AUTOMATIC',
          outcome: 'SUCCESS',
          manualCompletedAt: '2026-09-14T12:00:00.000Z',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', automatic).state).toBe('IN_FLIGHT');
  });

  it('keeps a mixed manual finish in progress when any target still failed', () => {
    const mixed = publication({
      targets: [
        target({
          channel: 'tt',
          platform: 'tiktok',
          accountId: 8,
          mode: 'MANUAL_FINISH',
          outcome: 'SUCCESS',
          manualCompletedAt: '2026-09-14T12:00:00.000Z',
        }),
        target({
          channel: 'x',
          accountId: 4,
          mode: 'AUTOMATIC',
          outcome: 'FAILURE',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', mixed).state).toBe('IN_FLIGHT');
  });

  it('reads delivered once every manual-finish target is marked finished', () => {
    const finished = publication({
      targets: [
        target({
          channel: 'tt',
          platform: 'tiktok',
          mode: 'MANUAL_FINISH',
          outcome: 'SUCCESS',
          manualCompletedAt: '2026-09-14T12:00:00.000Z',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', finished).state).toBe('DELIVERED');
  });

  it('lets partial outrank a concurrent manual-finish wait', () => {
    const split = publication({
      state: 'PARTIAL',
      targets: [
        target({ outcome: 'SUCCESS' }),
        target({
          channel: 'tt',
          platform: 'tiktok',
          accountId: 8,
          mode: 'MANUAL_FINISH',
          outcome: 'SUCCESS',
        }),
      ],
    });
    expect(cardDeliveryFromPublication('post-1', split).state).toBe('PARTIAL');
  });

  it('uses the newest non-cancelled publication for a post', () => {
    const older = publication({
      id: 'old',
      state: 'FAILED',
      createdAt: '2026-09-10T09:00:00.000Z',
    });
    const newer = publication({
      id: 'new',
      state: 'CONFIRMED',
      createdAt: '2026-09-14T09:00:00.000Z',
    });
    expect(cardDeliveryFor('post-1', [older, newer]).state).toBe('DELIVERED');
    expect(
      cardDeliveryFor('post-1', [newer, publication({ id: 'cancelled', state: 'CANCELLED' })])
        .state,
    ).toBe('DELIVERED');
  });

  it('derives one answer per post id in the batch', () => {
    const deliveries = deriveCardDeliveries(
      ['post-1', 'post-2', 'post-3'],
      [
        publication({ postId: 'post-1', state: 'CONFIRMED' }),
        publication({
          id: 'publication-2',
          postId: 'post-2',
          state: 'FAILED',
          createdAt: '2026-09-14T10:00:00.000Z',
        }),
      ],
    );
    expect(deliveries.map((entry) => entry.state)).toEqual(['DELIVERED', 'FAILED', 'NONE']);
  });
});
