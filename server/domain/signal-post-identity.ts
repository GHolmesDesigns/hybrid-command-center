/**
 * Signal import identity planning.
 *
 * Database- and workbook-free on purpose: C90 can parse either XLSX or pasted tabs, take one
 * workspace snapshot, and run this same rule for preview and confirmation. Nothing here writes.
 */
import {
  SIGNAL_POST_IMPORT_IDENTITY_COLUMNS,
  signalImportSourceNamespace,
  type SignalPostImportIdentity,
} from '../../shared/signal-import.ts';

const SOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SignalPostIdentityInput {
  /** Spreadsheet row number, used only to make errors actionable. */
  row: number;
  /** Workbook-local key, which C90 resolves to the created or matched post. */
  postKey: string;
  text: string;
  date: string | null;
  postImportSource: string | null;
  postImportId: string | null;
}

export interface WorkspaceSignalPostIdentity {
  id: string;
  text: string;
  date: string | null;
}

export interface WorkspaceSignalPostAlias extends SignalPostImportIdentity {
  postId: string;
}

export interface SignalPostIdentityWorkspace {
  posts: WorkspaceSignalPostIdentity[];
  aliases: WorkspaceSignalPostAlias[];
}

export type SignalPostIdentityMatch =
  | { kind: 'create' }
  | { kind: 'identity'; postId: string }
  | { kind: 'fallback'; postId: string }
  | { kind: 'fallback-attach'; postId: string };

export interface PlannedSignalPostAlias extends SignalPostImportIdentity {
  postKey: string;
  /** Present for a fallback match; a created post gets its id during C90's commit. */
  postId?: string;
}

export interface SignalPostIdentityIssue {
  row: number;
  postKey: string;
  message: string;
}

export interface SignalPostIdentityPlan {
  matches: Map<string, SignalPostIdentityMatch>;
  aliases: PlannedSignalPostAlias[];
  issues: SignalPostIdentityIssue[];
}

const fallbackKey = (date: string | null, text: string) =>
  `${date === null ? '\u0000' : date}\u0000${text.trim().toLowerCase()}`;

const postLabel = (post: WorkspaceSignalPostIdentity) =>
  `“${post.text.trim()}” (${post.date ?? 'unscheduled'}, ${post.id})`;

function identityOf(
  input: SignalPostIdentityInput,
  issues: SignalPostIdentityIssue[],
): SignalPostImportIdentity | undefined {
  const source = input.postImportSource?.trim() ?? '';
  const externalId = input.postImportId?.trim() ?? '';
  const [sourceColumn, idColumn] = SIGNAL_POST_IMPORT_IDENTITY_COLUMNS;
  if (Boolean(source) !== Boolean(externalId)) {
    issues.push({
      row: input.row,
      postKey: input.postKey,
      message: source
        ? `${idColumn} is required alongside ${sourceColumn}. Give this post the id it has at that source, or clear both columns.`
        : `${sourceColumn} is required alongside ${idColumn}. Name the source this id belongs to, or clear both columns.`,
    });
    return undefined;
  }
  if (!source) return undefined;
  const normalizedSource = source.toLowerCase();
  if (!SOURCE_ID_PATTERN.test(normalizedSource)) {
    issues.push({
      row: input.row,
      postKey: input.postKey,
      message: `${sourceColumn} must be a UUID, for example 7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7.`,
    });
    return undefined;
  }
  if (externalId.length > 200) {
    issues.push({
      row: input.row,
      postKey: input.postKey,
      message: `${idColumn} must be between 1 and 200 characters.`,
    });
    return undefined;
  }
  return { namespace: signalImportSourceNamespace(normalizedSource), externalId };
}

/**
 * Resolves every post row without writing.
 *
 * A recorded identity wins, but the fallback is still inspected to catch a disagreement. When an
 * identity is new, a fallback match plans the alias attachment that C90 will insert in its own
 * transaction. No identity is silently moved and no ambiguous weak match is guessed.
 */
export function planSignalPostIdentities(
  inputs: SignalPostIdentityInput[],
  workspace: SignalPostIdentityWorkspace,
): SignalPostIdentityPlan {
  const matches = new Map<string, SignalPostIdentityMatch>();
  const aliases: PlannedSignalPostAlias[] = [];
  const issues: SignalPostIdentityIssue[] = [];
  const identityClaims = new Map<string, number>();
  const fallbackClaims = new Map<string, number>();

  for (const input of inputs) {
    const issueCount = issues.length;
    const identity = identityOf(input, issues);
    if (issues.length !== issueCount) continue;

    if (identity) {
      const claim = `${identity.namespace}\u0000${identity.externalId}`;
      const earlierIdentity = identityClaims.get(claim);
      if (earlierIdentity !== undefined) {
        issues.push({
          row: input.row,
          postKey: input.postKey,
          message: `Row ${earlierIdentity} already claims the identity ${identity.externalId} at this source. One identity names one post.`,
        });
        continue;
      }
      identityClaims.set(claim, input.row);
    }

    const fallback = fallbackKey(input.date, input.text);
    const earlierFallback = fallbackClaims.get(fallback);
    if (earlierFallback !== undefined) {
      issues.push({
        row: input.row,
        postKey: input.postKey,
        message: `Row ${earlierFallback} already claims the same fallback (date plus trimmed copy, ignoring case). Two workbook rows cannot resolve to one post.`,
      });
      continue;
    }
    fallbackClaims.set(fallback, input.row);

    const byIdentity = identity
      ? workspace.aliases.find(
          (alias) =>
            alias.namespace === identity.namespace && alias.externalId === identity.externalId,
        )?.postId
      : undefined;
    const fallbackPosts = workspace.posts.filter(
      (post) => fallbackKey(post.date, post.text) === fallback,
    );
    if (fallbackPosts.length > 1) {
      issues.push({
        row: input.row,
        postKey: input.postKey,
        message: `The fallback matches more than one post: ${fallbackPosts.map(postLabel).join('; ')}. Nothing was imported. Add or correct the source identity.`,
      });
      continue;
    }
    const byFallback = fallbackPosts[0];
    if (byIdentity && byFallback && byIdentity !== byFallback.id) {
      const identityPost = workspace.posts.find((post) => post.id === byIdentity);
      issues.push({
        row: input.row,
        postKey: input.postKey,
        message: `The source identity belongs to ${identityPost ? postLabel(identityPost) : byIdentity}, but the fallback matches ${postLabel(byFallback)}. Nothing was imported; correct the row rather than moving the identity.`,
      });
      continue;
    }
    if (byIdentity) {
      matches.set(input.postKey, { kind: 'identity', postId: byIdentity });
      continue;
    }
    if (byFallback) {
      matches.set(input.postKey, {
        kind: identity ? 'fallback-attach' : 'fallback',
        postId: byFallback.id,
      });
      if (identity) aliases.push({ ...identity, postKey: input.postKey, postId: byFallback.id });
      continue;
    }
    matches.set(input.postKey, { kind: 'create' });
    if (identity) aliases.push({ ...identity, postKey: input.postKey });
  }

  return { matches, aliases, issues };
}
