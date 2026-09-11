import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.ts';
import { listIntegrationEvents } from '../integration-log.ts';
import type { PublishPreview, SignalPublication } from '../../shared/publish.ts';
import {
  createPublishConfirmation,
  decidePublishConfirmation,
  getPublishConfirmation,
  listPublishConfirmations,
  PublishConfirmationError,
  summarizePublishConfirmations,
} from './confirmations.ts';

let db: Db;
const NOW = new Date('2026-09-11T12:00:00.000Z');

beforeEach(() => {
  db = createDb(':memory:');
});

const preview = (overrides: Partial<PublishPreview> = {}): PublishPreview => ({
  available: true,
  postId: 'post-1',
  planHash: 'a'.repeat(64),
  caption: 'Launch',
  timing: 'scheduled',
  scheduledInstant: '2026-09-15T14:00:00.000Z',
  timezone: 'America/New_York',
  targets: [
    {
      channel: 'li',
      platform: 'linkedin',
      accountId: 1,
      handle: '@studio',
      mode: 'AUTOMATIC',
    },
  ],
  channels: [],
  warnings: [],
  refusals: [],
  ...overrides,
});

const publication = (state: SignalPublication['state'] = 'CONFIRMED'): SignalPublication =>
  ({
    id: 'publication-1',
    postId: 'post-1',
    state,
    provider: 'post-bridge',
    providerPostId: 'remote-1',
    scheduledInstant: '2026-09-15T14:00:00.000Z',
    timezone: 'America/New_York',
    sentCaption: 'Launch',
    sentChannels: ['li'],
    targets: [],
    checkAttempts: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }) as unknown as SignalPublication;

describe('publish confirmation requests', () => {
  it('persists a stable preview, deduplicates the agent request, and audits it', () => {
    const input = {
      agentLabel: 'content-agent',
      clientRequestId: 'request-1',
      timing: 'scheduled' as const,
    };
    const first = createPublishConfirmation(db, input, preview(), NOW);
    const replay = createPublishConfirmation(db, input, preview(), NOW);

    expect(replay).toMatchObject({ id: first.id, planHash: 'a'.repeat(64), status: 'PENDING' });
    expect(listPublishConfirmations(db, 'PENDING', NOW)).toHaveLength(1);
    expect(listIntegrationEvents(db, { correlationId: first.id })).toHaveLength(1);
  });

  it('validates timing, refusal, replay identity, and the full bounded confirmation text', () => {
    expect(() =>
      createPublishConfirmation(
        db,
        { agentLabel: 'content-agent', clientRequestId: 'bad-preview', timing: 'scheduled' },
        preview({ available: false, refusals: ['Provider is unavailable.'] }),
        NOW,
      ),
    ).toThrowError(/Provider is unavailable/);
    expect(() =>
      createPublishConfirmation(
        db,
        { agentLabel: 'content-agent', clientRequestId: 'bad-timing', timing: 'now' },
        preview(),
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE', status: 409 }));

    const request = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'replay-id', timing: 'scheduled' },
      preview(),
      NOW,
    );
    expect(() =>
      createPublishConfirmation(
        db,
        { agentLabel: 'content-agent', clientRequestId: 'replay-id', timing: 'scheduled' },
        preview({ postId: 'another-post' }),
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: 'DECIDED', status: 409 }));
    expect(request.confirmation).toContain('@studio');

    const immediate = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'now-1', timing: 'now' },
      preview({
        timing: 'now',
        scheduledInstant: undefined,
        caption: 'x'.repeat(121),
        targets: [],
      }),
      NOW,
    );
    expect(immediate.confirmation).toContain('now');
    expect(immediate.confirmation).toContain('the selected channels');
    expect(immediate.confirmation).toContain('...');
    const noTargets = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'now-empty', timing: 'now' },
      preview({ timing: 'now', scheduledInstant: undefined, targets: [] }),
      NOW,
    );
    expect(noTargets.confirmation).toContain('the selected channels');
  });

  it('denies without executing and keeps the post request unchanged', async () => {
    const request = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'deny-1', timing: 'scheduled' },
      preview(),
      NOW,
    );
    let executions = 0;
    const denied = await decidePublishConfirmation(
      db,
      request.id,
      'deny',
      async () => {
        executions += 1;
        return publication();
      },
      NOW,
    );

    expect(denied.status).toBe('DENIED');
    expect(executions).toBe(0);
    expect(getPublishConfirmation(db, request.id, NOW).error).toBe('Denied by operator.');
    expect(listIntegrationEvents(db, { correlationId: request.id })[0]?.outcome).toBe('FAILURE');
  });

  it('records provider uncertainty and refuses a stale approval', async () => {
    const uncertain = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'uncertain-1', timing: 'scheduled' },
      preview({ planHash: 'b'.repeat(64) }),
      NOW,
    );
    const uncertainResult = await decidePublishConfirmation(
      db,
      uncertain.id,
      'approve',
      async () => publication('UNCONFIRMED'),
      NOW,
    );
    expect(uncertainResult.status).toBe('PROVIDER_UNCERTAIN');

    const stale = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'stale-1', timing: 'scheduled' },
      preview(),
      NOW,
    );
    await expect(
      decidePublishConfirmation(
        db,
        stale.id,
        'approve',
        async () => {
          throw new PublishConfirmationError('This publish confirmation is stale.', 409, 'STALE');
        },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409, code: 'STALE' });
    expect(getPublishConfirmation(db, stale.id, NOW).status).toBe('EXPIRED');
  });

  it('records definite provider failures and refuses terminal requests', async () => {
    const failed = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'failed-1', timing: 'scheduled' },
      preview(),
      NOW,
    );
    await expect(
      decidePublishConfirmation(
        db,
        failed.id,
        'approve',
        async () => {
          throw new Error('provider refused this publish');
        },
        NOW,
      ),
    ).rejects.toThrow('provider refused this publish');
    expect(getPublishConfirmation(db, failed.id, NOW).status).toBe('FAILED');
    await expect(
      decidePublishConfirmation(db, failed.id, 'deny', async () => publication(), NOW),
    ).rejects.toMatchObject({ code: 'DECIDED', status: 409 });
  });

  it('expires old pending work and reports bounded queue state', () => {
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
    const request = createPublishConfirmation(
      db,
      { agentLabel: 'content-agent', clientRequestId: 'old-1', timing: 'scheduled' },
      preview(),
      old,
    );
    expect(summarizePublishConfirmations(db, NOW)).toMatchObject({
      pendingCount: 0,
      expiredCount: 1,
      limits: { pendingCount: 20 },
    });
    expect(getPublishConfirmation(db, request.id, NOW).status).toBe('EXPIRED');
  });

  it('refuses a twenty-first pending request', () => {
    for (let index = 0; index < 20; index += 1)
      createPublishConfirmation(
        db,
        { agentLabel: 'content-agent', clientRequestId: `limit-${index}`, timing: 'scheduled' },
        preview({ postId: `limit-post-${index}` }),
        NOW,
      );
    expect(() =>
      createPublishConfirmation(
        db,
        { agentLabel: 'content-agent', clientRequestId: 'limit-20', timing: 'scheduled' },
        preview({ postId: 'limit-post-20' }),
        NOW,
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID', status: 409 }));
  });
});
