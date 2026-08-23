import type { BufferProbeChannel, BufferProbeConfig } from './config.ts';
import type { BufferPage, BufferPost, BufferProbeAsset, BufferProbeClient } from './client.ts';

export type BufferClaimState = 'verified' | 'negative' | 'still unverified';

export interface BufferProbeClaim {
  claim: string;
  state: BufferClaimState;
  evidence: string;
}

export interface BufferProbeResult {
  claims: BufferProbeClaim[];
  created: string[];
  deleted: string[];
  leftovers: string[];
  stopped?: string;
  requests: { used: number; total: number };
}

export interface BufferProbeApi {
  readonly budget: { used: number; total: number };
  account(): Promise<Record<string, unknown>>;
  channels(organizationId: string): Promise<Record<string, unknown>[]>;
  create(
    channelId: string,
    text: string,
    dueAt: string,
    asset?: BufferProbeAsset,
  ): Promise<BufferPost>;
  read(id: string, options?: { teardown?: boolean }): Promise<BufferPost>;
  edit(id: string, text: string): Promise<BufferPost>;
  delete(id: string): Promise<string>;
  list(organizationId: string, after: string | null, teardown?: boolean): Promise<BufferPage>;
}

function initialClaims(): BufferProbeClaim[] {
  return [
    {
      claim: 'Account, organization, and approved channel identities are readable.',
      state: 'still unverified',
      evidence: 'Not reached in this run.',
    },
    {
      claim: 'Buffer creates one remote post per channel and preserves per-channel identity.',
      state: 'still unverified',
      evidence: 'Not reached in this run.',
    },
    {
      claim: 'Scheduled posts can be read and edited through the documented GraphQL shapes.',
      state: 'still unverified',
      evidence: 'Not reached in this run.',
    },
    {
      claim: 'Delete is proven by absence from a complete cursor-paginated read.',
      state: 'still unverified',
      evidence: 'No post was created in this run.',
    },
    {
      claim: 'GraphQL typed-error and rate-limit semantics match the published contract.',
      state: 'still unverified',
      evidence:
        'The probe records natural errors and RateLimit headers but never provokes a refusal or 429.',
    },
    {
      claim: 'Media uses stable direct public HTTPS URLs; no Buffer upload endpoint exists.',
      state: 'still unverified',
      evidence:
        'Documented by the dated contract read; this text-only live probe does not invent or test a byte path.',
    },
  ];
}

async function inventory(
  client: BufferProbeApi,
  organizationId: string,
  teardown = false,
): Promise<BufferPost[]> {
  const rows: BufferPost[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await client.list(organizationId, cursor, teardown);
    rows.push(...page.posts);
    if (!page.hasNextPage) return rows;
    if (!page.endCursor || seen.has(page.endCursor))
      throw new Error('Buffer pagination repeated or omitted the next cursor.');
    seen.add(page.endCursor);
    cursor = page.endCursor;
  }
  throw new Error('Buffer pagination exceeded the 20-page safety bound.');
}

function approvedChannel(
  available: readonly Record<string, unknown>[],
  expected: BufferProbeChannel,
): boolean {
  return available.some(
    (channel) => channel.id === expected.id && channel.service === expected.service,
  );
}

export async function runBufferProbe(input: {
  client: BufferProbeApi | BufferProbeClient;
  config: BufferProbeConfig;
}): Promise<BufferProbeResult> {
  const { client, config } = input;
  const claims = initialClaims();
  const created: string[] = [];
  const deleted: string[] = [];
  const leftovers: string[] = [];
  let stopped: string | undefined;

  try {
    const account = await client.account();
    if (account.id !== config.accountId)
      throw new Error('The live Buffer account differs from the approved account id.');
    const organizations = Array.isArray(account.organizations) ? account.organizations : [];
    const organizationPresent = organizations.some(
      (organization) =>
        organization &&
        typeof organization === 'object' &&
        (organization as Record<string, unknown>).id === config.organizationId,
    );
    if (!organizationPresent)
      throw new Error('The approved organization is not present on this account.');

    const channels = await client.channels(config.organizationId);
    const routedChannels = channels.filter(
      (channel) => channel.service === 'tiktok' || channel.service === 'youtube',
    );
    if (
      routedChannels.length !== config.channels.length ||
      !config.channels.every((channel) => approvedChannel(routedChannels, channel))
    )
      throw new Error('The live account/channel set differs from the approved ids.');
    claims[0] = {
      claim: 'Account, organization, and approved channel identities are readable.',
      state: 'verified',
      evidence: `${config.channels.length} approved channel id(s) matched service and organization.`,
    };

    const before = await inventory(client, config.organizationId);
    if (before.some((post) => post.text.includes(config.probeLabel)))
      throw new Error('The probe label is already present in the complete post inventory.');

    for (const channel of config.channels) {
      const initialText = `${config.probeLabel} disposable Buffer contract probe`;
      const fixture = config.media.find((item) => item.service === channel.service);
      const asset = fixture ? { kind: fixture.kind, url: fixture.url } : undefined;
      const createdPost = await client.create(channel.id, initialText, config.scheduledAt, asset);
      created.push(createdPost.id);
      if (createdPost.channelId !== channel.id || createdPost.text !== initialText)
        throw new Error(
          `Create readback for ${channel.service} did not preserve identity and text.`,
        );
      const readback = await client.read(createdPost.id);
      if (readback.channelId !== channel.id || readback.text !== initialText)
        throw new Error(`Independent create readback for ${channel.service} disagreed.`);
      const editedText = `${config.probeLabel} edited disposable Buffer contract probe`;
      const edited = await client.edit(createdPost.id, editedText);
      if (edited.id !== createdPost.id || edited.text !== editedText)
        throw new Error(`Edit response for ${channel.service} disagreed.`);
      const editedReadback = await client.read(createdPost.id);
      if (editedReadback.text !== editedText)
        throw new Error(`Independent edit readback for ${channel.service} disagreed.`);
    }

    claims[1] = {
      claim: 'Buffer creates one remote post per channel and preserves per-channel identity.',
      state:
        created.length === config.channels.length && new Set(created).size === created.length
          ? 'verified'
          : 'negative',
      evidence: `${created.length} distinct post id(s) for ${config.channels.length} approved channel(s).`,
    };
    claims[2] = {
      claim: 'Scheduled posts can be read and edited through the documented GraphQL shapes.',
      state: 'verified',
      evidence: 'Every created post and edited caption matched an independent by-id read.',
    };
  } catch (error) {
    stopped = error instanceof Error ? error.message : 'The probe stopped on an unknown failure.';
  } finally {
    for (const id of [...created].reverse()) {
      try {
        const deletedId = await client.delete(id);
        if (deletedId !== id) leftovers.push(`${id}: delete returned a different post id`);
        else deleted.push(id);
      } catch (error) {
        leftovers.push(`${id}: ${error instanceof Error ? error.message : 'delete was ambiguous'}`);
      }
    }
    if (created.length) {
      try {
        const after = await inventory(client, config.organizationId, true);
        const stillPresent = created.filter((id) => after.some((post) => post.id === id));
        leftovers.push(
          ...stillPresent.map((id) => `${id}: present in complete paginated read after delete`),
        );
        claims[3] = {
          claim: 'Delete is proven by absence from a complete cursor-paginated read.',
          state: stillPresent.length || deleted.length !== created.length ? 'negative' : 'verified',
          evidence: stillPresent.length
            ? `${stillPresent.length} created post(s) remained.`
            : `${deleted.length} delete response(s); no created id remained in the complete inventory.`,
        };
      } catch (error) {
        leftovers.push(`absence check: ${error instanceof Error ? error.message : 'ambiguous'}`);
        claims[3] = {
          claim: 'Delete is proven by absence from a complete cursor-paginated read.',
          state: 'still unverified',
          evidence: 'The complete absence check did not finish.',
        };
      }
    }
  }

  return {
    claims,
    created,
    deleted,
    leftovers,
    ...(stopped ? { stopped } : {}),
    requests: { used: client.budget.used, total: client.budget.total },
  };
}
