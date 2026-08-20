/**
 * The run: seven questions, one `finally`, and a claim ledger that starts at "unverified" and can
 * only be moved by something that was actually observed.
 *
 * ## Two orders, and why they differ
 *
 * The card asks its questions in one order and the probe executes them in another. Question 1 needs
 * a media id on any platform that refuses a text-only post, and a media id comes from question 2, so
 * the upload runs first; the inventory read question 4 uses as its baseline runs before everything,
 * because it is also how the probe checks that nothing is already using this run's label. The result
 * matrix is rendered in the card's order regardless. Where a step could not run — no account on that
 * platform, no video supplied, an earlier upload refused — it records *why* against the claims it
 * would have answered and leaves them unverified.
 *
 * ## What the `finally` is for
 *
 * Every post this probe creates is deleted there, and then a complete inventory read proves the
 * deletions rather than assuming them. Teardown spends from a reserved slice of the request budget
 * that the questions cannot touch, so a run that spent its whole allowance asking things can still
 * clean up after itself. Nothing in teardown throws: each failure is recorded, because a leftover
 * scheduled post that nobody is told about is the worst outcome this script has.
 */
import { ClaimLedger, type ProbeClaimResult } from './claims.ts';
import {
  ProbeStopError,
  type ProbeCall,
  type ProbeCallResult,
  type ProbeClient,
} from './client.ts';
import type { ProbeConfig } from './config.ts';
import {
  fixtureRecord,
  type ProbeFixture,
  type ProbeFixtureKey,
  type ProbeFixtureRecord,
} from './fixtures.ts';
import { describeShape, providerMessage, redactSecrets } from './redact.ts';
import {
  analyticsRequest,
  createPostRequest,
  createUploadUrlRequest,
  deleteMediaRequest,
  deletePostRequest,
  getMediaRequest,
  getPostRequest,
  listPostsRequest,
  listSocialAccountsRequest,
  updatePostRequest,
  type AccountConfigurationStyle,
  type ProbePostInput,
} from './requests.ts';
import { publishCapabilityFor } from '../../shared/publish-capabilities.ts';
import { ANALYTICS_PLATFORMS } from '../../shared/publish-analytics.ts';

/**
 * How wide and how deep one inventory read goes.
 *
 * A hundred rows a page and three pages is three hundred posts, read in at most three requests —
 * which is what makes room for the same read to happen twice in one run, once as question 4's
 * baseline and once as the proof that teardown worked.
 */
const INVENTORY_PAGE_LIMIT = 3;
const INVENTORY_PAGE_SIZE = 100;

/**
 * Post states this probe is willing to see.
 *
 * Anything else stops the run and cleans up, including a status this script has never heard of. A
 * video post legitimately sits in `processing` for a while, so that one is expected rather than
 * alarming; a post that says it went out is the condition the whole design exists to avoid.
 */
const SAFE_POST_STATES = new Set([
  'scheduled',
  'draft',
  'processing',
  'queued',
  'pending',
  'failed',
]);

export interface ProbeArtifact {
  kind: 'post' | 'media';
  providerId: string;
  note: string;
}

export interface ProbeTeardownResult {
  createdPosts: readonly string[];
  deletedPosts: readonly string[];
  failedPosts: readonly { providerId: string; reason: string }[];
  deletedMedia: readonly string[];
  undeletableMedia: readonly { providerId: string; reason: string }[];
  inventory: 'verified-absent' | 'still-present' | 'not-verified';
  inventoryNote: string;
}

export interface ProbeRunResult {
  claims: readonly ProbeClaimResult[];
  calls: readonly ProbeCall[];
  budget: { used: number; total: number; reserve: number };
  fixtures: readonly ProbeFixtureRecord[];
  teardown: ProbeTeardownResult;
  /** What the provider still holds because nothing could delete it. */
  leftovers: readonly ProbeArtifact[];
  stopped?: string;
}

export interface ProbeDeps {
  client: ProbeClient;
  config: ProbeConfig;
  fixtures: Map<ProbeFixtureKey, ProbeFixture>;
  /** Used only to date the media-expiry follow-up. */
  now: Date;
  ledger?: ClaimLedger;
}

interface UploadedAsset {
  mediaId: string;
  fixture: ProbeFixture;
}

interface ProbeContext extends ProbeDeps {
  ledger: ClaimLedger;
  createdPosts: string[];
  uploaded: Map<ProbeFixtureKey, UploadedAsset>;
  /** Provider media ids the probe reserved without uploading to. Teardown deletes these too. */
  strayMedia: string[];
}

/** `HTTP 400 — <the provider's own sentence>`, or just the status where it said nothing. */
function refusal(result: ProbeCallResult): string {
  const message = providerMessage(result.body);
  return message ? `HTTP ${result.status} — ${message}` : `HTTP ${result.status}`;
}

function accountsOn(config: ProbeConfig, platform: string): number[] {
  return config.accounts
    .filter((account) => account.platform === platform)
    .map((account) => account.accountId);
}

function probeCaption(label: string, note: string): string {
  return `HCC contract probe ${label}: ${note}`;
}

function row(result: ProbeCallResult): Record<string, unknown> {
  return (result.body ?? {}) as Record<string, unknown>;
}

function dataRows(result: ProbeCallResult): Record<string, unknown>[] {
  const data = row(result).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/** The provider id out of a response, whichever of the two names it used — `media_id` or `id`. */
function providerIdOf(body: Record<string, unknown>): string | undefined {
  if (body.media_id !== undefined) return String(body.media_id);
  if (body.id !== undefined) return String(body.id);
  return undefined;
}

/** Whether one platform's configuration came back carrying one field. Key presence, never a value. */
function readBackHasField(result: ProbeCallResult, platform: string, field: string): boolean {
  if (!result.ok) return false;
  const configurations = row(result).platform_configurations;
  if (!configurations || typeof configurations !== 'object') return false;
  const forPlatform = (configurations as Record<string, unknown>)[platform];
  if (!forPlatform || typeof forPlatform !== 'object') return false;
  return field in (forPlatform as Record<string, unknown>);
}

/**
 * A read-back, with the stop condition applied to what it says.
 *
 * The status check is here rather than at the call sites because it has to happen on *every* read of
 * a post the probe created, and a check one path forgets is not a stop condition.
 */
async function readPost(
  context: ProbeContext,
  label: string,
  providerPostId: string,
): Promise<ProbeCallResult> {
  const result = await context.client.api(label, getPostRequest(providerPostId));
  if (!result.ok) return result;
  const status = typeof row(result).status === 'string' ? String(row(result).status) : '(none)';
  if (!SAFE_POST_STATES.has(status))
    throw new ProbeStopError(
      `post ${providerPostId} came back in state "${status}", which is not a state this probe schedules into.`,
    );
  return result;
}

/**
 * Creates a probe post and remembers it for teardown *before* anything else can fail.
 *
 * The id is pushed the moment it is read out of the response, so a stop condition tripping on the
 * very next line still leaves the post on the deletion list. A 2xx with no id is a stop condition of
 * its own: something exists in the provider and nothing here can name it.
 */
async function createPost(
  context: ProbeContext,
  label: string,
  input: ProbePostInput,
): Promise<{ result: ProbeCallResult; providerPostId?: string }> {
  const result = await context.client.api(label, createPostRequest(input));
  if (!result.ok) return { result };
  const providerPostId = providerIdOf(row(result));
  if (!providerPostId)
    throw new ProbeStopError(
      `a post was created but the response carried no id, so nothing can delete it. Response shape: ${describeShape(result.body, 1)}.`,
    );
  context.createdPosts.push(providerPostId);
  return { result, providerPostId };
}

interface InventoryRead {
  ids: string[];
  pages: number;
  complete: boolean;
  metaShape: string;
  rowShape: string;
  note: string;
  containsLabel: boolean;
}

/**
 * How this reads the next page, and what it refuses to guess.
 *
 * `meta.next` could be an offset, a URL, or an opaque cursor whose parameter name is not in the
 * document. An offset it can follow; a URL it can follow by lifting the offset out of the query;
 * anything else stops the walk and is recorded as the shape it saw. Inventing a `?cursor=` parameter
 * would produce a page that might be the second page or might be the first one again, and question 4
 * exists precisely because C78 cannot be built on a maybe.
 */
export function nextInventoryOffset(
  meta: unknown,
): { done: true } | { offset: number } | { unknown: string } {
  if (!meta || typeof meta !== 'object') return { unknown: `meta is ${describeShape(meta, 1)}` };
  const next = (meta as Record<string, unknown>).next;
  if (next === null || next === undefined || next === false) return { done: true };
  if (typeof next === 'number') return { offset: next };
  if (typeof next === 'string') {
    const match = /(?:^|[?&])offset=(\d+)/.exec(next);
    return match
      ? { offset: Number(match[1]) }
      : { unknown: 'meta.next is a string carrying no offset' };
  }
  return { unknown: `meta.next is ${describeShape(next, 1)}` };
}

async function readInventory(
  context: ProbeContext,
  label: string,
  options: { teardown?: boolean } = {},
): Promise<InventoryRead> {
  const ids: string[] = [];
  let offset = 0;
  let pages = 0;
  let complete = false;
  let metaShape = '(no page read)';
  let rowShape = '(no row seen)';
  let note = '';
  let containsLabel = false;
  while (pages < INVENTORY_PAGE_LIMIT) {
    const result = await context.client.api(
      `${label}:page-${pages + 1}`,
      listPostsRequest({ limit: INVENTORY_PAGE_SIZE, offset }),
      options,
    );
    pages += 1;
    if (!result.ok) {
      note = `page ${pages} refused: ${refusal(result)}`;
      break;
    }
    const rows = dataRows(result);
    metaShape = describeShape(row(result).meta, 2);
    if (rows.length && rowShape === '(no row seen)') rowShape = describeShape(rows[0], 1);
    for (const listed of rows) {
      if (listed.id !== undefined) ids.push(String(listed.id));
      // Read, never recorded. A caption is somebody's content; all this needs from it is whether
      // this run's label is already in use, which is a boolean.
      if (typeof listed.caption === 'string' && listed.caption.includes(context.config.probeLabel))
        containsLabel = true;
    }
    const next = nextInventoryOffset(row(result).meta);
    if ('done' in next) {
      complete = true;
      break;
    }
    if ('unknown' in next) {
      note = next.unknown;
      break;
    }
    if (next.offset <= offset) {
      note = `meta.next did not advance past offset ${offset}`;
      break;
    }
    offset = next.offset;
  }
  if (!complete && !note) note = `stopped at the ${INVENTORY_PAGE_LIMIT}-page safety bound`;
  return { ids, pages, complete, metaShape, rowShape, note, containsLabel };
}

/** Preflight: the accounts are real and connected, and the label is not already in use. */
async function preflight(context: ProbeContext): Promise<void> {
  const accounts = await context.client.api('social-accounts', listSocialAccountsRequest(100));
  if (!accounts.ok)
    throw new ProbeStopError(`the connected accounts could not be read (${refusal(accounts)}).`);
  const connected = new Map<string, string>();
  for (const listed of dataRows(accounts))
    if (listed.id !== undefined && typeof listed.platform === 'string')
      connected.set(String(listed.id), listed.platform);
  for (const account of context.config.accounts) {
    const platform = connected.get(String(account.accountId));
    if (platform === undefined)
      throw new ProbeStopError(
        `account ${account.accountId} is not among this key's connected accounts. Nothing is probed on an account that was not read back.`,
      );
    if (platform !== account.platform)
      throw new ProbeStopError(
        `account ${account.accountId} is a ${platform} account and was named as ${account.platform}.`,
      );
  }

  const inventory = await readInventory(context, 'baseline-inventory');
  if (inventory.containsLabel)
    throw new ProbeStopError(
      `the label "${context.config.probeLabel}" already appears in the provider's posts. Use one nothing is using, so the teardown proof is unambiguous.`,
    );
  context.ledger.record(
    'posts-list-pagination',
    inventory.complete ? 'verified' : 'still-unverified',
    inventory.complete
      ? [
          `Walked ${inventory.pages} page(s) of GET /v1/posts at limit ${INVENTORY_PAGE_SIZE} to a null meta.next.`,
          `meta shape: ${inventory.metaShape}.`,
        ]
      : [`Incomplete: ${inventory.note}.`, `meta shape: ${inventory.metaShape}.`],
  );
  context.ledger.record(
    'posts-list-identity-fields',
    inventory.ids.length ? 'verified' : 'still-unverified',
    inventory.ids.length
      ? [`Every listed row carried an id. Row shape: ${inventory.rowShape}.`]
      : ['The inventory was empty, so no row shape was observed.'],
  );
}

/** Reserves an upload URL and sends the bytes. Returns the provider media id, or nothing. */
async function reserveAndUpload(
  context: ProbeContext,
  key: ProbeFixtureKey,
  fixture: ProbeFixture,
): Promise<{ mediaId?: string; created: ProbeCallResult; put?: ProbeCallResult }> {
  const created = await context.client.api(
    `media-create-upload-url:${key}`,
    createUploadUrlRequest({
      name: fixture.name,
      mimeType: fixture.mimeType,
      sizeBytes: fixture.sizeBytes,
    }),
  );
  if (!created.ok) return { created };
  const mediaId = providerIdOf(row(created));
  const uploadUrl =
    typeof row(created).upload_url === 'string' ? String(row(created).upload_url) : undefined;
  if (!mediaId || !uploadUrl) return { created };
  const put = await context.client.upload(`media-upload:${key}`, {
    uploadUrl,
    mimeType: fixture.mimeType,
    bytes: fixture.bytes,
  });
  if (!put.ok) {
    context.strayMedia.push(mediaId);
    return { created, put };
  }
  context.uploaded.set(key, { mediaId, fixture });
  return { mediaId, created, put };
}

/** Question 2's upload contract, its two refusal probes, and the assets later questions need. */
async function questionTwoUpload(context: ProbeContext): Promise<void> {
  const image = context.fixtures.get('image');
  if (!image) {
    context.ledger.explainUnverified('media-upload-contract', 'No image fixture was loaded.');
    return;
  }

  const attempt = await reserveAndUpload(context, 'image', image);
  if (!attempt.mediaId) {
    context.ledger.record('media-upload-contract', 'negative', [
      attempt.put
        ? `create-upload-url answered ${describeShape(attempt.created.body, 1)}, but the signed PUT carrying Content-Type ${image.mimeType} and Content-Length ${image.sizeBytes} answered HTTP ${attempt.put.status}.`
        : attempt.created.ok
          ? `create-upload-url answered 2xx without both an id and an upload_url. Response shape: ${describeShape(attempt.created.body, 2)}.`
          : `POST /v1/media/create-upload-url refused { name, mime_type, size_bytes }: ${refusal(attempt.created)}.`,
    ]);
    context.ledger.explainUnverified(
      'media-attach-and-describe',
      'No asset was uploaded, so nothing could be described.',
    );
    return;
  }
  context.ledger.record('media-upload-contract', 'verified', [
    `POST /v1/media/create-upload-url { name, mime_type, size_bytes } answered ${describeShape(attempt.created.body, 1)}.`,
    `The signed PUT carried Content-Type ${image.mimeType} and Content-Length ${image.sizeBytes} and no Authorization header; it answered HTTP ${attempt.put?.status}.`,
    `Fixture sha256 ${image.sha256}.`,
  ]);

  const described = await context.client.api(
    'media-describe:image',
    getMediaRequest(attempt.mediaId),
  );
  context.ledger.record(
    'media-attach-and-describe',
    described.ok ? 'verified' : 'negative',
    described.ok
      ? [`GET /v1/media/{id} answered ${describeShape(described.body, 2)}.`]
      : [`GET /v1/media/{id} answered ${refusal(described)}.`],
  );

  // Two refusal probes. Neither sends a byte: a size well past any published bound, and a MIME value
  // outside the documented five. A refusal that names the real limit is worth more than a support
  // page, and it costs one request. A reservation that is accepted instead is remembered so teardown
  // deletes it — the probe asked for it, so the probe owns it.
  const oversize = await context.client.api(
    'media-create-upload-url:oversize',
    createUploadUrlRequest({
      name: 'probe-oversize.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 8 * 1024 * 1024 * 1024,
    }),
  );
  if (oversize.ok) {
    const stray = providerIdOf(row(oversize));
    if (stray) context.strayMedia.push(stray);
  }
  context.ledger.record(
    'media-limits',
    oversize.ok ? 'still-unverified' : 'verified',
    oversize.ok
      ? [
          'An 8 GiB size_bytes was accepted without complaint, so create-upload-url enforces no size bound of its own and the real limit is somewhere this probe did not reach.',
        ]
      : [`An 8 GiB size_bytes was refused: ${refusal(oversize)}.`],
  );

  const badMime = await context.client.api(
    'media-create-upload-url:unsupported-mime',
    createUploadUrlRequest({ name: 'probe-image.webp', mimeType: 'image/webp', sizeBytes: 128 }),
  );
  if (badMime.ok) {
    const stray = providerIdOf(row(badMime));
    if (stray) context.strayMedia.push(stray);
  }
  context.ledger.record(
    'media-mime-enum',
    badMime.ok ? 'negative' : 'verified',
    badMime.ok
      ? ['image/webp was accepted, so the accepted set is wider than the documented five values.']
      : [`image/webp was refused: ${refusal(badMime)}.`],
  );

  for (const key of ['document', 'cover', 'video'] as const) {
    const fixture = context.fixtures.get(key);
    if (fixture) await reserveAndUpload(context, key, fixture);
  }
}

/**
 * Question 2's last claim, on a post of its own.
 *
 * `media` against `media_urls` could have been asked by adding a URL to one of the other posts, but
 * then a provider that rejected the request over the URL would have recorded a negative for whatever
 * *that* post was really about. It is a C75 question and it gets its own two requests.
 */
async function questionTwoMediaPrecedence(context: ProbeContext): Promise<void> {
  const image = context.uploaded.get('image');
  const account = context.config.accounts.find((candidate) => {
    const capability = publishCapabilityFor(candidate.platform);
    return capability !== undefined && capability.kinds.POST.media.max !== 0;
  });
  if (!image || !account) {
    context.ledger.explainUnverified(
      'media-ids-override-media-urls',
      image
        ? 'No named account is on a platform that accepts an image in a standard post.'
        : 'No asset was uploaded, so there was no id to send beside a URL.',
    );
    return;
  }
  const created = await createPost(context, 'media-precedence:create', {
    caption: probeCaption(context.config.probeLabel, 'media against media_urls'),
    scheduledAt: context.config.scheduledAt,
    accountIds: [account.accountId],
    mediaIds: [image.mediaId],
    // Deliberately unreachable. `.invalid` can never resolve, so if the provider preferred the URL
    // the post could not process — and that is the answer, recorded rather than published.
    mediaUrls: ['https://probe.invalid/should-be-ignored.png'],
  });
  if (!created.result.ok) {
    context.ledger.record('media-ids-override-media-urls', 'still-unverified', [
      `A create carrying both media and media_urls was refused outright: ${refusal(created.result)}. That is neither key winning, so C75 gains nothing here.`,
    ]);
    return;
  }
  const read = await readPost(context, 'media-precedence:read', created.providerPostId!);
  context.ledger.record(
    'media-ids-override-media-urls',
    read.ok ? 'verified' : 'still-unverified',
    [
      `A create carrying media (one uploaded id) and media_urls (one unreachable URL) answered HTTP ${created.result.status}.`,
      read.ok
        ? `The read-back's media read as ${describeShape(row(read).media, 2)}, and the post is in state ${String(row(read).status)}.`
        : `The read-back was refused: ${refusal(read)}.`,
    ],
  );
}

/** Question 1. */
async function questionOneAccounts(context: ProbeContext): Promise<void> {
  const claims = [
    'account-configurations-accepted',
    'account-configuration-encoding',
    'account-configuration-fields-persist',
    'same-platform-duplicate-policy',
  ] as const;
  const platform = [...new Set(context.config.accounts.map((account) => account.platform))].find(
    (candidate) => accountsOn(context.config, candidate).length >= 2,
  );
  if (!platform) {
    for (const claim of claims)
      context.ledger.explainUnverified(
        claim,
        'No platform had two named accounts, so there was no same-platform pair to ask about.',
      );
    return;
  }
  const [first, second] = accountsOn(context.config, platform);
  const needsMedia = (publishCapabilityFor(platform)?.kinds.POST.media.min ?? 0) >= 1;
  const image = context.uploaded.get('image');
  if (needsMedia && !image) {
    for (const claim of claims)
      context.ledger.explainUnverified(
        claim,
        `${platform} refuses a text-only post and no image asset was uploaded, so the pair could not be created.`,
      );
    return;
  }

  const captions: readonly [string, string] = [
    probeCaption(
      context.config.probeLabel,
      'account one. Whether a per-account caption is stored for this account alone',
    ),
    probeCaption(
      context.config.probeLabel,
      'account two, worded differently on purpose — two accounts on one platform must never be asked to carry the same words',
    ),
  ];
  const patchedCaptions: readonly [string, string] = [
    probeCaption(context.config.probeLabel, 'account one, edited through PATCH'),
    probeCaption(
      context.config.probeLabel,
      'account two, edited through PATCH and still nothing like account one',
    ),
  ];
  const input = (
    style: AccountConfigurationStyle,
    perAccount: readonly [string, string],
  ): ProbePostInput => ({
    caption: probeCaption(context.config.probeLabel, 'base caption, overridden per account below'),
    scheduledAt: context.config.scheduledAt,
    accountIds: [first, second],
    ...(needsMedia && image ? { mediaIds: [image.mediaId] } : {}),
    platformConfigurations: {
      [platform]: { caption: probeCaption(context.config.probeLabel, 'platform-level caption') },
    },
    accountConfigurations: [
      { accountId: first, caption: perAccount[0] },
      { accountId: second, caption: perAccount[1] },
    ],
    accountConfigurationStyle: style,
  });

  let style: AccountConfigurationStyle = 'list';
  let created = await createPost(context, 'account-configurations:create', input(style, captions));
  const firstRefusal = created.result.ok ? '' : refusal(created.result);
  const namesTheField = /account_?configurations|account_?id/i.test(
    providerMessage(created.result.body),
  );
  if (!created.result.ok && namesTheField) {
    style = 'keyed';
    created = await createPost(
      context,
      'account-configurations:create-keyed',
      input(style, captions),
    );
  }
  if (!created.result.ok) {
    const message = `${firstRefusal} ${providerMessage(created.result.body)}`;
    const duplicatePolicy = /duplicat|same platform|same-platform|multiple accounts/i.test(message);
    context.ledger.record('account-configurations-accepted', 'negative', [
      `A list-shaped account_configurations was refused: ${firstRefusal}.`,
      namesTheField
        ? `A map keyed by account id was refused too: ${refusal(created.result)}.`
        : 'The refusal did not name the field, so the shape may not be what was refused.',
    ]);
    context.ledger.record('account-configuration-encoding', 'negative', [
      namesTheField
        ? 'Neither a list of objects carrying account_id nor a map keyed by account id was accepted.'
        : `The refusal named neither encoding: ${firstRefusal}.`,
    ]);
    context.ledger.explainUnverified(
      'account-configuration-fields-persist',
      'No post carrying account overrides was created, so nothing could be read back.',
    );
    context.ledger.record(
      'same-platform-duplicate-policy',
      duplicatePolicy ? 'verified-with-policy-constraint' : 'still-unverified',
      duplicatePolicy
        ? [
            `Two ${platform} accounts with materially different captions were refused in the provider's own terms: ${firstRefusal}.`,
          ]
        : [`The refusal said nothing about same-platform content: ${firstRefusal}.`],
    );
    return;
  }

  const providerPostId = created.providerPostId!;
  context.ledger.record('account-configurations-accepted', 'verified', [
    `POST /v1/posts accepted account_configurations for accounts ${first} and ${second} on ${platform} (HTTP ${created.result.status}).`,
  ]);
  context.ledger.record('account-configuration-encoding', 'verified', [
    style === 'list'
      ? 'A list of objects each carrying account_id was accepted on the first attempt.'
      : 'A map keyed by account id was accepted after the list form was refused by name.',
  ]);

  const afterCreate = await readPost(context, 'account-configurations:read', providerPostId);
  const patched = await context.client.api(
    'account-configurations:patch',
    updatePostRequest(providerPostId, input(style, patchedCaptions)),
  );
  const afterPatch = patched.ok
    ? await readPost(context, 'account-configurations:read-after-patch', providerPostId)
    : undefined;
  const shapeOf = (result: ProbeCallResult | undefined): string =>
    result?.ok ? describeShape(row(result).account_configurations, 2) : '(not read)';
  const persisted = afterCreate.ok && shapeOf(afterCreate) !== 'undefined';
  context.ledger.record(
    'account-configuration-fields-persist',
    persisted && afterPatch?.ok ? 'verified' : 'negative',
    [
      `After create, account_configurations read back as ${shapeOf(afterCreate)}.`,
      patched.ok
        ? `After PATCH — sent in full, scheduled_at included — it read back as ${shapeOf(afterPatch)}.`
        : `PATCH was refused: ${refusal(patched)}.`,
    ],
  );
  context.ledger.record('same-platform-duplicate-policy', 'verified-with-policy-constraint', [
    `The API accepted materially different captions to two ${platform} accounts in one request and raised no duplicate-content refusal.`,
    "A positive API response does not erase the vendor's support-page restriction on same-platform content: C77 carries the rule as its own preflight refusal rather than waiting for the provider to enforce it.",
  ]);
}

/** Question 3, plus the YouTube half of question 6, which the same read-back answers. */
async function questionThreeRoles(context: ProbeContext): Promise<void> {
  const document = context.uploaded.get('document');
  const linkedin = accountsOn(context.config, 'linkedin')[0];
  if (linkedin === undefined || !document)
    context.ledger.explainUnverified(
      'linkedin-document-title-role',
      linkedin === undefined
        ? 'No LinkedIn account was named.'
        : 'The PDF fixture was not uploaded, so there was no document to attach.',
    );
  else {
    const created = await createPost(context, 'linkedin-document:create', {
      caption: probeCaption(context.config.probeLabel, 'LinkedIn document role'),
      scheduledAt: context.config.scheduledAt,
      accountIds: [linkedin],
      mediaIds: [document.mediaId],
      platformConfigurations: {
        linkedin: { document_title: probeCaption(context.config.probeLabel, 'document title') },
      },
    });
    if (!created.result.ok)
      context.ledger.record('linkedin-document-title-role', 'negative', [
        `A PDF asset with document_title was refused: ${refusal(created.result)}.`,
      ]);
    else {
      const read = await readPost(context, 'linkedin-document:read', created.providerPostId!);
      context.ledger.record(
        'linkedin-document-title-role',
        readBackHasField(read, 'linkedin', 'document_title') ? 'verified' : 'negative',
        [
          `POST accepted an application/pdf asset by id with linkedin.document_title (HTTP ${created.result.status}).`,
          read.ok
            ? `The read-back's platform_configurations read as ${describeShape(row(read).platform_configurations, 2)}.`
            : `The read-back was refused: ${refusal(read)}.`,
          `Fixture sha256 ${document.fixture.sha256}.`,
        ],
      );
    }
  }

  const video = context.uploaded.get('video');
  const cover = context.uploaded.get('cover');
  const youtube = accountsOn(context.config, 'youtube')[0];
  const instagram = accountsOn(context.config, 'instagram')[0];
  const roleClaims = [
    'youtube-thumbnail-role',
    'instagram-cover-image-role',
    'youtube-contains-synthetic-media',
  ] as const;
  if (!video || !cover || (youtube === undefined && instagram === undefined)) {
    for (const claim of roleClaims)
      context.ledger.explainUnverified(
        claim,
        !video
          ? 'No video asset was uploaded, and both roles need a video as the post’s own media.'
          : !cover
            ? 'No second image was uploaded, so there was no distinct asset to give a role to.'
            : 'Neither a YouTube nor an Instagram account was named.',
      );
    return;
  }
  const platformConfigurations: Record<string, Record<string, unknown>> = {};
  if (youtube !== undefined)
    platformConfigurations.youtube = {
      title: probeCaption(context.config.probeLabel, 'video title'),
      thumbnail: cover.mediaId,
      contains_synthetic_media: true,
    };
  if (instagram !== undefined) platformConfigurations.instagram = { cover_image: cover.mediaId };
  const created = await createPost(context, 'media-roles:create', {
    caption: probeCaption(context.config.probeLabel, 'media roles'),
    scheduledAt: context.config.scheduledAt,
    accountIds: [youtube, instagram].filter((id): id is number => id !== undefined),
    mediaIds: [video.mediaId],
    platformConfigurations,
  });
  if (!created.result.ok) {
    for (const claim of roleClaims)
      context.ledger.explainUnverified(
        claim,
        `The role post was refused before any role could be read back: ${refusal(created.result)}.`,
      );
    return;
  }
  const read = await readPost(context, 'media-roles:read', created.providerPostId!);
  const configurationShape = read.ok
    ? describeShape(row(read).platform_configurations, 3)
    : '(not read)';
  if (youtube !== undefined) {
    context.ledger.record(
      'youtube-thumbnail-role',
      readBackHasField(read, 'youtube', 'thumbnail') ? 'verified' : 'negative',
      [
        `A scheduled post with youtube.thumbnail set to an uploaded media id answered HTTP ${created.result.status}.`,
        `The read-back's platform_configurations read as ${configurationShape}.`,
        'The support page saying custom external thumbnails are unavailable is a claim about delivery to the platform. Acceptance here is not delivery, which stays C76’s manual QA.',
      ],
    );
    context.ledger.record(
      'youtube-contains-synthetic-media',
      readBackHasField(read, 'youtube', 'contains_synthetic_media') ? 'verified' : 'negative',
      [
        `contains_synthetic_media: true went out with the same post (HTTP ${created.result.status}).`,
        `The read-back's platform_configurations read as ${configurationShape}.`,
      ],
    );
  }
  if (instagram !== undefined)
    context.ledger.record(
      'instagram-cover-image-role',
      readBackHasField(read, 'instagram', 'cover_image') ? 'verified' : 'negative',
      [
        `A scheduled post with instagram.cover_image set to an uploaded media id answered HTTP ${created.result.status}.`,
        `The read-back's platform_configurations read as ${configurationShape}.`,
        `Cover fixture sha256 ${cover.fixture.sha256}.`,
      ],
    );
}

/** Question 4's two remaining halves: which repeatable encoding filters, and the provider-UI shape. */
async function questionFourList(context: ProbeContext): Promise<void> {
  const attempt = async (style: 'bracket' | 'repeat') => {
    const result = await context.client.api(
      `posts-filter:${style}`,
      listPostsRequest({ limit: 5, offset: 0, status: ['scheduled'], style }),
    );
    if (!result.ok) return { note: `refused: ${refusal(result)}`, filtered: false };
    const rows = dataRows(result);
    const offType = rows.filter((listed) => listed.status !== 'scheduled').length;
    return {
      note: `${rows.length} row(s), ${offType} of them not scheduled`,
      filtered: rows.length > 0 && offType === 0,
    };
  };
  const bracket = await attempt('bracket');
  const repeat = await attempt('repeat');
  const winner = bracket.filtered
    ? 'status[]'
    : repeat.filtered
      ? 'a bare repeated status'
      : undefined;
  context.ledger.record('posts-list-filter-encoding', winner ? 'verified' : 'still-unverified', [
    `status[]=scheduled: ${bracket.note}.`,
    `status=scheduled: ${repeat.note}.`,
    winner
      ? `${winner} returned only scheduled rows, so that is the encoding C78 sends.`
      : 'Neither encoding demonstrably filtered, so C78 cannot lean on a provider-side filter.',
  ]);

  if (context.config.providerUiPostId === undefined) {
    context.ledger.explainUnverified(
      'posts-list-provider-ui-shape',
      'No --provider-ui-post was supplied. The probe never creates one to stand in for a post a person made in the provider’s UI.',
    );
    return;
  }
  const read = await context.client.api(
    'provider-ui-post',
    getPostRequest(context.config.providerUiPostId),
  );
  context.ledger.record('posts-list-provider-ui-shape', read.ok ? 'verified' : 'negative', [
    read.ok
      ? `The owner-created post read back as ${describeShape(read.body, 2)}.`
      : `The named provider-UI post could not be read: ${refusal(read)}.`,
  ]);
}

/** Question 5. */
async function questionFiveAnalytics(context: ProbeContext): Promise<void> {
  const unfiltered = await context.client.api(
    'analytics:unfiltered',
    analyticsRequest({ limit: 5, offset: 0 }),
  );
  if (!unfiltered.ok) {
    for (const claim of [
      'analytics-pagination',
      'analytics-timeframe-meaning',
      'analytics-response-grain',
      'analytics-account-mapping',
      'analytics-match-confidence',
    ] as const)
      context.ledger.explainUnverified(claim, `GET /v1/analytics answered ${refusal(unfiltered)}.`);
    return;
  }
  const rows = dataRows(unfiltered);
  const perDelivery =
    rows.length > 0 && rows.every((listed) => listed.post_result_id !== undefined);
  context.ledger.record('analytics-pagination', 'verified', [
    `GET /v1/analytics?limit=5&offset=0 answered with meta ${describeShape(row(unfiltered).meta, 2)}.`,
  ]);
  context.ledger.record(
    'analytics-response-grain',
    perDelivery ? 'verified' : 'still-unverified',
    rows.length
      ? [
          `${rows.length} row(s) came back, each shaped ${describeShape(rows[0], 1)}.`,
          perDelivery
            ? 'Every row carried post_result_id, so the grain is one row per measured delivery rather than an account aggregate.'
            : 'At least one row carried no post_result_id, so the grain is not reliably per delivery.',
        ]
      : ['No analytics rows exist on this account yet, so the grain was not observed.'],
  );
  context.ledger.record(
    'analytics-account-mapping',
    perDelivery ? 'verified' : 'still-unverified',
    rows.length
      ? [
          `The only delivery-shaped handle on a row is post_result_id; the row is shaped ${describeShape(rows[0], 1)}.`,
          'Mapping to an account therefore goes through signal_publication_targets locally, which is what C80 must do rather than reading an account field off the row.',
        ]
      : ['No rows, so no mapping was observed.'],
  );
  const confidences = [
    ...new Set(
      rows
        .map((listed) => listed.match_confidence)
        .filter((value): value is string => typeof value === 'string'),
    ),
  ];
  const missing = rows.filter(
    (listed) => listed.match_confidence === undefined || listed.match_confidence === null,
  ).length;
  context.ledger.record(
    'analytics-match-confidence',
    rows.length ? 'verified' : 'still-unverified',
    rows.length
      ? [
          confidences.length
            ? `Observed values: ${confidences.map((value) => `\`${redactSecrets(value)}\``).join(', ')}.`
            : 'No row carried a string match_confidence.',
          `${missing} of ${rows.length} row(s) carried none at all, so C79 treats absence as absence rather than defaulting it.`,
        ]
      : ['No rows, so no values were observed.'],
  );

  const platform = context.config.accounts
    .map((account) => account.platform)
    .find((candidate) => (ANALYTICS_PLATFORMS as readonly string[]).includes(candidate));
  if (!platform) {
    context.ledger.explainUnverified(
      'analytics-timeframe-meaning',
      `No named account is on a platform this provider measures (${ANALYTICS_PLATFORMS.join(', ')}), so no window filter was sent.`,
    );
    return;
  }
  const window7 = await context.client.api(
    'analytics:7d',
    analyticsRequest({ limit: 5, offset: 0, platform, timeframe: '7d' }),
  );
  const windowAll = await context.client.api(
    'analytics:all',
    analyticsRequest({ limit: 5, offset: 0, platform, timeframe: 'all' }),
  );
  const describeCount = (result: ProbeCallResult): string =>
    result.ok ? `${dataRows(result).length} row(s)` : `refused (${refusal(result)})`;
  const sevenIds = new Set(dataRows(window7).map((listed) => String(listed.id)));
  const narrowed =
    window7.ok &&
    windowAll.ok &&
    dataRows(windowAll).some((listed) => !sevenIds.has(String(listed.id)));
  context.ledger.record('analytics-timeframe-meaning', narrowed ? 'verified' : 'still-unverified', [
    `platform=${platform}&timeframe=7d returned ${describeCount(window7)}; timeframe=all returned ${describeCount(windowAll)}.`,
    narrowed
      ? 'The narrower window returned a subset of the same analytics rows, so timeframe selects which rows are included rather than trimming the days inside a row.'
      : 'Both windows returned the same rows, so the parameter’s meaning was not observable here — and a panel cannot be labelled from that. C80 stays blocked until a second look with more measured history.',
    dataRows(window7).length
      ? `A windowed row is shaped ${describeShape(dataRows(window7)[0], 1)} — the same per-delivery grain as the unfiltered list, not an account aggregate.`
      : 'The narrow window was empty.',
  ]);
}

/** Question 6's TikTok and Facebook halves. YouTube's flag is answered with the role post. */
async function questionSixPlatformFields(context: ProbeContext): Promise<void> {
  const tiktok = accountsOn(context.config, 'tiktok')[0];
  const facebook = accountsOn(context.config, 'facebook')[0];
  if (tiktok === undefined)
    context.ledger.explainUnverified('tiktok-disclosure-toggles', 'No TikTok account was named.');
  if (facebook === undefined)
    context.ledger.explainUnverified('facebook-story-placement', 'No Facebook account was named.');
  if (tiktok === undefined && facebook === undefined) return;
  const media = context.uploaded.get('video') ?? context.uploaded.get('image');
  if (!media) {
    const reason = 'No asset was uploaded, so no media post could be created.';
    if (tiktok !== undefined) context.ledger.explainUnverified('tiktok-disclosure-toggles', reason);
    if (facebook !== undefined)
      context.ledger.explainUnverified('facebook-story-placement', reason);
    return;
  }
  const platformConfigurations: Record<string, Record<string, unknown>> = {};
  if (tiktok !== undefined)
    platformConfigurations.tiktok = { disclose_branded_content: true, disclose_your_brand: false };
  if (facebook !== undefined) platformConfigurations.facebook = { placement: 'story' };
  const created = await createPost(context, 'platform-fields:create', {
    caption: probeCaption(context.config.probeLabel, 'platform disclosure fields'),
    scheduledAt: context.config.scheduledAt,
    accountIds: [tiktok, facebook].filter((id): id is number => id !== undefined),
    mediaIds: [media.mediaId],
    platformConfigurations,
  });
  if (!created.result.ok) {
    if (tiktok !== undefined)
      context.ledger.record('tiktok-disclosure-toggles', 'negative', [
        `The post carrying the toggles was refused: ${refusal(created.result)}.`,
      ]);
    if (facebook !== undefined)
      context.ledger.record('facebook-story-placement', 'negative', [
        `The post carrying placement: "story" was refused: ${refusal(created.result)}.`,
      ]);
    return;
  }
  const read = await readPost(context, 'platform-fields:read', created.providerPostId!);
  const shape = read.ok ? describeShape(row(read).platform_configurations, 3) : '(not read)';
  if (tiktok !== undefined)
    context.ledger.record(
      'tiktok-disclosure-toggles',
      readBackHasField(read, 'tiktok', 'disclose_branded_content') ? 'verified' : 'negative',
      [
        `disclose_branded_content: true and disclose_your_brand: false were accepted (HTTP ${created.result.status}).`,
        `The read-back's platform_configurations read as ${shape}.`,
        readBackHasField(read, 'tiktok', 'disclose_your_brand')
          ? 'Both keys came back, so false is distinguishable from unset on the read.'
          : 'disclose_your_brand did not come back, so false and unset are indistinguishable there and C81 must keep the distinction locally.',
      ],
    );
  if (facebook !== undefined)
    context.ledger.record(
      'facebook-story-placement',
      readBackHasField(read, 'facebook', 'placement') ? 'verified' : 'negative',
      [
        `The generic story path's placement: "story" was accepted for Facebook (HTTP ${created.result.status}).`,
        `The read-back's platform_configurations read as ${shape}.`,
      ],
    );
}

/**
 * Deletes everything, then proves it.
 *
 * Newest first, so the last thing created is the first thing gone, and every step is individually
 * guarded: failing to delete one post must not stop the next one being deleted, and a `429` arriving
 * here must not turn a partial cleanup into an exception nobody catches.
 */
async function teardown(context: ProbeContext): Promise<ProbeTeardownResult> {
  const deletedPosts: string[] = [];
  const failedPosts: { providerId: string; reason: string }[] = [];
  for (const providerPostId of [...context.createdPosts].reverse()) {
    try {
      const result = await context.client.api(
        `teardown:delete-post-${providerPostId}`,
        deletePostRequest(providerPostId),
        { teardown: true },
      );
      if (result.ok) deletedPosts.push(providerPostId);
      else failedPosts.push({ providerId: providerPostId, reason: refusal(result) });
    } catch (error) {
      failedPosts.push({
        providerId: providerPostId,
        reason: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  const deletedMedia: string[] = [];
  const undeletableMedia: { providerId: string; reason: string }[] = [];
  const mediaIds = [
    ...[...context.uploaded.values()].map((asset) => asset.mediaId),
    ...context.strayMedia,
  ];
  for (const mediaId of mediaIds) {
    try {
      const result = await context.client.api(
        `teardown:delete-media-${mediaId}`,
        deleteMediaRequest(mediaId),
        { teardown: true },
      );
      if (result.ok) deletedMedia.push(mediaId);
      else undeletableMedia.push({ providerId: mediaId, reason: refusal(result) });
    } catch (error) {
      undeletableMedia.push({
        providerId: mediaId,
        reason: redactSecrets(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  if (mediaIds.length)
    context.ledger.record(
      'media-delete-endpoint',
      undeletableMedia.length === 0 ? 'verified' : 'negative',
      [
        `DELETE /v1/media/{id} removed ${deletedMedia.length} of ${mediaIds.length} provider asset(s) this run created.`,
        ...undeletableMedia.map((asset) => `${asset.providerId} was not deleted: ${asset.reason}.`),
      ],
    );
  else
    context.ledger.explainUnverified(
      'media-delete-endpoint',
      'This run created no provider asset, so the delete endpoint was never exercised.',
    );

  const followUp = new Date(context.now.getTime() + 25 * 3_600_000).toISOString();
  context.ledger.explainUnverified(
    'media-expiry-lifecycle',
    undeletableMedia.length
      ? `One session cannot observe a 24-hour expiry. Re-read ${undeletableMedia
          .map((asset) => asset.providerId)
          .join(
            ', ',
          )} no earlier than ${followUp}, and record that dated result before anything treats the expiry as fact.`
      : 'Every provider asset was deleted explicitly, so the documented 24-hour unattached expiry was never exercised. A deletion is not an expiry, and it stays unverified until a dated follow-up observes one.',
  );

  let inventory: ProbeTeardownResult['inventory'] = 'not-verified';
  let inventoryNote = 'The post inventory was not re-read.';
  if (!context.createdPosts.length)
    context.ledger.explainUnverified(
      'posts-list-disappearance',
      'This run created no post, so there was no deletion to observe.',
    );
  else
    try {
      const read = await readInventory(context, 'teardown-inventory', { teardown: true });
      const remaining = context.createdPosts.filter((id) => read.ids.includes(id));
      if (!read.complete) {
        inventoryNote = `The inventory read did not complete (${read.note}), so absence could not be proved. Check the provider by hand.`;
      } else if (remaining.length) {
        inventory = 'still-present';
        inventoryNote = `Still listed after deletion: ${remaining.join(', ')}. Remove them by hand now.`;
      } else {
        inventory = 'verified-absent';
        inventoryNote = `A complete ${read.pages}-page inventory read afterwards listed none of the ${context.createdPosts.length} post(s) this run created.`;
      }
      context.ledger.record(
        'posts-list-disappearance',
        inventory === 'verified-absent'
          ? 'verified'
          : inventory === 'still-present'
            ? 'negative'
            : 'still-unverified',
        [inventoryNote],
      );
    } catch (error) {
      inventoryNote = redactSecrets(error instanceof Error ? error.message : String(error));
      context.ledger.explainUnverified('posts-list-disappearance', inventoryNote);
    }

  return {
    createdPosts: [...context.createdPosts],
    deletedPosts,
    failedPosts,
    deletedMedia,
    undeletableMedia,
    inventory,
    inventoryNote,
  };
}

/** Question 7, from what happened rather than from anything the probe went looking for. */
function recordRateLimits(context: ProbeContext): void {
  if (!context.client.rateLimits.length) {
    context.ledger.explainUnverified(
      'rate-limit-headers',
      'No 429 arrived. The probe has a fixed request budget and never creates load to discover a limit, so this stays unverified by design rather than by omission.',
    );
    return;
  }
  const withHeaders = context.client.rateLimits.filter(
    (call) => Object.keys(call.headers).length > 0,
  );
  context.ledger.record('rate-limit-headers', withHeaders.length ? 'verified' : 'negative', [
    `${context.client.rateLimits.length} unprovoked 429 response(s), on: ${context.client.rateLimits
      .map((call) => `${call.method} ${call.url}`)
      .join(', ')}.`,
    withHeaders.length
      ? `Headers observed: ${withHeaders.map((call) => JSON.stringify(call.headers)).join(', ')}.`
      : 'None carried a recognised rate-limit header, so PUBLISH_RATE_LIMIT_FALLBACK_SECONDS stays the authority.',
  ]);
}

export async function runProbe(deps: ProbeDeps): Promise<ProbeRunResult> {
  const context: ProbeContext = {
    ...deps,
    ledger: deps.ledger ?? new ClaimLedger(),
    createdPosts: [],
    uploaded: new Map(),
    strayMedia: [],
  };
  let stopped: string | undefined;
  let teardownResult: ProbeTeardownResult;
  try {
    await preflight(context);
    await questionTwoUpload(context);
    await questionTwoMediaPrecedence(context);
    await questionOneAccounts(context);
    await questionThreeRoles(context);
    await questionFourList(context);
    await questionFiveAnalytics(context);
    await questionSixPlatformFields(context);
  } catch (error) {
    stopped = redactSecrets(error instanceof Error ? error.message : String(error));
  } finally {
    teardownResult = await teardown(context);
  }
  recordRateLimits(context);
  if (stopped)
    for (const claim of context.ledger.results())
      if (claim.state === 'still-unverified' && claim.evidence[0] === 'Not attempted in this run.')
        context.ledger.explainUnverified(claim.id, `Not reached — the run stopped: ${stopped}`);

  const leftovers: ProbeArtifact[] = [
    ...teardownResult.failedPosts.map((post) => ({
      kind: 'post' as const,
      providerId: post.providerId,
      note: `A scheduled post the provider still holds: ${post.reason}. Delete it by hand now.`,
    })),
    ...teardownResult.undeletableMedia.map((asset) => ({
      kind: 'media' as const,
      providerId: asset.providerId,
      note: `An uploaded asset the provider still holds: ${asset.reason}.`,
    })),
  ];
  return {
    claims: context.ledger.results(),
    calls: context.client.calls,
    budget: {
      used: context.client.budget.used,
      total: context.client.budget.total,
      reserve: context.client.budget.reserve,
    },
    fixtures: [...context.fixtures.values()].map(fixtureRecord),
    teardown: teardownResult,
    leftovers,
    ...(stopped ? { stopped } : {}),
  };
}
