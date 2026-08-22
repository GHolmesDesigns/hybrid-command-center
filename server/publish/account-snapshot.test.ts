import { describe, expect, it } from 'vitest';
import {
  publicationDriftFields,
  type PublishPreview,
  type SignalPublication,
} from '../../shared/publish.ts';

/**
 * The per-account snapshot, and the one distinction it exists to keep (C77, piece 7).
 *
 * `sent_account_configurations` is a column of its own rather than a new meaning for
 * `sent_configurations`, because a row written before this existed has to keep reading exactly as
 * it did. That leaves three states rather than two, and the middle one is the whole point:
 *
 * - **absent** — a migrated row. *Unknown.* Never a difference.
 * - **`{ items: [] }`** — a post that deliberately tailored no account. Known, and comparable.
 * - **`{ items: [...] }`** — what each account was handed.
 */

const publication = (
  sentAccountConfigurations?: SignalPublication['sentAccountConfigurations'],
): Parameters<typeof publicationDriftFields>[0] => ({
  sentCaption: 'The post’s own words',
  sentMedia: [],
  scheduledInstant: '2027-08-25T14:00:00.000Z',
  targets: [
    { channel: 'fb', providerAccountId: 85300, accountId: 85300, handle: 'gholmesdesigns' },
    { channel: 'fb', providerAccountId: 85301, accountId: 85301, handle: 'wildeyephoto' },
  ] as unknown as SignalPublication['targets'],
  ...(sentAccountConfigurations ? { sentAccountConfigurations } : {}),
});

const plan = (
  accountConfigurations?: { accountId: number; caption?: string; mediaIds?: string[] }[],
) => ({
  caption: 'The post’s own words',
  scheduledInstant: '2027-08-25T14:00:00.000Z',
  mediaUrls: [] as string[],
  targets: [
    {
      channel: 'fb',
      platform: 'facebook',
      accountId: 85300,
      handle: 'gholmesdesigns',
      mode: 'AUTOMATIC',
    },
    {
      channel: 'fb',
      platform: 'facebook',
      accountId: 85301,
      handle: 'wildeyephoto',
      mode: 'AUTOMATIC',
    },
  ] as unknown as PublishPreview['targets'],
  ...(accountConfigurations ? { accountConfigurations } : {}),
});

describe('a legacy row stays unknown', () => {
  it('reports no account-content drift when the snapshot is absent', () => {
    // The migrated NULL. Reporting a difference here would send somebody to reconcile against a
    // record that never described accounts in the first place.
    const fields = publicationDriftFields(
      publication(),
      plan([{ accountId: 85300, caption: 'For the studio' }]) as never,
    );
    expect(fields).not.toContain('accountContent');
  });

  it('still reports the drift it always could', () => {
    const fields = publicationDriftFields(publication(), {
      ...plan(),
      caption: 'Rewritten since',
    } as never);
    expect(fields).toContain('caption');
  });
});

describe('a recorded snapshot is compared exactly', () => {
  it('finds no drift when the plan matches what was sent', () => {
    const sent = { version: 1 as const, items: [{ accountId: 85300, caption: 'For the studio' }] };
    expect(
      publicationDriftFields(
        publication(sent),
        plan([{ accountId: 85300, caption: 'For the studio' }]) as never,
      ),
    ).not.toContain('accountContent');
  });

  it('finds drift when one account’s caption was edited', () => {
    const sent = { version: 1 as const, items: [{ accountId: 85300, caption: 'For the studio' }] };
    expect(
      publicationDriftFields(
        publication(sent),
        plan([{ accountId: 85300, caption: 'Rewritten' }]) as never,
      ),
    ).toContain('accountContent');
  });

  it('finds drift when an account gained its own content', () => {
    const sent = { version: 1 as const, items: [] };
    expect(
      publicationDriftFields(
        publication(sent),
        plan([{ accountId: 85301, caption: 'New' }]) as never,
      ),
    ).toContain('accountContent');
  });

  it('finds drift when an account lost its own content', () => {
    const sent = { version: 1 as const, items: [{ accountId: 85300, caption: 'For the studio' }] };
    expect(publicationDriftFields(publication(sent), plan([]) as never)).toContain(
      'accountContent',
    );
  });

  it('knows an empty snapshot from an absent one', () => {
    // `{ items: [] }` says nothing was tailored, which is comparable; absent says nobody recorded,
    // which is not. The same plan therefore drifts against one and not against the other.
    const planned = plan([{ accountId: 85300, caption: 'New' }]) as never;
    expect(publicationDriftFields(publication({ version: 1, items: [] }), planned)).toContain(
      'accountContent',
    );
    expect(publicationDriftFields(publication(), planned)).not.toContain('accountContent');
  });

  it('ignores the order the accounts happen to arrive in', () => {
    const sent = {
      version: 1 as const,
      items: [
        { accountId: 85301, caption: 'For the gallery' },
        { accountId: 85300, caption: 'For the studio' },
      ],
    };
    expect(
      publicationDriftFields(
        publication(sent),
        plan([
          { accountId: 85300, caption: 'For the studio' },
          { accountId: 85301, caption: 'For the gallery' },
        ]) as never,
      ),
    ).not.toContain('accountContent');
  });

  it('notices media ids changing under an unchanged caption', () => {
    const sent = {
      version: 1 as const,
      items: [{ accountId: 85300, caption: 'For the studio', mediaIds: ['a'] }],
    };
    expect(
      publicationDriftFields(
        publication(sent),
        plan([{ accountId: 85300, caption: 'For the studio', mediaIds: ['b'] }]) as never,
      ),
    ).toContain('accountContent');
  });
});
