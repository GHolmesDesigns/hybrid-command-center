/* v8 ignore file -- production remains evidence-gated; automated tests inject the mock provider. */
import { BUFFER_API_URL } from '../../../shared/buffer.ts';
import { redactSecrets } from '../../integration-log.ts';
import { BufferProviderError } from './error.ts';
import { bufferGraphqlRequest, fetchBufferTransport, type BufferTransport } from './transport.ts';
import { parseBufferPostMutation, parseBufferWritePost } from './wire.ts';
import {
  BufferWriteError,
  type BufferCreatePostInput,
  type BufferEditPostInput,
  type BufferWritePost,
  type BufferWriteProvider,
} from './write-provider.ts';

const POST_FIELDS =
  'id channelId text status dueAt allowedActions error { message rawError supportUrl }';
const MUTATION_FIELDS = `__typename ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message }`;

export class BufferWriteClient implements BufferWriteProvider {
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
    ambiguousOnTransport = false,
  ): Promise<Record<string, unknown>> {
    try {
      return await bufferGraphqlRequest(this.transport, {
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        query,
        variables,
        ambiguousOnTransport,
      });
    } catch (error) {
      if (error instanceof BufferWriteError) throw error;
      if (error instanceof BufferProviderError) {
        throw new BufferWriteError(
          redactSecrets(error.message),
          error.ambiguous ? 'AMBIGUOUS' : error.rateLimited ? 'RATE_LIMIT' : 'DEFINITE_REFUSAL',
          {
            ...(error.retryAfterSeconds !== undefined
              ? { retryAfterSeconds: error.retryAfterSeconds }
              : {}),
          },
        );
      }
      throw error;
    }
  }
  async create(input: BufferCreatePostInput): Promise<BufferWritePost> {
    const data = await this.request(
      `mutation BufferCreate($input: CreatePostInput!) { createPost(input: $input) { ${MUTATION_FIELDS} } }`,
      { input },
      true,
    );
    return parseBufferPostMutation(data.createPost);
  }
  async read(id: string): Promise<BufferWritePost> {
    const data = await this.request(
      `query BufferPost($input: PostInput!) { post(input: $input) { ${POST_FIELDS} } }`,
      { input: { id } },
    );
    return parseBufferWritePost(data.post);
  }
  async edit(input: BufferEditPostInput): Promise<BufferWritePost> {
    const data = await this.request(
      `mutation BufferEdit($input: EditPostInput!) { editPost(input: $input) { ${MUTATION_FIELDS} } }`,
      { input },
      true,
    );
    return parseBufferPostMutation(data.editPost);
  }
  async cancel(id: string): Promise<void> {
    const data = await this.request(
      `mutation BufferDelete($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on DeletePostSuccess { id } ... on MutationError { message } } }`,
      { input: { id } },
      true,
    );
    const result = data.deletePost as Record<string, unknown> | undefined;
    if (result?.__typename !== 'DeletePostSuccess' || result.id !== id)
      throw new BufferWriteError(
        typeof result?.message === 'string' ? result.message : 'Buffer refused the delete.',
        'DEFINITE_REFUSAL',
      );
  }
}
