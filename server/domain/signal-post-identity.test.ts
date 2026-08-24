import { describe, expect, it } from 'vitest';
import {
  planSignalPostIdentities,
  type SignalPostIdentityInput,
  type SignalPostIdentityWorkspace,
} from './signal-post-identity.ts';

const SOURCE = '7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7';
const NAMESPACE = `signal-import:${SOURCE}`;

const row = (overrides: Partial<SignalPostIdentityInput> = {}): SignalPostIdentityInput => ({
  row: 2,
  postKey: 'POST-A',
  text: 'Explain the problem clearly.',
  date: '2026-09-14',
  postImportSource: SOURCE,
  postImportId: 'post-A',
  ...overrides,
});

const workspace = (
  overrides: Partial<SignalPostIdentityWorkspace> = {},
): SignalPostIdentityWorkspace => ({ posts: [], aliases: [], ...overrides });

describe('Signal post import identity planning', () => {
  it('resolves a recorded identity after both the copy and schedule change', () => {
    const first = planSignalPostIdentities([row()], workspace());
    expect(first.matches.get('POST-A')).toEqual({ kind: 'create' });
    expect(first.aliases).toEqual([
      { namespace: NAMESPACE, externalId: 'post-A', postKey: 'POST-A' },
    ]);

    // C90 will create the post and record that planned alias in one transaction. On the next
    // import neither part of the weak fallback still matches, but the exact identity does.
    const second = planSignalPostIdentities(
      [row({ text: 'The corrected explanation.', date: '2026-09-21' })],
      workspace({
        posts: [
          {
            id: 'signal-1',
            text: 'Explain the problem clearly.',
            date: '2026-09-14',
          },
        ],
        aliases: [{ namespace: NAMESPACE, externalId: 'post-A', postId: 'signal-1' }],
      }),
    );

    expect(second.issues).toEqual([]);
    expect(second.matches.get('POST-A')).toEqual({ kind: 'identity', postId: 'signal-1' });
    expect(second.aliases).toEqual([]);
  });

  it('uses the weak fallback without an identity and preserves unscheduled as its own value', () => {
    const result = planSignalPostIdentities(
      [
        row({
          text: '  EXPLAIN THE PROBLEM CLEARLY.  ',
          date: null,
          postImportSource: null,
          postImportId: null,
        }),
      ],
      workspace({
        posts: [
          { id: 'dated', text: 'Explain the problem clearly.', date: '2026-09-14' },
          { id: 'queue', text: 'Explain the problem clearly.', date: null },
        ],
      }),
    );

    expect(result.issues).toEqual([]);
    expect(result.matches.get('POST-A')).toEqual({ kind: 'fallback', postId: 'queue' });
    expect(result.aliases).toEqual([]);
  });

  it('plans a new identity against the post found by fallback', () => {
    const result = planSignalPostIdentities(
      [row()],
      workspace({
        posts: [{ id: 'signal-1', text: ' explain the problem clearly. ', date: '2026-09-14' }],
      }),
    );

    expect(result.matches.get('POST-A')).toEqual({
      kind: 'fallback-attach',
      postId: 'signal-1',
    });
    expect(result.aliases).toEqual([
      { namespace: NAMESPACE, externalId: 'post-A', postKey: 'POST-A', postId: 'signal-1' },
    ]);
  });

  it('refuses identity and fallback resolving to different posts and names both', () => {
    const result = planSignalPostIdentities(
      [row()],
      workspace({
        posts: [
          { id: 'by-id', text: 'Old copy', date: '2026-09-01' },
          { id: 'by-copy', text: 'Explain the problem clearly.', date: '2026-09-14' },
        ],
        aliases: [{ namespace: NAMESPACE, externalId: 'post-A', postId: 'by-id' }],
      }),
    );

    expect(result.matches.size).toBe(0);
    expect(result.aliases).toEqual([]);
    expect(result.issues[0]?.message).toContain('by-id');
    expect(result.issues[0]?.message).toContain('by-copy');
    expect(result.issues[0]?.message).toContain('Nothing was imported');
  });

  it('refuses an ambiguous fallback instead of selecting a post by row order', () => {
    const result = planSignalPostIdentities(
      [row({ postImportSource: null, postImportId: null })],
      workspace({
        posts: [
          { id: 'one', text: 'Explain the problem clearly.', date: '2026-09-14' },
          { id: 'two', text: 'EXPLAIN THE PROBLEM CLEARLY.', date: '2026-09-14' },
        ],
      }),
    );

    expect(result.matches.size).toBe(0);
    expect(result.issues[0]?.message).toMatch(/more than one post.*one.*two/i);
  });

  it('requires the optional identity columns as a pair and validates the source UUID', () => {
    const sourceOnly = planSignalPostIdentities([row({ postImportId: null })], workspace());
    const idOnly = planSignalPostIdentities([row({ postImportSource: null })], workspace());
    const namedSource = planSignalPostIdentities(
      [row({ postImportSource: 'Dana sheet' })],
      workspace(),
    );

    expect(sourceOnly.issues[0]?.message).toMatch(/post_import_id is required/);
    expect(idOnly.issues[0]?.message).toMatch(/post_import_source is required/);
    expect(namedSource.issues[0]?.message).toMatch(/must be a UUID/);
  });

  it('normalises the UUID but keeps opaque external ids case-sensitive', () => {
    const upperSource = SOURCE.toUpperCase();
    const result = planSignalPostIdentities(
      [
        row({ postImportSource: upperSource, postImportId: 'Post-A' }),
        row({
          row: 3,
          postKey: 'POST-B',
          text: 'Different copy',
          date: '2026-09-15',
          postImportSource: SOURCE,
          postImportId: 'post-a',
        }),
      ],
      workspace(),
    );

    expect(result.issues).toEqual([]);
    expect(result.aliases.map(({ namespace, externalId }) => ({ namespace, externalId }))).toEqual([
      { namespace: NAMESPACE, externalId: 'Post-A' },
      { namespace: NAMESPACE, externalId: 'post-a' },
    ]);
  });

  it('keeps a 200-character external id whole and refuses rather than truncating a longer one', () => {
    const exact = 'X'.repeat(200);
    const accepted = planSignalPostIdentities([row({ postImportId: exact })], workspace());
    const refused = planSignalPostIdentities([row({ postImportId: `${exact}Y` })], workspace());

    expect(accepted.issues).toEqual([]);
    expect(accepted.aliases[0]?.externalId).toBe(exact);
    expect(refused.aliases).toEqual([]);
    expect(refused.issues[0]?.message).toMatch(/between 1 and 200 characters/);
  });

  it('refuses duplicate identity and fallback claims inside one workbook', () => {
    const duplicateIdentity = planSignalPostIdentities(
      [row(), row({ row: 3, postKey: 'POST-B', text: 'Different', date: null })],
      workspace(),
    );
    const duplicateFallback = planSignalPostIdentities(
      [
        row({ postImportSource: null, postImportId: null }),
        row({
          row: 3,
          postKey: 'POST-B',
          text: ' EXPLAIN THE PROBLEM CLEARLY. ',
          postImportSource: null,
          postImportId: null,
        }),
      ],
      workspace(),
    );

    expect(duplicateIdentity.issues[0]?.message).toMatch(/Row 2 already claims the identity/);
    expect(duplicateFallback.issues[0]?.message).toMatch(/Row 2 already claims the same fallback/);
  });
});
