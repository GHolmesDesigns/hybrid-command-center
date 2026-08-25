import type { BufferWireAsset } from '../../../shared/buffer-media.ts';
import type { ProviderPostState } from '../../../shared/publish.ts';

export const BUFFER_REMOTE_ACTIONS = ['editPost', 'deletePost'] as const;
export type BufferRemoteAction = (typeof BUFFER_REMOTE_ACTIONS)[number];

export interface BufferCreatePostInput {
  channelId: string;
  text: string;
  dueAt: string;
  /** Pinned by construction. Signal, never Buffer's queue, owns the instant. */
  mode: 'customScheduled';
  /** Approval/draft lifecycle is explicitly declined for this wave. */
  needsApproval: false;
  source: 'hybrid-command-center';
  assets: BufferWireAsset[];
  metadata?: { tiktok?: { title?: string }; youtube?: { title?: string } };
}

export interface BufferEditPostInput {
  id: string;
  text?: string;
  dueAt?: string;
  assets?: BufferWireAsset[];
  metadata?: BufferCreatePostInput['metadata'];
}

export interface BufferWritePost {
  id: string;
  channelId: string;
  text: string;
  dueAt: string | null;
  state: ProviderPostState;
  allowedActions: BufferRemoteAction[];
  /** Safe provider message only. `rawError` is dropped by the parser. */
  error?: string;
  supportUrl?: string;
}

export type BufferWriteFailureKind =
  'INVALID_INPUT' | 'QUOTA_REFUSAL' | 'RATE_LIMIT' | 'DEFINITE_REFUSAL' | 'AMBIGUOUS';

export class BufferWriteError extends Error {
  readonly kind: BufferWriteFailureKind;
  readonly ambiguous: boolean;
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    kind: BufferWriteFailureKind,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'BufferWriteError';
    this.kind = kind;
    this.ambiguous = kind === 'AMBIGUOUS';
    this.rateLimited = kind === 'RATE_LIMIT';
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** The Buffer write vocabulary. It has no account listing, upload, analytics, or queue method. */
export interface BufferWriteProvider {
  readonly available: boolean;
  /**
   * Why writes are closed, when they are. Preview surfaces this as a plan refusal so Confirm is
   * never offered for a plan that submit would reject for the same reason.
   */
  readonly unavailableReason?: string;
  create(input: BufferCreatePostInput): Promise<BufferWritePost>;
  read(id: string): Promise<BufferWritePost>;
  edit(input: BufferEditPostInput): Promise<BufferWritePost>;
  cancel(id: string): Promise<void>;
}

export class UnavailableBufferWriteProvider implements BufferWriteProvider {
  readonly available = false;
  readonly unavailableReason: string;
  constructor(reason: string) {
    this.unavailableReason = reason;
  }
  private fail(): never {
    throw new BufferWriteError(this.unavailableReason, 'DEFINITE_REFUSAL');
  }
  async create(_input: BufferCreatePostInput): Promise<BufferWritePost> {
    void _input;
    return this.fail();
  }
  async read(_id: string): Promise<BufferWritePost> {
    void _id;
    return this.fail();
  }
  async edit(_input: BufferEditPostInput): Promise<BufferWritePost> {
    void _input;
    return this.fail();
  }
  async cancel(_id: string): Promise<void> {
    void _id;
    return this.fail();
  }
}
