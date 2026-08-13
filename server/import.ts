/**
 * The campaign playbook import service: read the workspace, plan, write once, keep a receipt.
 *
 * The rules live in `server/domain/playbook.ts` and the file format in
 * `server/domain/workbook.ts`; what is here is everything that needs the database. Two
 * properties are the point of this module:
 *
 * - **The plan is never trusted from the browser.** A commit re-reads the file, re-reads the
 *   workspace, and re-plans, so the write is decided by the same code that produced the
 *   preview, against the workspace as it stands at the moment of the write.
 * - **One transaction.** Every client, project, task, checklist item, and dependency of an
 *   import lands together or not at all. The receipt is written outside that transaction, on
 *   purpose: a rolled-back import still has to leave the record that says so. The integration
 *   activity event is written with the receipt, inside one transaction of its own, so a receipt
 *   never exists without the audit row that names the records it left behind.
 *
 * No Drive call happens here. Imported clients and projects are stored `DISCONNECTED`, which
 * is what `POST /api/drive/sync` later provisions from, so importing a playbook never creates,
 * renames, or touches a folder as a side effect.
 */
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Db } from './db.ts';
import { transaction } from './db.ts';
import { touchProjectActivity } from './domain/activity.ts';
import { buildClientSlug } from './domain/client-slugs.ts';
import {
  buildPlan,
  planIsClean,
  toPreview,
  type KeyResolution,
  type PlaybookPlan,
  type WorkspaceClient,
  type WorkspaceProject,
  type WorkspaceSnapshot,
  type WorkspaceTask,
} from './domain/playbook.ts';
import {
  readTabbedWorkbook,
  readXlsxWorkbook,
  WorkbookError,
  type Workbook,
} from './domain/workbook.ts';
import { recordIntegrationEvent } from './integration-log.ts';
import {
  IMPORT_RECEIPT_LIMIT,
  PLAYBOOK_SOURCE,
  emptyCounts,
  totalCount,
  type ImportOutcome,
  type ImportReceipt,
  type PlaybookCounts,
  type PlaybookInputKind,
  type PlaybookPreview,
} from '../shared/playbook.ts';
import type { IntegrationEntity, IntegrationOutcome } from '../shared/integration-log.ts';
import { TASK_CHECKLIST_TEMPLATES } from '../shared/types.ts';

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/**
 * Where the versioned sample workbook lives on disk, so a first-time importer can reach it from
 * the Import page instead of from the repository.
 *
 * `docs/examples/` is the directory `docs/campaign-playbook-import-format.md` links its example
 * from, and the file is served from there rather than copied into `client/public/`. `AGENTS.md`
 * requires that document to change in the same branch as the importer; a duplicate binary would
 * not be in that branch and would drift the first time the format moved.
 *
 * Resolved from this module's own URL rather than from `process.cwd()`, which is whatever
 * directory `npm start` was run in. The server is never bundled — `node --experimental-strip-types
 * server/index.ts` in both dev and production — so `server/../docs` is the committed file in both.
 *
 * A directory rather than the whole path because it is what the route hands `sendFile` as its
 * `root`: `send` answers 404 for any path with a dot-segment in it, and a checkout under a
 * directory such as `.claude/worktrees` would otherwise make the download disappear with no error
 * worth reading. Rooted here, only the filename is matched against that rule, and it carries no
 * dot-segment.
 */
export const SAMPLE_PLAYBOOK_DIRECTORY = fileURLToPath(
  new URL('../docs/examples/', import.meta.url),
);
/** The `.xlsx` media type, stated here so the route never depends on a MIME lookup table. */
export const SAMPLE_PLAYBOOK_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** The longest `filename` a playbook may name itself with. */
export const PLAYBOOK_FILENAME_MAX = 255;
/** The longest base64 workbook this accepts — about 9 MB of `.xlsx` before encoding. */
export const PLAYBOOK_CONTENT_BASE64_MAX = 12_000_000;
/** The longest pasted playbook this accepts, in characters. */
export const PLAYBOOK_TEXT_MAX = 4_000_000;

/**
 * The JSON around the fields: two braces, three quoted keys, their colons and commas, and room
 * for the filename. Rounded up generously — it is a rounding error next to the payload, and the
 * point of deriving the limit is that it is never *below* what the schema accepts.
 */
const PLAYBOOK_ENVELOPE_MAX = PLAYBOOK_FILENAME_MAX + 256;

/**
 * The body limit for the import routes, derived from the field caps above rather than picked as a
 * round number. It was 16 MB, which was neither of those things.
 *
 * The binding case is the base64 workbook: base64 is ASCII, JSON escapes none of it, so the
 * longest body the schema can accept through that field is its cap plus the envelope. The pasted
 * form cannot reach this — its cap is a third as long, and even a playbook of nothing but tabs
 * and newlines doubles only those characters. A paste long enough to exceed this limit in bytes
 * while staying under 4,000,000 characters would have to average three bytes per character, which
 * is not a tab-separated table of names and dates.
 */
export const IMPORT_BODY_LIMIT_BYTES = PLAYBOOK_CONTENT_BASE64_MAX + PLAYBOOK_ENVELOPE_MAX;

/**
 * A playbook as it arrives: an uploaded workbook, base64 encoded because the file crosses a
 * JSON boundary, or the tab-separated text the modal's paste box collects. Exactly one.
 */
export const playbookInput = z
  .object({
    filename: z.string().trim().max(PLAYBOOK_FILENAME_MAX).optional(),
    /** Base64 of an .xlsx file. */
    contentBase64: z.string().max(PLAYBOOK_CONTENT_BASE64_MAX).optional(),
    /** The pasted form: `[Clients]` and friends, tab separated. */
    text: z.string().max(PLAYBOOK_TEXT_MAX).optional(),
  })
  .refine((value) => Boolean(value.contentBase64) !== Boolean(value.text), {
    message: 'Provide either a workbook file or pasted playbook text.',
  });
export type PlaybookInput = z.output<typeof playbookInput>;

/** A problem with the input itself, answered as a 400 rather than as an empty preview. */
export class ImportInputError extends Error {}

interface ParsedInput {
  workbook: Workbook;
  kind: PlaybookInputKind;
  filename?: string;
  /**
   * Digest of the bytes that were parsed. The commit sends back the fingerprint its preview
   * carried, which is what makes "the preview predicts the commit" checkable rather than
   * assumed: a different file cannot be confirmed against an earlier preview.
   */
  fingerprint: string;
}

function parseInput(input: PlaybookInput): ParsedInput {
  try {
    if (input.contentBase64) {
      const buffer = Buffer.from(input.contentBase64, 'base64');
      if (buffer.length === 0) throw new ImportInputError('That file is empty.');
      return {
        workbook: readXlsxWorkbook(buffer),
        kind: 'xlsx',
        ...(input.filename ? { filename: input.filename } : {}),
        fingerprint: crypto.createHash('sha256').update(buffer).digest('hex'),
      };
    }
    const text = input.text ?? '';
    return {
      workbook: readTabbedWorkbook(text),
      kind: 'text',
      ...(input.filename ? { filename: input.filename } : {}),
      // Line endings differ between the browsers and shells a paste can come from, and they
      // are not part of what the playbook says, so the digest is taken after normalizing them.
      fingerprint: crypto.createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex'),
    };
  } catch (error) {
    if (error instanceof WorkbookError) throw new ImportInputError(error.message);
    throw error;
  }
}

/**
 * The workspace the duplicate rule compares against, read in five statements. Archived
 * clients and projects are included: an archived record still counts as existing, and an
 * import neither revives nor rewrites one.
 */
export function readWorkspace(db: Db): WorkspaceSnapshot {
  const taskPosition: Record<string, number> = {};
  for (const row of db
    .prepare('SELECT status, MAX(position) high FROM tasks GROUP BY status')
    .all() as { status: string; high: number | null }[])
    taskPosition[row.status] = row.high ?? -1;
  const rows = <T>(sql: string) => db.prepare(sql).all() as unknown as T[];
  return {
    clients: rows<WorkspaceClient>('SELECT id, name FROM clients'),
    projects: rows<WorkspaceProject>('SELECT id, client_id clientId, name FROM projects'),
    tasks: rows<WorkspaceTask>(
      'SELECT id, project_id projectId, title, due_date dueDate FROM tasks',
    ),
    dependencies: rows<{ taskId: string; dependencyId: string }>(
      'SELECT task_id taskId, dependency_id dependencyId FROM task_dependencies',
    ),
    projectPosition: (
      db.prepare('SELECT COALESCE(MAX(position),-1) high FROM projects').get() as { high: number }
    ).high,
    taskPosition,
  };
}

/** The dry run. Reads nothing but the workspace and writes nothing at all. */
export function previewPlaybook(db: Db, input: PlaybookInput): PlaybookPreview {
  const parsed = parseInput(input);
  return toPreview(buildPlan(parsed.workbook, readWorkspace(db)), parsed.fingerprint);
}

export interface CommitResult {
  receipt: ImportReceipt;
  preview: PlaybookPreview;
}

/**
 * Writes a playbook, or explains why it will not. Re-plans first, so a workbook that became
 * importable — or stopped being importable — since the preview is judged as it is now.
 *
 * Returns a `REJECTED` receipt rather than throwing when the plan is not clean: the reasons
 * are the answer, and they are the same reasons the preview gave.
 */
export function commitPlaybook(
  db: Db,
  input: PlaybookInput & { fingerprint?: string },
): CommitResult {
  const parsed = parseInput(input);
  if (input.fingerprint && input.fingerprint !== parsed.fingerprint)
    throw new ImportInputError(
      'This playbook changed since it was previewed. Review the new preview before importing.',
    );
  const plan = buildPlan(parsed.workbook, readWorkspace(db));
  const preview = toPreview(plan, parsed.fingerprint);
  if (!planIsClean(plan))
    return {
      preview,
      receipt: writeReceipt(db, parsed, 'REJECTED', preview, emptyCounts(), []),
    };
  try {
    const applied = transaction(db, () => applyPlan(db, plan));
    return {
      preview,
      receipt: writeReceipt(db, parsed, 'COMMITTED', preview, applied.counts, applied.entities),
    };
  } catch (error) {
    // The transaction rolled back, so nothing this import would have created is in the
    // database. The receipt is written afterwards, outside it, or it would roll back too.
    const message = error instanceof Error ? error.message : 'Unexpected error';
    writeReceipt(db, parsed, 'FAILED', preview, emptyCounts(), [], message);
    throw error;
  }
}

/** What one committed plan wrote: the counts for the receipt, the ids for the activity log. */
interface AppliedPlan {
  counts: PlaybookCounts;
  /** Every client, project, and task the import created, in hierarchy order. */
  entities: IntegrationEntity[];
}

/**
 * Writes the plan. Called inside one transaction; every statement here is either committed
 * with the rest or discarded with the rest.
 *
 * Order follows the hierarchy, because a child needs its parent's id: clients, projects,
 * tasks, checklist items, dependencies. Keys the plan resolved to records that already exist
 * contribute no insert and are simply the id a child attaches to.
 */
function applyPlan(db: Db, plan: PlaybookPlan): AppliedPlan {
  const stamp = now();
  const counts = emptyCounts();
  /** The records this import created, named as the activity log records them. */
  const entities: IntegrationEntity[] = [];
  const clientIds = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const taskIds = new Map<string, string>();
  const resolve = (
    resolutions: Map<string, KeyResolution>,
    ids: Map<string, string>,
    key: string,
  ) => {
    const resolution = resolutions.get(key);
    if (resolution?.kind === 'existing') return resolution.id;
    const created = ids.get(key);
    if (!created) throw new Error(`The playbook referred to ${key}, which was never created.`);
    return created;
  };
  /** Projects whose activity this import moved, stamped once each at the end. */
  const touched = new Set<string>();

  const insertClient = db.prepare(
    `INSERT INTO clients(id,name,slug,contact_name,email,phone,website,notes,drive_status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,'DISCONNECTED',?,?)`,
  );
  for (const client of plan.clients) {
    const clientId = id();
    insertClient.run(
      clientId,
      client.name,
      buildClientSlug(client.name, clientId),
      client.contactName,
      client.email,
      client.phone,
      client.website,
      client.notes,
      stamp,
      stamp,
    );
    clientIds.set(client.key, clientId);
    entities.push({ type: 'client', id: clientId, label: client.name });
    counts.Clients++;
  }

  const insertProject = db.prepare(
    `INSERT INTO projects(id,client_id,name,description,status,start_date,target_deadline,priority,notes,position,drive_status,created_at,updated_at,last_activity_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,'DISCONNECTED',?,?,?)`,
  );
  for (const project of plan.projects) {
    const projectId = id();
    insertProject.run(
      projectId,
      resolve(plan.resolutions.clients, clientIds, project.clientKey),
      project.name,
      project.description,
      project.status,
      project.startDate,
      project.targetDeadline,
      project.priority,
      project.notes,
      project.position,
      stamp,
      stamp,
      stamp,
    );
    projectIds.set(project.key, projectId);
    entities.push({ type: 'project', id: projectId, label: project.name });
    counts.Projects++;
  }

  const insertTask = db.prepare(
    `INSERT INTO tasks(id,project_id,title,description,status,priority,task_type,due_date,start_date,notes,position,completed_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertChecklistItem = db.prepare(
    'INSERT INTO checklist_items(id,task_id,text,completed,position) VALUES(?,?,?,?,?)',
  );
  /** Tasks the workbook gave a checklist to; their type template must not seed a second one. */
  const authoredChecklists = new Set(plan.checklistItems.map((item) => item.taskKey));
  for (const task of plan.tasks) {
    const taskId = id();
    const projectId = resolve(plan.resolutions.projects, projectIds, task.projectKey);
    insertTask.run(
      taskId,
      projectId,
      task.title,
      task.description,
      task.status,
      task.priority,
      task.taskType,
      task.dueDate,
      task.startDate,
      task.notes,
      task.position,
      // A task imported as done is done as of the confirmation, which is the only moment this
      // import can honestly claim: the workbook carries no completion timestamp.
      task.status === 'COMPLETE' ? stamp : null,
      stamp,
      stamp,
    );
    taskIds.set(task.key, taskId);
    entities.push({ type: 'task', id: taskId, label: task.title });
    touched.add(projectId);
    counts.Tasks++;
    // The type's default checklist seeds only a task the workbook left without one, so an
    // authored checklist is never doubled by a template — the rule the format documents.
    const template = task.taskType ? TASK_CHECKLIST_TEMPLATES[task.taskType] : undefined;
    if (template && !authoredChecklists.has(task.key))
      template.forEach((text, position) =>
        insertChecklistItem.run(id(), taskId, text, 0, position),
      );
  }

  for (const item of plan.checklistItems) {
    insertChecklistItem.run(
      id(),
      resolve(plan.resolutions.tasks, taskIds, item.taskKey),
      item.text,
      Number(item.completed),
      item.position,
    );
    counts.ChecklistItems++;
  }

  const insertDependency = db.prepare(
    'INSERT OR IGNORE INTO task_dependencies(task_id,dependency_id) VALUES(?,?)',
  );
  for (const dependency of plan.dependencies) {
    const taskId = resolve(plan.resolutions.tasks, taskIds, dependency.taskKey);
    const result = insertDependency.run(
      taskId,
      resolve(plan.resolutions.tasks, taskIds, dependency.prerequisiteKey),
    );
    if (!result.changes) continue;
    counts.Dependencies++;
    // A dependency added to a task under a project the import did not otherwise write is
    // still work on that project, so its activity moves too.
    const owner = db.prepare('SELECT project_id FROM tasks WHERE id=?').get(taskId) as
      { project_id: string } | undefined;
    if (owner) touched.add(owner.project_id);
  }

  for (const projectId of touched) touchProjectActivity(db, projectId, stamp);
  return { counts, entities };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

interface ReceiptRow {
  id: string;
  source: string;
  input_kind: string;
  filename: string | null;
  fingerprint: string;
  outcome: string;
  created_count: number;
  skipped_count: number;
  failed_count: number;
  detail: string;
  error: string | null;
  created_at: string;
}

/**
 * Records what an import did — as a receipt, and as one row in the integration activity log.
 * Written outside the import transaction, so a failure that rolled the import back still
 * leaves the rows that explain it.
 *
 * `detail` holds the preview's own lists — what was created, what was skipped and why, and
 * every validation issue — as JSON, because a receipt is read as a whole and never queried
 * by its parts. It carries no credential, token, or file content: workbook rows describe
 * clients, projects, and tasks, which is what the workspace already stores in the clear.
 */
function writeReceipt(
  db: Db,
  parsed: ParsedInput,
  outcome: ImportOutcome,
  preview: PlaybookPreview,
  created: PlaybookCounts,
  /** The records the import created. Empty for anything but a committed import. */
  entities: readonly IntegrationEntity[],
  error?: string,
): ImportReceipt {
  const receipt: ImportReceipt = {
    id: id(),
    source: PLAYBOOK_SOURCE,
    inputKind: parsed.kind,
    ...(parsed.filename ? { filename: parsed.filename } : {}),
    outcome,
    createdCount: totalCount(created),
    skippedCount: totalCount(preview.skips),
    failedCount: totalCount(preview.failures),
    creates: created,
    skips: preview.skips,
    created: outcome === 'COMMITTED' ? preview.created : [],
    skipped: preview.skipped,
    issues: preview.issues,
    ...(error ? { error } : {}),
    createdAt: now(),
  };
  transaction(db, () => {
    db.prepare(
      `INSERT INTO import_receipts(id,source,input_kind,filename,fingerprint,outcome,created_count,skipped_count,failed_count,detail,error,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
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
        skips: receipt.skips,
        created: receipt.created,
        skipped: receipt.skipped,
        issues: receipt.issues,
      }),
      receipt.error ?? null,
      receipt.createdAt,
    );
    // Retention: the newest `IMPORT_RECEIPT_LIMIT` rows, so a workspace that imports every
    // week does not grow a table without a bound. Deleting the oldest is the whole policy.
    db.prepare(
      `DELETE FROM import_receipts WHERE id NOT IN (
         SELECT id FROM import_receipts ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
    ).run(IMPORT_RECEIPT_LIMIT);
    // Inside the same transaction as the receipt: an import that left a receipt always left
    // the audit row that names what it wrote, and the reverse.
    const why = eventError(receipt);
    recordIntegrationEvent(db, {
      source: PLAYBOOK_SOURCE,
      operation: 'playbook.import',
      outcome: EVENT_OUTCOME[outcome],
      summary: eventSummary(receipt),
      entities,
      correlationId: receipt.id,
      ...(why ? { error: why } : {}),
    });
  });
  return receipt;
}

/**
 * An import is one transaction, so it cannot end up `PARTIAL`: it committed, or the workspace
 * is exactly as it was. A refused playbook and a rolled-back write are both failures — nothing
 * landed either way — and what separates them is the event's own error text.
 */
const EVENT_OUTCOME: Record<ImportOutcome, IntegrationOutcome> = {
  COMMITTED: 'SUCCESS',
  REJECTED: 'FAILURE',
  FAILED: 'FAILURE',
};

/** The log's one-line answer to "what did that import do", in the receipt's own numbers. */
function eventSummary(receipt: ImportReceipt): string {
  const what =
    receipt.filename ?? (receipt.inputKind === 'text' ? 'a pasted playbook' : 'a workbook');
  if (receipt.outcome === 'COMMITTED')
    return `Imported ${receipt.createdCount} record${receipt.createdCount === 1 ? '' : 's'} from ${what}, skipping ${receipt.skippedCount} already here.`;
  if (receipt.outcome === 'REJECTED')
    return `Refused ${what}: ${receipt.failedCount} row${receipt.failedCount === 1 ? '' : 's'} failed validation, so nothing was written.`;
  return `Failed part way through ${what}; the import rolled back and nothing was written.`;
}

/**
 * Why it failed, in enough detail to act on without opening the receipt: the write's own error
 * for a rolled-back import, and the first validation issue for a refused one.
 */
function eventError(receipt: ImportReceipt): string | undefined {
  if (receipt.error) return receipt.error;
  if (receipt.outcome !== 'REJECTED') return undefined;
  const [first] = receipt.issues;
  if (!first) return 'The playbook was refused with no reason recorded.';
  const where = [first.sheet, first.row ? `row ${first.row}` : '', first.column ?? '']
    .filter(Boolean)
    .join(' · ');
  return `${receipt.failedCount} row${receipt.failedCount === 1 ? '' : 's'} failed validation. First: ${where} — ${first.message}`;
}

function toReceipt(row: ReceiptRow): ImportReceipt {
  const detail = safeDetail(row.detail);
  return {
    id: row.id,
    source: row.source,
    inputKind: row.input_kind === 'text' ? 'text' : 'xlsx',
    ...(row.filename ? { filename: row.filename } : {}),
    outcome: row.outcome as ImportOutcome,
    createdCount: row.created_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    creates: detail.creates ?? emptyCounts(),
    skips: detail.skips ?? emptyCounts(),
    created: detail.created ?? [],
    skipped: detail.skipped ?? [],
    issues: detail.issues ?? [],
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
  };
}

/** A receipt whose detail cannot be read is still a receipt: the counts are columns. */
function safeDetail(
  raw: string,
): Partial<Pick<ImportReceipt, 'creates' | 'skips' | 'created' | 'skipped' | 'issues'>> {
  try {
    return JSON.parse(raw) as Partial<ImportReceipt>;
  } catch {
    return {};
  }
}

export function listReceipts(db: Db, limit = IMPORT_RECEIPT_LIMIT): ImportReceipt[] {
  return (
    db
      .prepare('SELECT * FROM import_receipts ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as ReceiptRow[]
  ).map(toReceipt);
}

export function getReceipt(db: Db, receiptId: string): ImportReceipt | undefined {
  const row = db.prepare('SELECT * FROM import_receipts WHERE id=?').get(receiptId) as unknown as
    ReceiptRow | undefined;
  return row ? toReceipt(row) : undefined;
}
