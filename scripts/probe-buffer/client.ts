import { RequestBudget } from '../probe-post-bridge/budget.ts';
import { providerMessage, recordedHeaders, redactSecrets } from '../probe-post-bridge/redact.ts';

export interface BufferTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type BufferTransport = (request: {
  url: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<BufferTransportResponse>;

export class BufferProbeError extends Error {
  readonly kind: 'http' | 'graphql' | 'typed' | 'shape';
  readonly headers: Record<string, string>;
  constructor(
    kind: BufferProbeError['kind'],
    message: string,
    headers: Record<string, string> = {},
  ) {
    super(redactSecrets(message));
    this.name = 'BufferProbeError';
    this.kind = kind;
    this.headers = headers;
  }
}

export interface BufferPost {
  id: string;
  text: string;
  status: string;
  dueAt: string | null;
  channelId: string;
}

export interface BufferPage {
  posts: BufferPost[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface BufferProbeAsset {
  kind: 'image' | 'video';
  url: string;
}

const POST_FIELDS = 'id text status dueAt channelId';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BufferProbeError('shape', `${label} is not an object.`);
  return value as Record<string, unknown>;
}

function post(value: unknown): BufferPost {
  const row = object(value, 'Buffer post');
  if (
    typeof row.id !== 'string' ||
    typeof row.text !== 'string' ||
    typeof row.status !== 'string' ||
    (row.dueAt !== null && typeof row.dueAt !== 'string') ||
    typeof row.channelId !== 'string'
  )
    throw new BufferProbeError('shape', 'Buffer post carries an unreadable identity or state.');
  return row as unknown as BufferPost;
}

export class BufferProbeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: BufferTransport;
  readonly budget: RequestBudget;

  constructor(input: {
    apiKey: string;
    baseUrl: string;
    transport: BufferTransport;
    budget?: RequestBudget;
  }) {
    this.apiKey = input.apiKey;
    this.baseUrl = input.baseUrl;
    this.transport = input.transport;
    this.budget = input.budget ?? new RequestBudget();
  }

  private async request(
    label: string,
    query: string,
    variables: Record<string, unknown>,
    options: { teardown?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    this.budget.spend(label, options);
    const response = await this.transport({
      url: this.baseUrl,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    const headers = recordedHeaders(response.headers);
    if (response.status < 200 || response.status >= 300)
      throw new BufferProbeError(
        'http',
        `Buffer returned HTTP ${response.status}: ${providerMessage(response.body) || 'no safe message'}`,
        headers,
      );
    const envelope = object(response.body, 'Buffer GraphQL response');
    if (Array.isArray(envelope.errors) && envelope.errors.length) {
      const first = object(envelope.errors[0], 'Buffer GraphQL error');
      const extensions = first.extensions
        ? object(first.extensions, 'Buffer error extensions')
        : {};
      throw new BufferProbeError(
        'graphql',
        `Buffer GraphQL error${typeof extensions.code === 'string' ? ` (${extensions.code})` : ''}: ${typeof first.message === 'string' ? first.message : 'no safe message'}`,
        headers,
      );
    }
    return object(envelope.data, 'Buffer GraphQL data');
  }

  private action(value: unknown, label: string): BufferPost {
    const payload = object(value, label);
    if (payload.__typename !== 'PostActionSuccess')
      throw new BufferProbeError(
        'typed',
        `${label} returned ${String(payload.__typename ?? 'an unknown typed result')}: ${typeof payload.message === 'string' ? payload.message : 'no safe message'}`,
      );
    return post(payload.post);
  }

  async account(): Promise<Record<string, unknown>> {
    const data = await this.request(
      'read account and organizations',
      'query BufferProbeAccount { account { id organizations { id name } } }',
      {},
    );
    return object(data.account, 'Buffer account');
  }

  async channels(organizationId: string): Promise<Record<string, unknown>[]> {
    const data = await this.request(
      'read approved organization channels',
      'query BufferProbeChannels($input: ChannelsInput!) { channels(input: $input) { id name service } }',
      { input: { organizationId } },
    );
    if (!Array.isArray(data.channels))
      throw new BufferProbeError('shape', 'Buffer channels is not a list.');
    return data.channels.map((channel) => object(channel, 'Buffer channel'));
  }

  async create(
    channelId: string,
    text: string,
    dueAt: string,
    asset?: BufferProbeAsset,
  ): Promise<BufferPost> {
    const data = await this.request(
      `create disposable post for ${channelId}`,
      `mutation BufferProbeCreate($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`,
      {
        input: {
          channelId,
          text,
          dueAt,
          schedulingType: 'automatic',
          mode: 'customScheduled',
          assets: asset ? [{ [asset.kind]: { url: asset.url } }] : [],
        },
      },
    );
    return this.action(data.createPost, 'createPost');
  }

  async read(id: string, options: { teardown?: boolean } = {}): Promise<BufferPost> {
    const data = await this.request(
      `read post ${id}`,
      `query BufferProbePost($input: PostInput!) { post(input: $input) { ${POST_FIELDS} } }`,
      { input: { id } },
      options,
    );
    return post(data.post);
  }

  async edit(id: string, text: string): Promise<BufferPost> {
    const data = await this.request(
      `edit disposable post ${id}`,
      `mutation BufferProbeEdit($input: EditPostInput!) { editPost(input: $input) { __typename ... on PostActionSuccess { post { ${POST_FIELDS} } } ... on MutationError { message } } }`,
      { input: { id, text } },
    );
    return this.action(data.editPost, 'editPost');
  }

  async delete(id: string): Promise<string> {
    const data = await this.request(
      `delete disposable post ${id}`,
      'mutation BufferProbeDelete($input: DeletePostInput!) { deletePost(input: $input) { __typename ... on DeletePostSuccess { id } ... on MutationError { message } } }',
      { input: { id } },
      { teardown: true },
    );
    const payload = object(data.deletePost, 'deletePost');
    if (payload.__typename !== 'DeletePostSuccess' || typeof payload.id !== 'string')
      throw new BufferProbeError(
        'typed',
        `deletePost returned ${String(payload.__typename ?? 'an unknown typed result')}: ${typeof payload.message === 'string' ? payload.message : 'no safe message'}`,
      );
    return payload.id;
  }

  async list(organizationId: string, after: string | null, teardown = false): Promise<BufferPage> {
    const data = await this.request(
      'read complete paginated post inventory',
      `query BufferProbePosts($first: Int!, $after: String, $input: PostsInput!) { posts(first: $first, after: $after, input: $input) { edges { node { ${POST_FIELDS} } } pageInfo { hasNextPage endCursor } } }`,
      { first: 50, after, input: { organizationId } },
      { teardown },
    );
    const result = object(data.posts, 'Buffer posts result');
    const pageInfo = object(result.pageInfo, 'Buffer pageInfo');
    if (!Array.isArray(result.edges) || typeof pageInfo.hasNextPage !== 'boolean')
      throw new BufferProbeError('shape', 'Buffer posts page is unreadable.');
    const endCursor = pageInfo.endCursor;
    if (endCursor !== null && typeof endCursor !== 'string')
      throw new BufferProbeError('shape', 'Buffer endCursor is neither a string nor null.');
    return {
      posts: result.edges.map((edge) => post(object(edge, 'Buffer post edge').node)),
      hasNextPage: pageInfo.hasNextPage,
      endCursor,
    };
  }
}

export function fetchBufferTransport(): BufferTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(20_000),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => (headers[name] = value));
    return { status: response.status, headers, body };
  };
}
