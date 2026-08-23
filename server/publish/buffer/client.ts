/* v8 ignore file -- the live adapter is exercised only by the account owner's manual QA. */
import { BUFFER_API_URL } from '../../../shared/buffer.ts';
import { bufferGraphqlRequest, fetchBufferTransport, type BufferTransport } from './transport.ts';
import { parseBufferAccount, parseBufferChannel, parseBufferPostsPage } from './wire.ts';
import type { BufferChannel, BufferPostsPage, BufferReadProvider } from './read-provider.ts';

const CHANNEL_FIELDS = 'id name service isDisconnected isLocked isQueuePaused';
const POST_FIELDS = 'id text status dueAt channelId';

export class BufferReadClient implements BufferReadProvider {
  readonly available = true;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: BufferTransport;
  constructor(
    apiKey: string,
    baseUrl = BUFFER_API_URL,
    transport: BufferTransport = fetchBufferTransport(),
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.transport = transport;
  }
  private async request(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return bufferGraphqlRequest(this.transport, {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      query,
      variables,
    });
  }
  async account(): Promise<{ id: string; organizations: { id: string; name: string }[] }> {
    const data = await this.request(
      'query BufferAccount { account { id organizations { id name } } }',
      {},
    );
    return parseBufferAccount(data.account);
  }
  async channels(organizationId: string): Promise<BufferChannel[]> {
    const data = await this.request(
      `query BufferChannels($input: ChannelsInput!) { channels(input: $input) { ${CHANNEL_FIELDS} } }`,
      { input: { organizationId } },
    );
    if (!Array.isArray(data.channels)) throw new Error('Buffer channels is not a list.');
    return data.channels.map((channel) => parseBufferChannel(channel));
  }
  async listPosts(organizationId: string, after: string | null): Promise<BufferPostsPage> {
    const data = await this.request(
      `query BufferPosts($first: Int!, $after: String, $input: PostsInput!) { posts(first: $first, after: $after, input: $input) { edges { node { ${POST_FIELDS} } } pageInfo { hasNextPage endCursor } } }`,
      { first: 50, after, input: { organizationId } },
    );
    return parseBufferPostsPage(data.posts);
  }
}
