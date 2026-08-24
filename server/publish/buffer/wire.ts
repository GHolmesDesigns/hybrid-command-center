import { bufferPlatformForService, bufferUnavailableReason } from '../../../shared/buffer.ts';
import { BufferProviderError } from './error.ts';
import type { BufferChannel, BufferOrganization, BufferPost } from './read-provider.ts';
import type { BufferRemoteAction, BufferWritePost } from './write-provider.ts';
import { BUFFER_REMOTE_ACTIONS, BufferWriteError } from './write-provider.ts';
import type { ProviderPostState } from '../../../shared/publish.ts';

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BufferProviderError(`${label} is not an object.`);
  return value as Record<string, unknown>;
};

const stringField = (row: Record<string, unknown>, key: string, label: string): string => {
  if (typeof row[key] !== 'string' || !row[key])
    throw new BufferProviderError(`${label} is missing ${key}.`);
  return row[key] as string;
};

const booleanField = (row: Record<string, unknown>, key: string, label: string): boolean => {
  if (typeof row[key] !== 'boolean') throw new BufferProviderError(`${label} is missing ${key}.`);
  return row[key] as boolean;
};

export const parseBufferAccount = (
  value: unknown,
): { id: string; organizations: BufferOrganization[] } => {
  const account = object(value, 'Buffer account');
  const id = stringField(account, 'id', 'Buffer account');
  if (!Array.isArray(account.organizations))
    throw new BufferProviderError('Buffer account organizations is not a list.');
  const organizations = account.organizations.map((organization) => {
    const row = object(organization, 'Buffer organization');
    return {
      id: stringField(row, 'id', 'Buffer organization'),
      name: stringField(row, 'name', 'Buffer organization'),
    };
  });
  return { id, organizations };
};

export const parseBufferChannel = (value: unknown): BufferChannel => {
  const row = object(value, 'Buffer channel');
  return {
    id: stringField(row, 'id', 'Buffer channel'),
    name: stringField(row, 'name', 'Buffer channel'),
    service: stringField(row, 'service', 'Buffer channel'),
    isDisconnected: booleanField(row, 'isDisconnected', 'Buffer channel'),
    isLocked: booleanField(row, 'isLocked', 'Buffer channel'),
    isQueuePaused: booleanField(row, 'isQueuePaused', 'Buffer channel'),
  };
};

export const parseBufferPost = (value: unknown): BufferPost => {
  const row = object(value, 'Buffer post');
  const dueAt = row.dueAt;
  if (dueAt !== null && typeof dueAt !== 'string')
    throw new BufferProviderError('Buffer post dueAt is neither a string nor null.');
  return {
    id: stringField(row, 'id', 'Buffer post'),
    text: stringField(row, 'text', 'Buffer post'),
    status: stringField(row, 'status', 'Buffer post'),
    dueAt,
    channelId: stringField(row, 'channelId', 'Buffer post'),
  };
};

const bufferPostState = (status: string): ProviderPostState => {
  switch (status) {
    case 'buffer':
    case 'approved':
      return 'SCHEDULED';
    case 'draft':
    case 'approval_pending':
      return 'DRAFT';
    case 'sent':
      return 'PUBLISHED';
    case 'failed':
      return 'FAILED';
    default:
      return 'PROCESSING';
  }
};

/** Parses only safe post evidence. `error.rawError` is intentionally never read or returned. */
export const parseBufferWritePost = (value: unknown): BufferWritePost => {
  const row = object(value, 'Buffer write post');
  const dueAt = row.dueAt;
  if (dueAt !== null && typeof dueAt !== 'string')
    throw new BufferProviderError('Buffer write post dueAt is neither a string nor null.');
  const allowed = Array.isArray(row.allowedActions)
    ? row.allowedActions.filter(
        (action): action is BufferRemoteAction =>
          typeof action === 'string' &&
          (BUFFER_REMOTE_ACTIONS as readonly string[]).includes(action),
      )
    : [];
  const error =
    row.error && typeof row.error === 'object' && !Array.isArray(row.error)
      ? (row.error as Record<string, unknown>)
      : undefined;
  return {
    id: stringField(row, 'id', 'Buffer write post'),
    channelId: stringField(row, 'channelId', 'Buffer write post'),
    text: typeof row.text === 'string' ? row.text : '',
    dueAt,
    state: bufferPostState(stringField(row, 'status', 'Buffer write post')),
    allowedActions: allowed,
    ...(typeof error?.message === 'string' ? { error: error.message } : {}),
    ...(typeof error?.supportUrl === 'string' ? { supportUrl: error.supportUrl } : {}),
  };
};

/** Success-or-typed-error mutation union. Unknown members refuse rather than becoming success. */
export const parseBufferPostMutation = (value: unknown): BufferWritePost => {
  const result = object(value, 'Buffer mutation result');
  const type = stringField(result, '__typename', 'Buffer mutation result');
  if (type === 'PostActionSuccess') return parseBufferWritePost(result.post);
  const message =
    typeof result.message === 'string' ? result.message : 'Buffer refused the mutation.';
  if (type === 'InvalidInputError') throw new BufferWriteError(message, 'INVALID_INPUT');
  if (type === 'LimitReachedError') throw new BufferWriteError(message, 'QUOTA_REFUSAL');
  if (type === 'VoidMutationError') throw new BufferWriteError(message, 'DEFINITE_REFUSAL');
  throw new BufferWriteError(`Unknown Buffer mutation result ${type}.`, 'DEFINITE_REFUSAL');
};

export const parseBufferPostsPage = (
  value: unknown,
): { posts: BufferPost[]; hasNextPage: boolean; endCursor: string | null } => {
  const result = object(value, 'Buffer posts result');
  const pageInfo = object(result.pageInfo, 'Buffer pageInfo');
  if (!Array.isArray(result.edges) || typeof pageInfo.hasNextPage !== 'boolean')
    throw new BufferProviderError('Buffer posts page is unreadable.');
  const endCursor = pageInfo.endCursor;
  if (endCursor !== null && typeof endCursor !== 'string')
    throw new BufferProviderError('Buffer endCursor is neither a string nor null.');
  return {
    posts: result.edges.map((edge) => parseBufferPost(object(edge, 'Buffer post edge').node)),
    hasNextPage: pageInfo.hasNextPage,
    endCursor,
  };
};

export interface MappedBufferChannel extends BufferChannel {
  platform: string;
  unavailable?: string;
}

/** Maps a parsed channel to a platform, or refuses when the service is unknown. */
export const mapBufferChannel = (channel: BufferChannel): MappedBufferChannel | undefined => {
  const platform = bufferPlatformForService(channel.service);
  if (!platform) return undefined;
  const unavailable = bufferUnavailableReason(channel);
  return { ...channel, platform, ...(unavailable ? { unavailable } : {}) };
};
