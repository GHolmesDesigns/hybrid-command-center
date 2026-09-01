import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Db } from '../db.ts';
import { transaction } from '../db.ts';
import {
  readTabbedWorkbook,
  readXlsxWorkbook,
  WorkbookError,
  findSheet,
  type Workbook,
  type Cell,
} from '../domain/workbook.ts';
import { readSignalPostIdentityWorkspace, recordSignalPostImportAlias } from './import-identity.ts';
import {
  planSignalPostIdentities,
  type SignalPostIdentityMatch,
} from '../domain/signal-post-identity.ts';
import {
  resolveDriveMedia,
  parseDriveMediaLink,
  driveMediaProvider,
  type DriveMediaProvider,
} from '../drive/media.ts';
import {
  signalMediaFingerprint,
  signalPostMediaIssue,
  urlPostMedia,
  type SignalPostMedia,
} from '../../shared/signal-media.ts';
import {
  SIGNAL_CHANNELS,
  SIGNAL_CTAS,
  SIGNAL_DATE_PATTERN,
  SIGNAL_DEFAULT_TIME,
  SIGNAL_FORMATS,
  SIGNAL_STATUSES,
  SIGNAL_TIME_PATTERN,
  isSignalDate,
} from '../../shared/signal.ts';
import { PUBLISH_PLATFORMS, PUBLISH_POST_KINDS } from '../../shared/publish-capabilities.ts';
import {
  PUBLISH_VARIANT_MEDIA_ROLES,
  type PublishVariantMediaRole,
} from '../../shared/publish-variant-media.ts';
import {
  normalizePublishVariant,
  type PublishContentVariant,
} from '../../shared/publish-variants.ts';
import { writePostCampaigns } from './campaigns.ts';
import { recordIntegrationEvent } from '../integration-log.ts';
import {
  SIGNAL_IMPORT_DUPLICATE_RULE,
  SIGNAL_IMPORT_RECEIPT_LIMIT,
  SIGNAL_IMPORT_SCHEMA_VERSION,
  SIGNAL_IMPORT_SOURCE_NAME,
  SIGNAL_IMPORT_SHEETS,
  emptySignalImportCapabilitySummary,
  emptySignalImportCounts,
  signalImportTotal,
  type SignalImportCounts,
  type SignalImportCreation,
  type SignalImportIssue,
  type SignalImportOutcome,
  type SignalImportPreview,
  type SignalImportReceipt,
  type SignalImportResolvedMedia,
  type SignalImportSkip,
} from '../../shared/signal-import.ts';

export const SAMPLE_SIGNAL_DIRECTORY = fileURLToPath(
  new URL('../../docs/examples/', import.meta.url),
);
import {
  connectedPublishTargetsFromDb,
  evaluateImportCapabilities,
} from './import-capabilities.ts';

export const SIGNAL_IMPORT_TEXT_MAX = 4_000_000;
export const SIGNAL_IMPORT_CONTENT_BASE64_MAX = 12_000_000;
const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const keySchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_-]*$/);
const text = (v: string | undefined) => v?.trim() ?? '';
const split = (v: string | undefined) =>
  text(v)
    ? text(v)
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null);
const date = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || null)
  .refine((v) => v === null || SIGNAL_DATE_PATTERN.test(v), 'Use a YYYY-MM-DD date.')
  .refine((v) => v === null || isSignalDate(v), 'That date does not exist.');
const time = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || SIGNAL_DEFAULT_TIME)
  .pipe(z.string().regex(SIGNAL_TIME_PATTERN, 'Use a 24-hour HH:MM time.'));

interface Parsed {
  workbook: Workbook;
  kind: 'xlsx' | 'text';
  filename?: string;
  fingerprint: string;
}
interface MediaPlan {
  postKey: string;
  row: number;
  order: number;
  source: 'URL' | 'DRIVE';
  url: string;
  media?: SignalPostMedia;
}
interface VariantPlan {
  postKey: string;
  row: number;
  platform: string;
  accountId: number | null;
  text: PublishContentVariant;
  roles: Partial<Record<PublishVariantMediaRole, SignalPostMedia>>;
}
interface PostPlan {
  key: string;
  row: number;
  text: string;
  channels: string[];
  date: string | null;
  time: string;
  format: string;
  status: string;
  campaigns: string[];
  cta: string;
  position: number | null;
  postImportSource: string | null;
  postImportId: string | null;
  media: MediaPlan[];
  variants: VariantPlan[];
}
interface Plan {
  schemaVersion: number;
  posts: PostPlan[];
  matches: Map<string, SignalPostIdentityMatch>;
  aliases: { postKey: string; namespace: string; externalId: string; postId?: string }[];
  created: SignalImportCreation[];
  updated: SignalImportCreation[];
  skipped: SignalImportSkip[];
  issues: SignalImportIssue[];
}
const previewPlans = new Map<string, Plan>();

function cellValue(cell: Cell | undefined): string | undefined {
  if (!cell) return undefined;
  return cell.value;
}

function parseInput(input: { filename?: string; contentBase64?: string; text?: string }): Parsed {
  try {
    if (input.contentBase64) {
      const buffer = Buffer.from(input.contentBase64, 'base64');
      return {
        workbook: readXlsxWorkbook(buffer),
        kind: 'xlsx',
        ...(input.filename ? { filename: input.filename } : {}),
        fingerprint: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    }
    const raw = input.text ?? '';
    return {
      workbook: readTabbedWorkbook(raw),
      kind: 'text',
      ...(input.filename ? { filename: input.filename } : {}),
      fingerprint: crypto.createHash('sha256').update(raw.replace(/\r\n?/g, '\n')).digest('hex'),
    };
  } catch (error) {
    if (error instanceof WorkbookError) throw new Error(error.message, { cause: error });
    throw error;
  }
}

function rows(
  workbook: Workbook,
  name: string,
  headers: readonly string[],
  issues: SignalImportIssue[],
  optional: readonly string[] = [],
) {
  const sheet = findSheet(workbook, name);
  if (!sheet)
    return {
      entries: [] as { row: number; values: Record<string, string | undefined> }[],
      columns: new Map<string, number>(),
    };
  if (sheet.hidden) issues.push({ sheet: name, message: 'This tab is hidden.' });
  for (const range of sheet.mergedRanges)
    issues.push({ sheet: name, message: `Merged cells are not allowed (${range}).` });
  for (const row of sheet.rows) {
    if (row.hidden) issue(issues, name, row.number, 'Hidden rows are not allowed.');
    row.cells.forEach((cell, index) => {
      if (cell?.formula)
        issue(
          issues,
          name,
          row.number,
          'Formulas are not allowed; paste the displayed value.',
          String.fromCharCode(65 + index),
        );
    });
  }
  const [header, ...body] = sheet.rows;
  const columns = new Map<string, number>();
  if (!header) {
    issues.push({ sheet: name, message: 'This tab is empty.' });
    return { entries: [], columns };
  }
  header.cells.forEach((cell, i) => {
    if (cell) columns.set(cell.value.trim(), i);
  });
  for (const required of headers)
    if (!columns.has(required))
      issues.push({
        sheet: name,
        row: header.number,
        message: `The ${required} column is missing.`,
      });
  for (const nameOf of columns.keys())
    if (![...headers, ...optional].includes(nameOf))
      issues.push({
        sheet: name,
        row: header.number,
        message: `${nameOf} is not a column of this tab.`,
      });
  const entries = body
    .map((r) => ({
      row: r.number,
      values: Object.fromEntries([...columns].map(([key, i]) => [key, cellValue(r.cells[i])])),
    }))
    .filter((entry) => Object.values(entry.values).some((v) => text(v)));
  return { entries, columns };
}

const issue = (
  issues: SignalImportIssue[],
  sheet: string,
  row: number,
  message: string,
  column?: string,
) => issues.push({ sheet, row, ...(column ? { column } : {}), message });

/**
 * Bind one `[SignalMedia]` row. Format refusals that need no Drive round-trip — a `URL` on a Drive
 * host, a forged or mistyped Drive link — happen before `getFile`. Everything else is Drive's own
 * words on that row alone, so one unreachable file does not stop the rest of the workbook from
 * being planned.
 */
async function resolveSignalMediaRow(
  media: MediaPlan,
  provider: DriveMediaProvider,
  issues: SignalImportIssue[],
) {
  if (media.source === 'URL') {
    try {
      const item = urlPostMedia(media.url);
      const mediaIssue = signalPostMediaIssue(item);
      if (mediaIssue) {
        issue(issues, 'SignalMedia', media.row, mediaIssue, 'url');
        return;
      }
      media.media = item;
    } catch (error) {
      issue(
        issues,
        'SignalMedia',
        media.row,
        error instanceof Error ? error.message : 'That media URL is not usable.',
        'url',
      );
    }
    return;
  }
  // Parse before contacting Drive: a mistyped link is a format refusal, not a provider call.
  try {
    parseDriveMediaLink(media.url);
  } catch (error) {
    issue(
      issues,
      'SignalMedia',
      media.row,
      error instanceof Error ? error.message : 'That Drive link is not usable.',
      'url',
    );
    return;
  }
  try {
    media.media = await resolveDriveMedia({ link: media.url, provider });
    const mediaIssue = signalPostMediaIssue(media.media);
    if (mediaIssue) issue(issues, 'SignalMedia', media.row, mediaIssue);
  } catch (error) {
    issue(
      issues,
      'SignalMedia',
      media.row,
      error instanceof Error ? error.message : 'Drive resolution failed.',
    );
  }
}

/**
 * Re-resolve every Drive media reference the preview bound and refuse when any fingerprint moved.
 * The confirm transaction writes the descriptors the preview showed; this check is what makes a
 * file replaced under the same id between looking and pressing a refusal rather than a silent
 * rewrite — the same staleness rule publish confirmation uses.
 */
async function assertPreviewDriveFingerprints(
  plan: Plan,
  provider: DriveMediaProvider,
): Promise<SignalImportIssue[]> {
  const issues: SignalImportIssue[] = [];
  for (const post of plan.posts) {
    for (const media of post.media) {
      if (media.source !== 'DRIVE' || !media.media) continue;
      try {
        const current = await resolveDriveMedia({ link: media.url, provider });
        if (
          JSON.stringify(signalMediaFingerprint(current)) !==
          JSON.stringify(signalMediaFingerprint(media.media))
        ) {
          issue(
            issues,
            'SignalMedia',
            media.row,
            `${media.media.driveName ?? 'That Drive file'} changed after the import preview. Check the Signal import again.`,
          );
        }
      } catch (error) {
        issue(
          issues,
          'SignalMedia',
          media.row,
          error instanceof Error ? error.message : 'Drive resolution failed.',
        );
      }
    }
  }
  return issues;
}

function resolvedMediaFromPlan(plan: Plan): SignalImportResolvedMedia[] {
  return plan.posts.flatMap((post) =>
    post.media.map((media) => {
      const base: SignalImportResolvedMedia = {
        sheet: 'SignalMedia',
        row: media.row,
        postKey: media.postKey,
        order: media.order,
        source: media.source,
        url: media.media?.url ?? media.url,
        resolved: Boolean(media.media),
      };
      if (media.media?.source === 'DRIVE') {
        return {
          ...base,
          ...(media.media.driveName ? { driveName: media.media.driveName } : {}),
          ...(media.media.mimeType ? { mimeType: media.media.mimeType } : {}),
          ...(media.media.sizeBytes !== null && media.media.sizeBytes !== undefined
            ? { sizeBytes: media.media.sizeBytes }
            : {}),
          ...(media.media.driveVerifiedAt ? { resolvedAt: media.media.driveVerifiedAt } : {}),
        };
      }
      return base;
    }),
  );
}

async function buildPlan(parsed: Parsed, db: Db, provider: DriveMediaProvider): Promise<Plan> {
  const issues: SignalImportIssue[] = [];
  const known = new Set([...SIGNAL_IMPORT_SHEETS, 'README', 'DataDictionary', 'AllowedValues']);
  for (const sheet of parsed.workbook.sheets)
    if (!known.has(sheet.name))
      issues.push({
        sheet: sheet.name,
        message: 'This tab is not part of the Signal import format.',
      });
  let schemaVersion = SIGNAL_IMPORT_SCHEMA_VERSION;
  for (const name of ['README', 'DataDictionary', 'AllowedValues']) {
    const sheet = findSheet(parsed.workbook, name);
    const found = sheet?.rows.find((r) =>
      ['schema version', 'schema_version'].includes(text(r.cells[0]?.value).toLowerCase()),
    );
    if (found) {
      schemaVersion = Number(text(found.cells[1]?.value));
      if (schemaVersion !== SIGNAL_IMPORT_SCHEMA_VERSION)
        issue(
          issues,
          name,
          found.number,
          `This workbook declares schema version ${text(found.cells[1]?.value)}. This build imports version ${SIGNAL_IMPORT_SCHEMA_VERSION}.`,
        );
      break;
    }
  }
  const postRows = rows(parsed.workbook, 'SignalPosts', ['post_key', 'text'], issues, [
    'channels',
    'date',
    'time',
    'format',
    'status',
    'campaigns',
    'cta',
    'position',
    'post_import_source',
    'post_import_id',
  ]);
  const mediaRows = rows(
    parsed.workbook,
    'SignalMedia',
    ['post_key', 'media_order', 'source', 'url'],
    issues,
  );
  const variantRows = rows(parsed.workbook, 'SignalVariants', ['post_key', 'platform'], issues, [
    'account_id',
    'caption',
    'media_urls',
    'post_kind',
    'title',
    'first_comment',
    'disclose_synthetic_media',
    'cover_image',
    'thumbnail',
  ]);
  const posts: PostPlan[] = [];
  const byKey = new Map<string, PostPlan>();
  for (const entry of postRows.entries) {
    const v = entry.values;
    const parsedRow = z
      .object({
        key: keySchema,
        text: z.string().trim().min(1).max(20000),
        channels: z.array(z.string()).default([]),
        date,
        time,
        format: z
          .string()
          .trim()
          .optional()
          .transform((x) => x || 'TEXT'),
        status: z
          .string()
          .trim()
          .optional()
          .transform((x) => x || 'DRAFT'),
        campaigns: z.array(z.string()).default([]),
        cta: z
          .string()
          .trim()
          .optional()
          .transform((x) => x || 'NONE'),
        position: z
          .string()
          .trim()
          .optional()
          .transform((x) => (x ? Number(x) : null)),
        source: optional,
        externalId: optional,
      })
      .safeParse({
        key: v.post_key,
        text: v.text,
        channels: split(v.channels),
        date: v.date,
        time: v.time,
        format: v.format,
        status: v.status,
        campaigns: split(v.campaigns),
        cta: v.cta,
        position: v.position,
        source: v.post_import_source,
        externalId: v.post_import_id,
      });
    if (!parsedRow.success) {
      issue(issues, 'SignalPosts', entry.row, parsedRow.error.issues[0]?.message ?? 'Invalid row.');
      continue;
    }
    const value = parsedRow.data;
    if (byKey.has(value.key)) {
      issue(issues, 'SignalPosts', entry.row, `post_key ${value.key} is already defined.`);
      continue;
    }
    if (value.channels.some((c) => !(SIGNAL_CHANNELS as readonly string[]).includes(c))) {
      issue(issues, 'SignalPosts', entry.row, 'channels contains an unknown channel.');
      continue;
    }
    if (
      !(SIGNAL_FORMATS as readonly string[]).includes(value.format) ||
      !(SIGNAL_STATUSES.filter((s) => s !== 'PUBLISHED') as readonly string[]).includes(
        value.status,
      ) ||
      !(SIGNAL_CTAS as readonly string[]).includes(value.cta)
    ) {
      issue(
        issues,
        'SignalPosts',
        entry.row,
        'format, status, or cta is not an allowed planning value.',
      );
      continue;
    }
    if (value.campaigns.length > 12) {
      issue(issues, 'SignalPosts', entry.row, 'At most 12 campaigns may be attached.');
      continue;
    }
    const post: PostPlan = {
      key: value.key,
      row: entry.row,
      text: value.text,
      channels: [...new Set(value.channels)],
      date: value.date,
      time: value.time,
      format: value.format,
      status: value.status,
      campaigns: value.campaigns,
      cta: value.cta,
      position: value.position,
      postImportSource: value.source,
      postImportId: value.externalId,
      media: [],
      variants: [],
    };
    byKey.set(post.key, post);
    posts.push(post);
  }
  for (const entry of mediaRows.entries) {
    const v = entry.values;
    const post = byKey.get(text(v.post_key));
    const order = Number(text(v.media_order));
    if (!post) {
      issue(issues, 'SignalMedia', entry.row, `post_key ${text(v.post_key)} is not defined.`);
      continue;
    }
    if (!Number.isInteger(order) || order < 1 || !['URL', 'DRIVE'].includes(text(v.source))) {
      issue(
        issues,
        'SignalMedia',
        entry.row,
        'media_order must be positive and source must be URL or DRIVE.',
      );
      continue;
    }
    if (post.media.some((m) => m.order === order)) {
      issue(
        issues,
        'SignalMedia',
        entry.row,
        `media_order ${order} is already used for ${post.key}.`,
      );
      continue;
    }
    post.media.push({
      postKey: post.key,
      row: entry.row,
      order,
      source: text(v.source) as 'URL' | 'DRIVE',
      url: text(v.url),
    });
  }
  for (const post of posts) {
    if (post.media.length > 20)
      issue(issues, 'SignalMedia', post.row, 'A post may reference at most 20 media items.');
    post.media.sort((a, b) => a.order - b.order);
    for (const media of post.media) await resolveSignalMediaRow(media, provider, issues);
  }
  for (const entry of variantRows.entries) {
    const v = entry.values;
    const post = byKey.get(text(v.post_key));
    const accountRaw = text(v.account_id);
    const accountId = accountRaw ? Number(accountRaw) : null;
    if (!post) {
      issue(issues, 'SignalVariants', entry.row, `post_key ${text(v.post_key)} is not defined.`);
      continue;
    }
    if (
      !(PUBLISH_PLATFORMS as readonly string[]).includes(text(v.platform)) ||
      (accountId !== null && (!Number.isInteger(accountId) || accountId <= 0))
    ) {
      issue(issues, 'SignalVariants', entry.row, 'platform or account_id is invalid.');
      continue;
    }
    if (post.variants.some((x) => x.platform === text(v.platform) && x.accountId === accountId)) {
      issue(issues, 'SignalVariants', entry.row, 'This platform/account layer is duplicated.');
      continue;
    }
    const variant: VariantPlan = {
      postKey: post.key,
      row: entry.row,
      platform: text(v.platform),
      accountId,
      text: normalizePublishVariant({
        ...(v.caption !== undefined && text(v.caption) ? { caption: text(v.caption) } : {}),
        ...(v.media_urls !== undefined ? { mediaUrls: split(v.media_urls) } : {}),
        ...(v.post_kind !== undefined && text(v.post_kind)
          ? { postKind: text(v.post_kind) as never }
          : {}),
        ...(v.title !== undefined && text(v.title) ? { title: text(v.title) } : {}),
        ...(v.first_comment !== undefined && text(v.first_comment)
          ? { firstComment: text(v.first_comment) }
          : {}),
        ...(v.disclose_synthetic_media !== undefined && text(v.disclose_synthetic_media)
          ? { discloseSyntheticMedia: text(v.disclose_synthetic_media).toUpperCase() === 'TRUE' }
          : {}),
      }),
      roles: {},
    };
    if (
      variant.text.postKind &&
      !(PUBLISH_POST_KINDS as readonly string[]).includes(variant.text.postKind)
    )
      issue(issues, 'SignalVariants', entry.row, 'post_kind is invalid.');
    for (const [column, role] of [
      ['cover_image', 'COVER_IMAGE'],
      ['thumbnail', 'THUMBNAIL'],
    ] as const) {
      if (v[column] === undefined || !text(v[column])) continue;
      try {
        variant.roles[role] =
          text(v[column]).startsWith('https://drive.google.com') ||
          text(v[column]).startsWith('https://docs.google.com')
            ? await resolveDriveMedia({ link: text(v[column]), provider })
            : urlPostMedia(text(v[column]));
      } catch (error) {
        issue(
          issues,
          'SignalVariants',
          entry.row,
          error instanceof Error ? error.message : 'Drive resolution failed.',
          column,
        );
      }
    }
    post.variants.push(variant);
  }
  const identityPlan = planSignalPostIdentities(
    posts.map((p) => ({
      row: p.row,
      postKey: p.key,
      text: p.text,
      date: p.date,
      postImportSource: p.postImportSource,
      postImportId: p.postImportId,
    })),
    readSignalPostIdentityWorkspace(db),
  );
  for (const found of identityPlan.issues) issue(issues, 'SignalPosts', found.row, found.message);
  const created: SignalImportCreation[] = [],
    updated: SignalImportCreation[] = [],
    skipped: SignalImportSkip[] = [];
  for (const post of posts) {
    const match = identityPlan.matches.get(post.key);
    if (!match) continue;
    if (match.kind === 'create')
      created.push({ sheet: 'SignalPosts', row: post.row, key: post.key, label: post.text });
    else if (match.kind === 'fallback')
      skipped.push({
        sheet: 'SignalPosts',
        row: post.row,
        key: post.key,
        label: post.text,
        existingId: match.postId,
        reason: 'Matched by weak fallback (date plus trimmed copy); no identity was supplied.',
      });
    else {
      updated.push({ sheet: 'SignalPosts', row: post.row, key: post.key, label: post.text });
    }
  }
  return {
    schemaVersion,
    posts,
    matches: identityPlan.matches,
    aliases: identityPlan.aliases,
    created,
    updated,
    skipped,
    issues,
  };
}

const counts = (
  plan: Plan,
): {
  creates: SignalImportCounts;
  updates: SignalImportCounts;
  skips: SignalImportCounts;
  failures: SignalImportCounts;
} => {
  const creates = emptySignalImportCounts(),
    updates = emptySignalImportCounts(),
    skips = emptySignalImportCounts(),
    failures = emptySignalImportCounts();
  creates.SignalPosts = plan.created.length;
  updates.SignalPosts = plan.updated.length;
  skips.SignalPosts = plan.skipped.length;
  for (const post of plan.posts) {
    const match = plan.matches.get(post.key);
    const target =
      match?.kind === 'fallback' ? skips : match && match.kind !== 'create' ? updates : creates;
    target.SignalMedia += post.media.length;
    target.SignalVariants += post.variants.length;
  }
  return { creates, updates, skips, failures };
};

export function toSignalImportPreview(
  plan: Plan,
  fingerprint: string,
  connected: ReturnType<typeof connectedPublishTargetsFromDb> = [],
): SignalImportPreview {
  const c = counts(plan);
  const failed = new Set(
    plan.issues.filter((x) => x.row !== undefined).map((x) => `${x.sheet}:${x.row}`),
  );
  for (const key of failed) {
    const sheet = key.split(':')[0] as keyof SignalImportCounts;
    if (sheet in c.failures) c.failures[sheet]++;
  }
  const resolvedMedia = resolvedMediaFromPlan(plan);
  const driveNamed = resolvedMedia.filter((m) => m.source === 'DRIVE').length;
  const driveResolved = resolvedMedia.filter((m) => m.source === 'DRIVE' && m.resolved).length;
  // Capability findings run even when the workbook has validation errors, so a person sees both
  // kinds of problem in one preview. They never flip `ok`.
  const capability = evaluateImportCapabilities(plan.posts, connected);
  return {
    schemaVersion: plan.schemaVersion,
    ok: plan.issues.length === 0,
    ...c,
    created: plan.created,
    updated: plan.updated,
    skipped: plan.skipped,
    issues: plan.issues,
    resolvedMedia,
    driveNamed,
    driveResolved,
    capabilitySummary: capability.summary,
    capabilityVerdicts: capability.verdicts,
    duplicateRule: SIGNAL_IMPORT_DUPLICATE_RULE,
    fingerprint,
  };
}

export async function previewSignalImport(
  db: Db,
  input: { filename?: string; contentBase64?: string; text?: string },
  provider: DriveMediaProvider = driveMediaProvider(db),
) {
  const parsed = parseInput(input);
  const plan = await buildPlan(parsed, db, provider);
  previewPlans.set(parsed.fingerprint, plan);
  return toSignalImportPreview(plan, parsed.fingerprint, connectedPublishTargetsFromDb(db));
}

function writeReceipt(
  db: Db,
  parsed: Parsed,
  outcome: SignalImportOutcome,
  preview: SignalImportPreview,
  error?: string,
): SignalImportReceipt {
  const receipt: SignalImportReceipt = {
    id: id(),
    source: SIGNAL_IMPORT_SOURCE_NAME,
    inputKind: parsed.kind,
    ...(parsed.filename ? { filename: parsed.filename } : {}),
    outcome,
    createdCount: signalImportTotal(preview.creates),
    updatedCount: signalImportTotal(preview.updates),
    skippedCount: signalImportTotal(preview.skips),
    failedCount: signalImportTotal(preview.failures),
    creates: preview.creates,
    updates: preview.updates,
    skips: preview.skips,
    created: preview.created,
    updated: preview.updated,
    skipped: preview.skipped,
    issues: preview.issues,
    capabilitySummary: preview.capabilitySummary,
    capabilityVerdicts: preview.capabilityVerdicts,
    ...(error ? { error } : {}),
    createdAt: now(),
  };
  transaction(db, () => {
    db.prepare(
      `INSERT INTO import_receipts(id,source,input_kind,filename,fingerprint,outcome,created_count,skipped_count,failed_count,detail,error,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      receipt.id,
      receipt.source,
      receipt.inputKind,
      receipt.filename ?? null,
      parsed.fingerprint,
      receipt.outcome,
      receipt.createdCount,
      receipt.skippedCount,
      receipt.failedCount,
      JSON.stringify({
        creates: receipt.creates,
        updates: receipt.updates,
        skips: receipt.skips,
        created: receipt.created,
        updated: receipt.updated,
        skipped: receipt.skipped,
        issues: receipt.issues,
        capabilitySummary: receipt.capabilitySummary,
        capabilityVerdicts: receipt.capabilityVerdicts,
      }),
      receipt.error ?? null,
      receipt.createdAt,
    );
    db.prepare(
      `DELETE FROM import_receipts WHERE id NOT IN (SELECT id FROM import_receipts ORDER BY created_at DESC,id DESC LIMIT ?)`,
    ).run(SIGNAL_IMPORT_RECEIPT_LIMIT);
    recordIntegrationEvent(db, {
      source: 'signal-import',
      operation: 'signal.import',
      outcome: outcome === 'COMMITTED' ? 'SUCCESS' : 'FAILURE',
      summary: `${outcome === 'COMMITTED' ? 'Imported' : 'Refused'} Signal workbook: ${receipt.createdCount} created, ${receipt.updatedCount} updated, ${receipt.skippedCount} skipped.`,
      correlationId: receipt.id,
      entities: receipt.created.map((x) => ({ type: 'signalPost', id: x.key, label: x.label })),
    });
  });
  return receipt;
}

function applyPlan(db: Db, plan: Plan) {
  const stamp = now();
  const created: SignalImportCreation[] = [];
  let queue =
    Number(
      (
        db
          .prepare('SELECT COALESCE(MAX(position),-1) AS max FROM signal_posts WHERE date IS NULL')
          .get() as { max: number }
      ).max,
    ) + 1;
  const ids = new Map<string, string>();
  const insertPost = db.prepare(
    `INSERT INTO signal_posts(id,text,date,time,format,status,cta,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
  );
  const writeMedia = db.prepare(
    `INSERT INTO signal_post_media(post_id,position,url,source,drive_file_id,drive_name,mime_type,size_bytes,drive_version,drive_modified_at,drive_checksum,drive_verified_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const post of plan.posts) {
    const match = plan.matches.get(post.key);
    // A fallback is intentionally a report-only match. A weak key is enough to prevent a
    // duplicate, but never enough to overwrite content authored in the app.
    if (match?.kind === 'fallback') continue;
    const postId = match && match.kind !== 'create' ? match.postId : id();
    ids.set(post.key, postId);
    const existing =
      match && match.kind !== 'create'
        ? (db.prepare('SELECT position FROM signal_posts WHERE id=?').get(postId) as
            { position: number } | undefined)
        : undefined;
    const position =
      match && match.kind !== 'create'
        ? (existing?.position ?? 0)
        : post.date === null
          ? queue++
          : 0;
    if (match?.kind === 'create' || !match)
      insertPost.run(
        postId,
        post.text,
        post.date,
        post.time,
        post.format,
        post.status,
        post.cta,
        position,
        stamp,
        stamp,
      );
    else
      db.prepare(
        'UPDATE signal_posts SET text=?,date=?,time=?,format=?,status=?,cta=?,position=?,updated_at=? WHERE id=?',
      ).run(
        post.text,
        post.date,
        post.time,
        post.format,
        post.status,
        post.cta,
        position,
        stamp,
        postId,
      );
    db.prepare('DELETE FROM signal_post_channels WHERE post_id=?').run(postId);
    for (const channel of post.channels)
      db.prepare('INSERT INTO signal_post_channels(post_id,channel) VALUES(?,?)').run(
        postId,
        channel,
      );
    db.prepare('DELETE FROM signal_post_media WHERE post_id=?').run(postId);
    post.media.forEach((m, i) => {
      const x = m.media!;
      writeMedia.run(
        postId,
        i,
        x.url,
        x.source,
        x.driveFileId,
        x.driveName,
        x.mimeType,
        x.sizeBytes,
        x.driveVersion,
        x.driveModifiedAt,
        x.driveChecksum,
        x.driveVerifiedAt,
      );
    });
    writePostCampaigns(db, postId, post.campaigns);
    if (match?.kind === 'create')
      created.push({ sheet: 'SignalPosts', row: post.row, key: post.key, label: post.text });
    if (post.variants.length) {
      db.prepare('DELETE FROM signal_post_variants WHERE post_id=?').run(postId);
      db.prepare('DELETE FROM signal_post_variant_media WHERE post_id=?').run(postId);
      const vi = db.prepare(
        `INSERT INTO signal_post_variants(post_id,platform,account_id,caption,media_urls,post_kind,title,first_comment,disclose_synthetic_media,cover_image_url,thumbnail_url,updated_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
      );
      const ri = db.prepare(
        `INSERT INTO signal_post_variant_media(post_id,platform,account_id,role,url,source,drive_file_id,drive_name,mime_type,size_bytes,drive_version,drive_modified_at,drive_checksum,drive_verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const v of post.variants) {
        const t = v.text;
        vi.run(
          postId,
          v.platform,
          v.accountId,
          t.caption ?? null,
          t.mediaUrls === undefined ? null : JSON.stringify(t.mediaUrls),
          t.postKind ?? null,
          t.title ?? null,
          t.firstComment ?? null,
          t.discloseSyntheticMedia === undefined ? null : t.discloseSyntheticMedia ? 1 : 0,
          stamp,
        );
        for (const role of PUBLISH_VARIANT_MEDIA_ROLES) {
          const x = v.roles[role];
          if (x)
            ri.run(
              postId,
              v.platform,
              v.accountId,
              role,
              x.url,
              x.source,
              x.driveFileId,
              x.driveName,
              x.mimeType,
              x.sizeBytes,
              x.driveVersion,
              x.driveModifiedAt,
              x.driveChecksum,
              x.driveVerifiedAt,
              stamp,
            );
        }
      }
    }
  }
  for (const alias of plan.aliases)
    recordSignalPostImportAlias(db, alias, ids.get(alias.postKey) ?? alias.postId!, stamp);
  return created;
}

export async function commitSignalImport(
  db: Db,
  input: { filename?: string; contentBase64?: string; text?: string; fingerprint?: string },
  provider: DriveMediaProvider = driveMediaProvider(db),
) {
  const parsed = parseInput(input);
  if (input.fingerprint && input.fingerprint !== parsed.fingerprint)
    throw new Error(
      'This Signal workbook changed since it was previewed. Review the new preview before importing.',
    );
  // A confirmed preview owns the resolved Drive descriptors. Reusing that immutable plan is what
  // keeps confirmation from silently rewriting a fingerprint the person never saw. Identity is
  // deliberately re-run against the current workspace below; Drive is re-resolved only to prove
  // the preview's fingerprints still match.
  let plan = input.fingerprint ? previewPlans.get(parsed.fingerprint) : undefined;
  if (input.fingerprint && !plan)
    throw new Error('This Signal import preview expired. Check the Signal import again.');
  if (!plan) plan = await buildPlan(parsed, db, provider);
  if (input.fingerprint && plan) {
    const stale = await assertPreviewDriveFingerprints(plan, provider);
    const currentPlan = plan;
    const identity = planSignalPostIdentities(
      currentPlan.posts.map((p) => ({
        row: p.row,
        postKey: p.key,
        text: p.text,
        date: p.date,
        postImportSource: p.postImportSource,
        postImportId: p.postImportId,
      })),
      readSignalPostIdentityWorkspace(db),
    );
    plan = {
      ...currentPlan,
      matches: identity.matches,
      aliases: identity.aliases,
      issues: [
        ...currentPlan.issues,
        ...stale,
        ...identity.issues.map((x) => ({ sheet: 'SignalPosts', row: x.row, message: x.message })),
      ],
    };
    plan = {
      ...plan,
      created: currentPlan.posts.flatMap((p) =>
        identity.matches.get(p.key)?.kind === 'create'
          ? [{ sheet: 'SignalPosts' as const, row: p.row, key: p.key, label: p.text }]
          : [],
      ),
      updated: currentPlan.posts.flatMap((p) => {
        const m = identity.matches.get(p.key);
        return m && m.kind !== 'create' && m.kind !== 'fallback'
          ? [{ sheet: 'SignalPosts' as const, row: p.row, key: p.key, label: p.text }]
          : [];
      }),
      skipped: currentPlan.posts.flatMap((p) => {
        const m = identity.matches.get(p.key);
        return m?.kind === 'fallback'
          ? [
              {
                sheet: 'SignalPosts' as const,
                row: p.row,
                key: p.key,
                label: p.text,
                existingId: m.postId,
                reason:
                  'Matched by weak fallback (date plus trimmed copy); no identity was supplied.',
              },
            ]
          : [];
      }),
    };
  }
  const preview = toSignalImportPreview(
    plan,
    parsed.fingerprint,
    connectedPublishTargetsFromDb(db),
  );
  if (plan.issues.length)
    return { preview, receipt: writeReceipt(db, parsed, 'REJECTED', preview) };
  try {
    const created = transaction(db, () => applyPlan(db, plan));
    const actual = { ...preview, created };
    return { preview, receipt: writeReceipt(db, parsed, 'COMMITTED', actual) };
  } catch (error) {
    writeReceipt(
      db,
      parsed,
      'FAILED',
      preview,
      error instanceof Error ? error.message : 'Import failed.',
    );
    throw error;
  }
}

interface ReceiptRow {
  id: string;
  source: string;
  input_kind: 'xlsx' | 'text';
  filename: string | null;
  outcome: SignalImportOutcome;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  detail: string;
  error: string | null;
  created_at: string;
}

function receiptFromRow(row: ReceiptRow): SignalImportReceipt {
  let detail: Partial<SignalImportReceipt> = {};
  try {
    detail = JSON.parse(row.detail) as Partial<SignalImportReceipt>;
  } catch {
    // Scalar receipt counts remain useful if an old detail payload is unreadable.
  }
  return {
    id: row.id,
    source: row.source,
    inputKind: row.input_kind,
    ...(row.filename ? { filename: row.filename } : {}),
    outcome: row.outcome,
    createdCount: row.created_count,
    updatedCount: signalImportTotal(detail.updates ?? emptySignalImportCounts()),
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    creates: detail.creates ?? emptySignalImportCounts(),
    updates: detail.updates ?? emptySignalImportCounts(),
    skips: detail.skips ?? emptySignalImportCounts(),
    created: detail.created ?? [],
    updated: detail.updated ?? [],
    skipped: detail.skipped ?? [],
    issues: detail.issues ?? [],
    capabilitySummary: detail.capabilitySummary ?? emptySignalImportCapabilitySummary(),
    capabilityVerdicts: detail.capabilityVerdicts ?? [],
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
}

export function listSignalImportReceipts(
  db: Db,
  limit = SIGNAL_IMPORT_RECEIPT_LIMIT,
): SignalImportReceipt[] {
  return (
    db
      .prepare(
        `SELECT id,source,input_kind,filename,outcome,created_count,
                skipped_count,failed_count,detail,error,created_at
           FROM import_receipts
          WHERE source=?
          ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(SIGNAL_IMPORT_SOURCE_NAME, limit) as unknown as ReceiptRow[]
  ).map(receiptFromRow);
}
