/**
 * What this app may read from Buffer, and nothing else.
 *
 * No submit, edit, reschedule, delete, upload, or analytics methods exist on this interface by
 * construction — the account refresh path and any future inventory walk are handed something that
 * cannot widen into a write.
 */

export interface BufferOrganization {
  id: string;
  name: string;
}

export interface BufferChannel {
  id: string;
  name: string;
  service: string;
  isDisconnected: boolean;
  isLocked: boolean;
  isQueuePaused: boolean;
}

export interface BufferPost {
  id: string;
  text: string;
  status: string;
  dueAt: string | null;
  channelId: string;
}

export interface BufferPostsPage {
  posts: BufferPost[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface BufferReadProvider {
  readonly available: boolean;
  account(): Promise<{ id: string; organizations: BufferOrganization[] }>;
  channels(organizationId: string): Promise<BufferChannel[]>;
  listPosts(organizationId: string, after: string | null): Promise<BufferPostsPage>;
}

export class UnavailableBufferReadProvider implements BufferReadProvider {
  readonly available = false;
  private readonly reason: string;
  constructor(reason = 'Buffer needs BUFFER_API_KEY.') {
    this.reason = reason;
  }
  private fail(): never {
    throw new Error(this.reason);
  }
  async account(): Promise<{ id: string; organizations: BufferOrganization[] }> {
    return this.fail();
  }
  async channels(_organizationId: string): Promise<BufferChannel[]> {
    void _organizationId;
    return this.fail();
  }
  async listPosts(_organizationId: string, _after: string | null): Promise<BufferPostsPage> {
    void _organizationId;
    void _after;
    return this.fail();
  }
}
