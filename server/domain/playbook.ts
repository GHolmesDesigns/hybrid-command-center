/**
 * The campaign playbook format: what a workbook has to say, and what importing it would do.
 *
 * Framework-free and database-free on purpose. Everything here is a function of the cells
 * (`workbook.ts`) and a snapshot of the workspace, so every rule in
 * `docs/campaign-playbook-import-format.md` — required tabs, exact headers, workbook-local
 * keys, ordering scopes, dependency cycles, and the duplicate rule — is unit-testable without
 * a server, and the same plan can be built twice: once for the preview and once, against the
 * workspace as it stands at that moment, for the write.
 *
 * Nothing here writes. `server/import.ts` takes the plan and commits it in one transaction.
 */
import { z } from 'zod';
import { isValid, parseISO } from 'date-fns';
import {
  DUPLICATE_RULE,
  PLAYBOOK_DOC_SHEETS,
  PLAYBOOK_SCHEMA_VERSION,
  PLAYBOOK_SHEETS,
  SKIP_REASON,
  emptyCounts,
  type PlaybookCreation,
  type PlaybookIssue,
  type PlaybookPreview,
  type PlaybookSheet,
  type PlaybookSkip,
} from '../../shared/playbook.ts';
import {
  TASK_STATUSES,
  TASK_TYPES,
  type Priority,
  type TaskStatus,
  type TaskType,
} from '../../shared/types.ts';
import { columnLetter, findSheet, type Cell, type Workbook } from './workbook.ts';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const PROJECT_STATUSES = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETE'] as const;

/** Tabs that must be present. `ChecklistItems` and `Dependencies` absent means none of them. */
const REQUIRED_SHEETS = [
  'Clients',
  'Projects',
  'Tasks',
] as const satisfies readonly PlaybookSheet[];

const HEADERS = {
  Clients: ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
  Projects: [
    'project_key',
    'client_key',
    'name',
    'status',
    'priority',
    'start_date',
    'target_deadline',
    'description',
    'notes',
    'position',
  ],
  Tasks: [
    'task_key',
    'project_key',
    'title',
    'task_type',
    'status',
    'priority',
    'start_date',
    'due_date',
    'description',
    'notes',
    'position',
  ],
  ChecklistItems: ['task_key', 'item_order', 'title', 'completed'],
  Dependencies: ['task_key', 'prerequisite_task_key'],
} as const satisfies Record<PlaybookSheet, readonly string[]>;

/** Columns holding a calendar date, so an Excel date serial can be named as the mistake it is. */
const DATE_COLUMNS = new Set(['start_date', 'target_deadline', 'due_date']);
/** Columns holding a native boolean. */
const BOOLEAN_COLUMNS = new Set(['completed']);
/** Columns holding a workbook order value. */
const NUMBER_COLUMNS = new Set(['position', 'item_order']);

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

/** Optional text: an absent or blank cell is `null`, which is what the column stores. */
const optionalText = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || null);
const optionalEmail = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || null)
  .refine((value) => value === null || z.string().email().safeParse(value).success, {
    message: 'Expected an email address.',
  });
const optionalUrl = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || null)
  .refine((value) => value === null || z.string().url().safeParse(value).success, {
    message: 'Expected a full web address, starting with https://.',
  });
/**
 * A calendar date exactly as the app stores one: `YYYY-MM-DD`, interpreted in local time. The
 * pattern is checked before `isValid`, so `2026-02-30` is refused rather than shifted.
 */
const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || null)
  .refine((value) => value === null || /^\d{4}-\d{2}-\d{2}$/.test(value), {
    message: 'Expected a date written as YYYY-MM-DD.',
  })
  .refine((value) => value === null || isValid(parseISO(value)), {
    message: 'That is not a real calendar date.',
  });
/**
 * A workbook-local key: the identifier that connects rows inside one workbook and nothing
 * else. Case-sensitive and trimmed, so `TSK-001` and `tsk-001` are two different keys and a
 * reference to the wrong one is reported rather than guessed at.
 */
const workbookKey = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Z][A-Z0-9_-]*$/,
    'Keys start with a capital letter and use only capitals, digits, hyphens, and underscores.',
  );
/** A one-based workbook order value. Blank is allowed and lands after the numbered rows. */
const optionalOrder = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? Number(value) : null))
  .refine((value) => value === null || (Number.isInteger(value) && value > 0), {
    message: 'Expected a whole number of 1 or more.',
  });
const requiredOrder = z
  .string()
  .trim()
  .min(1, 'Required.')
  .transform((value) => Number(value))
  .refine((value) => Number.isInteger(value) && value > 0, {
    message: 'Expected a whole number of 1 or more.',
  });
const optionalBoolean = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value.toUpperCase() : 'FALSE'))
  .refine((value) => value === 'TRUE' || value === 'FALSE', {
    message: 'Expected TRUE or FALSE.',
  })
  .transform((value) => value === 'TRUE');
const enumWithDefault = <T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => value || fallback)
    .pipe(z.enum(values));
/** Task type is the one enum with no default: a task without a type is normal. */
const optionalTaskType = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || null)
  .refine((value) => value === null || (TASK_TYPES as readonly string[]).includes(value), {
    message: `Expected one of ${TASK_TYPES.join(', ')}.`,
  });

const ROW_SCHEMAS = {
  Clients: z.object({
    client_key: workbookKey,
    name: z.string().trim().min(2).max(120),
    contact_name: optionalText,
    email: optionalEmail,
    phone: optionalText,
    website: optionalUrl,
    notes: optionalText,
  }),
  Projects: z.object({
    project_key: workbookKey,
    client_key: workbookKey,
    name: z.string().trim().min(2).max(160),
    status: enumWithDefault(PROJECT_STATUSES, 'ACTIVE'),
    priority: enumWithDefault(PRIORITIES, 'MEDIUM'),
    start_date: optionalDate,
    target_deadline: optionalDate,
    description: optionalText,
    notes: optionalText,
    position: optionalOrder,
  }),
  Tasks: z.object({
    task_key: workbookKey,
    project_key: workbookKey,
    title: z.string().trim().min(2).max(200),
    task_type: optionalTaskType,
    status: enumWithDefault(TASK_STATUSES, 'BACKLOG'),
    priority: enumWithDefault(PRIORITIES, 'MEDIUM'),
    start_date: optionalDate,
    due_date: optionalDate,
    description: optionalText,
    notes: optionalText,
    position: optionalOrder,
  }),
  ChecklistItems: z.object({
    task_key: workbookKey,
    item_order: requiredOrder,
    title: z.string().trim().min(1).max(300),
    completed: optionalBoolean,
  }),
  Dependencies: z.object({
    task_key: workbookKey,
    prerequisite_task_key: workbookKey,
  }),
} satisfies Record<PlaybookSheet, z.ZodType>;

type ClientRow = z.output<(typeof ROW_SCHEMAS)['Clients']>;
type ProjectRow = z.output<(typeof ROW_SCHEMAS)['Projects']>;
type TaskRow = z.output<(typeof ROW_SCHEMAS)['Tasks']>;
type DependencyRow = z.output<(typeof ROW_SCHEMAS)['Dependencies']>;

// ---------------------------------------------------------------------------
// The workspace as the plan needs to see it
// ---------------------------------------------------------------------------

export interface WorkspaceClient {
  id: string;
  name: string;
}
export interface WorkspaceProject {
  id: string;
  clientId: string;
  name: string;
}
export interface WorkspaceTask {
  id: string;
  projectId: string;
  title: string;
  dueDate: string | null;
}
/**
 * Everything the duplicate rule and the ordering rule need to know about the workspace,
 * read once so a plan is a pure function of it. Archived clients and projects are included:
 * an archived record still counts as existing, and an import never revives one.
 */
export interface WorkspaceSnapshot {
  clients: WorkspaceClient[];
  projects: WorkspaceProject[];
  tasks: WorkspaceTask[];
  dependencies: { taskId: string; dependencyId: string }[];
  /** Highest `projects.position` in use, or -1 when there are no projects. */
  projectPosition: number;
  /** Highest `tasks.position` in use per status, matching how a new task is positioned. */
  taskPosition: Record<string, number>;
}

export const emptyWorkspace = (): WorkspaceSnapshot => ({
  clients: [],
  projects: [],
  tasks: [],
  dependencies: [],
  projectPosition: -1,
  taskPosition: {},
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlannedClient {
  row: number;
  key: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
}
export interface PlannedProject {
  row: number;
  key: string;
  clientKey: string;
  name: string;
  status: (typeof PROJECT_STATUSES)[number];
  priority: Priority;
  startDate: string | null;
  targetDeadline: string | null;
  description: string | null;
  notes: string | null;
  position: number;
}
export interface PlannedTask {
  row: number;
  key: string;
  projectKey: string;
  title: string;
  taskType: TaskType | null;
  status: TaskStatus;
  priority: Priority;
  startDate: string | null;
  dueDate: string | null;
  description: string | null;
  notes: string | null;
  position: number;
}
export interface PlannedChecklistItem {
  row: number;
  taskKey: string;
  text: string;
  completed: boolean;
  position: number;
}
export interface PlannedDependency {
  row: number;
  taskKey: string;
  prerequisiteKey: string;
}

/** Where a workbook key ended up: a record to create, or one the workspace already has. */
export type KeyResolution = { kind: 'create' } | { kind: 'existing'; id: string };

export interface PlaybookPlan {
  schemaVersion: number;
  clients: PlannedClient[];
  projects: PlannedProject[];
  tasks: PlannedTask[];
  checklistItems: PlannedChecklistItem[];
  dependencies: PlannedDependency[];
  /** Key to resolution, for every key that validated — creations and matches alike. */
  resolutions: {
    clients: Map<string, KeyResolution>;
    projects: Map<string, KeyResolution>;
    tasks: Map<string, KeyResolution>;
  };
  issues: PlaybookIssue[];
  created: PlaybookCreation[];
  skipped: PlaybookSkip[];
}

/** True when nothing stands between this plan and a write. Duplicates are not issues. */
export const planIsClean = (plan: PlaybookPlan) => plan.issues.length === 0;

// ---------------------------------------------------------------------------
// Reading rows
// ---------------------------------------------------------------------------

/** A number as a person wrote it: `1.0` from a spreadsheet is `1`, not `1.0`. */
const numberText = (value: string) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

interface SheetRows<S extends PlaybookSheet> {
  rows: { row: number; value: z.output<(typeof ROW_SCHEMAS)[S]> }[];
  /**
   * Key values from rows that did not validate, read straight from the cell. A child row
   * referring to one of these is told to fix the parent, rather than being told the key was
   * never defined — which would send the author looking for a row that is right there.
   */
  rejected: Set<string>;
}

/**
 * Reads one tab into validated rows. Cell types are checked first, because Zod only ever sees
 * text and could not tell a literal `2026-01-05` from the date serial a spreadsheet stores
 * when the author typed a date into an unformatted column.
 */
function readSheetRows<S extends PlaybookSheet>(
  workbook: Workbook,
  sheet: S,
  issues: PlaybookIssue[],
): SheetRows<S> {
  const found = findSheet(workbook, sheet);
  const headers = HEADERS[sheet] as readonly string[];
  const result: SheetRows<S> = { rows: [], rejected: new Set() };
  if (!found) {
    if ((REQUIRED_SHEETS as readonly string[]).includes(sheet))
      issues.push({
        sheet,
        message: `This tab is required. Add a ${sheet} tab with the documented columns.`,
      });
    return result;
  }
  if (found.hidden)
    issues.push({ sheet, message: 'This tab is hidden. Unhide it so its rows can be reviewed.' });
  for (const range of found.mergedRanges)
    issues.push({
      sheet,
      message: `Merged cells are not allowed on a data tab (${range}). Unmerge them and repeat the value on every row.`,
    });
  const [header, ...rows] = found.rows;
  if (!header) {
    issues.push({ sheet, message: 'This tab is empty. It needs at least its header row.' });
    return result;
  }
  // Headers are matched by name rather than by position, so a reordered but correctly spelled
  // tab still imports. Spelling and case are exact: a silently ignored `Name` column would
  // drop data the author believes they supplied.
  const columnAt = new Map<string, number>();
  let headerFailed = false;
  const headerIssue = (message: string, index?: number) => {
    headerFailed = true;
    issues.push({
      sheet,
      row: header.number,
      ...(index === undefined ? {} : { column: columnLetter(index) }),
      message,
    });
  };
  header.cells.forEach((cell, index) => {
    if (!cell) return;
    const name = cell.value.trim();
    if (columnAt.has(name)) headerIssue(`The ${name} column appears twice.`, index);
    else columnAt.set(name, index);
  });
  for (const name of headers)
    if (!columnAt.has(name)) headerIssue(`The ${name} column is missing.`);
  for (const [name, index] of columnAt)
    if (!headers.includes(name))
      headerIssue(`${name} is not a column of this tab. Remove it or correct its spelling.`, index);
  // Without trustworthy headers, every row error below would be addressed to the wrong column.
  if (headerFailed) return result;

  // The map is keyed by tab, so `ROW_SCHEMAS[sheet]` is the union of all five schemas and
  // TypeScript cannot narrow it from `S` alone. The call sites are what keep tab and row type
  // together, and every one of them names a literal tab.
  const schema = ROW_SCHEMAS[sheet] as unknown as z.ZodType<z.output<(typeof ROW_SCHEMAS)[S]>>;
  for (const row of rows) {
    const before = issues.length;
    const values: Record<string, string | undefined> = {};
    if (row.hidden)
      issues.push({
        sheet,
        row: row.number,
        message: 'This row is hidden. Unhide it, or delete it if it is not meant to be imported.',
      });
    for (const name of headers) {
      const index = columnAt.get(name)!;
      const value = readCell(sheet, row.number, name, index, row.cells[index], issues);
      if (value !== undefined) values[name] = value;
    }
    const parsed = schema.safeParse(values);
    if (parsed.success) {
      if (issues.length === before) result.rows.push({ row: row.number, value: parsed.data });
      else rejectKey();
      continue;
    }
    rejectKey();
    for (const issue of parsed.error.issues) {
      const column = String(issue.path[0] ?? '');
      const index = columnAt.get(column);
      issues.push({
        sheet,
        row: row.number,
        ...(index === undefined ? {} : { column: columnLetter(index) }),
        message: `${column || 'This row'}: ${describe(issue)}`,
      });
    }

    /** The key this row was going to define, however badly it was written. */
    function rejectKey() {
      const key = row.cells[columnAt.get(headers[0])!]?.value.trim();
      if (key) result.rejected.add(key);
    }
  }
  return result;
}

/** The cell as text, or `undefined` for a blank one, reporting anything the format refuses. */
function readCell(
  sheet: string,
  row: number,
  column: string,
  index: number,
  cell: Cell | undefined,
  issues: PlaybookIssue[],
) {
  if (!cell) return undefined;
  const at = { sheet, row, column: columnLetter(index) };
  if (cell.formula) {
    issues.push({
      ...at,
      message: `${column}: formulas are not allowed. Replace it with the value it produces.`,
    });
    return undefined;
  }
  if (cell.kind === 'error') {
    issues.push({ ...at, message: `${column}: this cell holds the error ${cell.value}.` });
    return undefined;
  }
  if (DATE_COLUMNS.has(column) && cell.kind === 'number') {
    issues.push({
      ...at,
      message: cell.dateFormatted
        ? `${column}: this is a spreadsheet date value. Format the column as plain text and type the date as YYYY-MM-DD.`
        : `${column}: expected a date written as YYYY-MM-DD.`,
    });
    return undefined;
  }
  if (BOOLEAN_COLUMNS.has(column) && cell.kind === 'number') {
    issues.push({ ...at, message: `${column}: expected TRUE or FALSE rather than a number.` });
    return undefined;
  }
  if (cell.kind === 'number') return numberText(cell.value);
  if (cell.kind === 'boolean' && !BOOLEAN_COLUMNS.has(column)) {
    issues.push({ ...at, message: `${column}: expected text rather than TRUE or FALSE.` });
    return undefined;
  }
  if (NUMBER_COLUMNS.has(column) && cell.kind === 'text' && !/^\d+$/.test(cell.value.trim())) {
    issues.push({ ...at, message: `${column}: expected a whole number of 1 or more.` });
    return undefined;
  }
  return cell.value;
}

/** Zod's message, with the generic ones rewritten to say what the format expects. */
function describe(issue: z.core.$ZodIssue) {
  if (issue.code === 'invalid_type' && issue.input === undefined) return 'required.';
  if (issue.code === 'too_small') return `needs at least ${issue.minimum} characters.`;
  if (issue.code === 'too_big') return `is limited to ${issue.maximum} characters.`;
  if (issue.code === 'invalid_value') return `expected one of ${issue.values.join(', ')}.`;
  return issue.message.charAt(0).toLowerCase() + issue.message.slice(1);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Puts rows in the order the workbook asked for and reports a scope that names one position
 * twice. Rows with no position follow the numbered ones in the order they were written, which
 * is what "default is the next position" means for a tab that only numbers some of its rows.
 */
function ordered<T>(
  entries: { row: number; value: T }[],
  options: {
    sheet: PlaybookSheet;
    column: string;
    positionOf: (value: T) => number | null;
    /** Rows sharing a scope may not share a position. */
    scopeOf: (value: T) => string;
    /** How the scope reads in the message, e.g. ` for PRJ-6WOC in TODO`. */
    scopeLabel: (value: T) => string;
  },
  issues: PlaybookIssue[],
) {
  const { sheet, column, positionOf, scopeOf, scopeLabel } = options;
  const seen = new Map<string, Map<number, number>>();
  for (const entry of entries) {
    const position = positionOf(entry.value);
    if (position === null) continue;
    const scope = scopeOf(entry.value);
    const used = seen.get(scope) ?? new Map<number, number>();
    const first = used.get(position);
    if (first !== undefined)
      issues.push({
        sheet,
        row: entry.row,
        message: `${column} ${position} is already used by row ${first}${scopeLabel(entry.value)}.`,
      });
    else used.set(position, entry.row);
    seen.set(scope, used);
  }
  const last = Number.MAX_SAFE_INTEGER;
  return entries
    .slice()
    .sort((a, b) => (positionOf(a.value) ?? last) - (positionOf(b.value) ?? last) || a.row - b.row);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Reads the declared schema version off a documentation tab, defaulting to the current one. */
function readSchemaVersion(workbook: Workbook, issues: PlaybookIssue[]) {
  for (const name of PLAYBOOK_DOC_SHEETS) {
    const sheet = findSheet(workbook, name);
    if (!sheet) continue;
    for (const row of sheet.rows) {
      const label = row.cells[0]?.value.trim().toLowerCase();
      if (label !== 'schema version' && label !== 'schema_version') continue;
      const declared = Number(row.cells[1]?.value ?? '');
      if (!Number.isFinite(declared) || declared !== PLAYBOOK_SCHEMA_VERSION) {
        issues.push({
          sheet: name,
          row: row.number,
          message: `This workbook declares schema version ${row.cells[1]?.value || 'nothing'}. This build imports version ${PLAYBOOK_SCHEMA_VERSION}.`,
        });
        return Number.isFinite(declared) ? declared : 0;
      }
      return declared;
    }
  }
  return PLAYBOOK_SCHEMA_VERSION;
}

/**
 * Turns a workbook plus the current workspace into everything a commit needs and everything a
 * preview shows. Collects every issue rather than stopping at the first, because an author
 * fixing a workbook wants the whole list.
 */
export function buildPlan(workbook: Workbook, workspace: WorkspaceSnapshot): PlaybookPlan {
  const issues: PlaybookIssue[] = [];
  const created: PlaybookCreation[] = [];
  const skipped: PlaybookSkip[] = [];
  const schemaVersion = readSchemaVersion(workbook, issues);

  const known = new Set<string>([...PLAYBOOK_SHEETS, ...PLAYBOOK_DOC_SHEETS]);
  for (const sheet of workbook.sheets)
    if (!known.has(sheet.name))
      issues.push({
        sheet: sheet.name,
        message: `This tab is not part of the format. Rename it to one of ${PLAYBOOK_SHEETS.join(', ')} or remove it.`,
      });

  const clientRows = readSheetRows(workbook, 'Clients', issues);
  const projectRows = readSheetRows(workbook, 'Projects', issues);
  const taskRows = readSheetRows(workbook, 'Tasks', issues);
  const checklistRows = readSheetRows(workbook, 'ChecklistItems', issues);
  const dependencyRows = readSheetRows(workbook, 'Dependencies', issues);
  if (
    clientRows.rows.length + projectRows.rows.length + taskRows.rows.length === 0 &&
    issues.length === 0
  )
    issues.push({
      sheet: 'Clients',
      message:
        'This playbook has no rows to import. Fill in the Clients, Projects, and Tasks tabs.',
    });
  /**
   * Keys the workbook names but cannot import, either because the row defining them failed or
   * because their own parent did. A child of one of these is told to fix the parent: a cascade
   * that said "not defined" would send the author hunting for a row that is already there.
   */
  const unresolved = {
    clients: new Set(clientRows.rejected),
    projects: new Set(projectRows.rejected),
    tasks: new Set(taskRows.rejected),
  };
  /** The message for a reference that resolved to nothing, in the two ways that can happen. */
  const missing = (column: string, key: string, tab: PlaybookSheet, rejected: Set<string>) =>
    rejected.has(key)
      ? `${column} ${key} is on the ${tab} tab, but that row cannot be imported. Fixing it fixes this row too.`
      : `${column} ${key} is not defined on the ${tab} tab.`;

  const plan: PlaybookPlan = {
    schemaVersion,
    clients: [],
    projects: [],
    tasks: [],
    checklistItems: [],
    dependencies: [],
    resolutions: { clients: new Map(), projects: new Map(), tasks: new Map() },
    issues,
    created,
    skipped,
  };

  // --- Clients -------------------------------------------------------------
  const clientKeys = new Map<string, ClientRow>();
  for (const { row, value } of clientRows.rows) {
    if (clientKeys.has(value.client_key)) {
      issues.push({
        sheet: 'Clients',
        row,
        column: 'A',
        message: `client_key ${value.client_key} is already defined on another row.`,
      });
      continue;
    }
    clientKeys.set(value.client_key, value);
    const twin = [...clientKeys.entries()].find(
      ([key, other]) => key !== value.client_key && sameName(other.name, value.name),
    );
    if (twin) {
      issues.push({
        sheet: 'Clients',
        row,
        message: `Two rows describe a client called “${value.name}”. Give one of them a different name.`,
      });
      unresolved.clients.add(value.client_key);
      continue;
    }
    const existing = workspace.clients.find((client) => sameName(client.name, value.name));
    if (existing) {
      plan.resolutions.clients.set(value.client_key, { kind: 'existing', id: existing.id });
      skipped.push({
        sheet: 'Clients',
        row,
        key: value.client_key,
        label: value.name,
        reason: SKIP_REASON.client,
        existingId: existing.id,
      });
      continue;
    }
    plan.resolutions.clients.set(value.client_key, { kind: 'create' });
    plan.clients.push({
      row,
      key: value.client_key,
      name: value.name,
      contactName: value.contact_name,
      email: value.email,
      phone: value.phone,
      website: value.website,
      notes: value.notes,
    });
    created.push({ sheet: 'Clients', row, key: value.client_key, label: value.name });
  }

  // --- Projects ------------------------------------------------------------
  const projectKeys = new Map<string, ProjectRow>();
  // Project order is workbook-wide, and imported tiles land after the ones already there —
  // the same place `POST /api/projects` puts a new project.
  const projectOrder = ordered(
    projectRows.rows,
    {
      sheet: 'Projects',
      column: 'position',
      positionOf: (value) => value.position,
      scopeOf: () => 'workbook',
      scopeLabel: () => '',
    },
    issues,
  );
  let projectPosition = workspace.projectPosition + 1;
  for (const { row, value } of projectOrder) {
    if (projectKeys.has(value.project_key)) {
      issues.push({
        sheet: 'Projects',
        row,
        column: 'A',
        message: `project_key ${value.project_key} is already defined on another row.`,
      });
      continue;
    }
    const client = plan.resolutions.clients.get(value.client_key);
    if (!client) {
      issues.push({
        sheet: 'Projects',
        row,
        column: 'B',
        message: missing('client_key', value.client_key, 'Clients', unresolved.clients),
      });
      // Its own key cannot be imported either, so its tasks are told about this row rather
      // than told their project is undefined.
      unresolved.projects.add(value.project_key);
      continue;
    }
    projectKeys.set(value.project_key, value);
    const twin = [...projectKeys.entries()].find(
      ([key, other]) =>
        key !== value.project_key &&
        other.client_key === value.client_key &&
        sameName(other.name, value.name),
    );
    if (twin) {
      issues.push({
        sheet: 'Projects',
        row,
        message: `Two rows describe a project called “${value.name}” for ${value.client_key}. Give one of them a different name.`,
      });
      unresolved.projects.add(value.project_key);
      continue;
    }
    if (value.start_date && value.target_deadline && value.target_deadline < value.start_date)
      issues.push({
        sheet: 'Projects',
        row,
        column: 'G',
        message: 'target_deadline: cannot fall before start_date.',
      });
    const existing =
      client.kind === 'existing'
        ? workspace.projects.find(
            (project) => project.clientId === client.id && sameName(project.name, value.name),
          )
        : undefined;
    if (existing) {
      plan.resolutions.projects.set(value.project_key, { kind: 'existing', id: existing.id });
      skipped.push({
        sheet: 'Projects',
        row,
        key: value.project_key,
        label: value.name,
        reason: SKIP_REASON.project,
        existingId: existing.id,
      });
      continue;
    }
    plan.resolutions.projects.set(value.project_key, { kind: 'create' });
    plan.projects.push({
      row,
      key: value.project_key,
      clientKey: value.client_key,
      name: value.name,
      status: value.status,
      priority: value.priority,
      startDate: value.start_date,
      targetDeadline: value.target_deadline,
      description: value.description,
      notes: value.notes,
      position: projectPosition++,
    });
    created.push({ sheet: 'Projects', row, key: value.project_key, label: value.name });
  }

  // --- Tasks ---------------------------------------------------------------
  const taskKeys = new Map<string, TaskRow>();
  // A task's workbook position is unique within its project and status; the stored position
  // continues each status column from where the board already ends, so imported work lands at
  // the bottom of its column in workbook order rather than interleaved with what is there.
  const taskOrder = ordered(
    taskRows.rows,
    {
      sheet: 'Tasks',
      column: 'position',
      positionOf: (value) => value.position,
      scopeOf: (value) => `${value.project_key} ${value.status}`,
      scopeLabel: (value) => ` for ${value.project_key} in ${value.status}`,
    },
    issues,
  );
  const taskPosition = { ...workspace.taskPosition };
  const nextTaskPosition = (status: string) => {
    const next = (taskPosition[status] ?? -1) + 1;
    taskPosition[status] = next;
    return next;
  };
  for (const { row, value } of taskOrder) {
    if (taskKeys.has(value.task_key)) {
      issues.push({
        sheet: 'Tasks',
        row,
        column: 'A',
        message: `task_key ${value.task_key} is already defined on another row.`,
      });
      continue;
    }
    const project = plan.resolutions.projects.get(value.project_key);
    if (!project) {
      issues.push({
        sheet: 'Tasks',
        row,
        column: 'B',
        message: missing('project_key', value.project_key, 'Projects', unresolved.projects),
      });
      unresolved.tasks.add(value.task_key);
      continue;
    }
    taskKeys.set(value.task_key, value);
    const twin = [...taskKeys.entries()].find(
      ([key, other]) =>
        key !== value.task_key &&
        other.project_key === value.project_key &&
        sameName(other.title, value.title) &&
        other.due_date === value.due_date,
    );
    if (twin) {
      issues.push({
        sheet: 'Tasks',
        row,
        message: `Two rows describe a task called “${value.title}” with the same due date for ${value.project_key}. Change one of them.`,
      });
      unresolved.tasks.add(value.task_key);
      continue;
    }
    if (value.start_date && value.due_date && value.due_date < value.start_date)
      issues.push({
        sheet: 'Tasks',
        row,
        column: 'H',
        message: 'due_date: cannot fall before start_date.',
      });
    const existing =
      project.kind === 'existing'
        ? workspace.tasks.find(
            (task) =>
              task.projectId === project.id &&
              sameName(task.title, value.title) &&
              (task.dueDate ?? null) === value.due_date,
          )
        : undefined;
    if (existing) {
      plan.resolutions.tasks.set(value.task_key, { kind: 'existing', id: existing.id });
      skipped.push({
        sheet: 'Tasks',
        row,
        key: value.task_key,
        label: value.title,
        reason: SKIP_REASON.task,
        existingId: existing.id,
      });
      continue;
    }
    plan.resolutions.tasks.set(value.task_key, { kind: 'create' });
    plan.tasks.push({
      row,
      key: value.task_key,
      projectKey: value.project_key,
      title: value.title,
      taskType: value.task_type as TaskType | null,
      status: value.status,
      priority: value.priority,
      startDate: value.start_date,
      dueDate: value.due_date,
      description: value.description,
      notes: value.notes,
      position: nextTaskPosition(value.status),
    });
    created.push({ sheet: 'Tasks', row, key: value.task_key, label: value.title });
  }

  // --- Checklist items ----------------------------------------------------
  const checklistOrder = ordered(
    checklistRows.rows,
    {
      sheet: 'ChecklistItems',
      column: 'item_order',
      positionOf: (value) => value.item_order,
      scopeOf: (value) => value.task_key,
      scopeLabel: (value) => ` for ${value.task_key}`,
    },
    issues,
  );
  const checklistPosition = new Map<string, number>();
  for (const { row, value } of checklistOrder) {
    const task = plan.resolutions.tasks.get(value.task_key);
    if (!task) {
      issues.push({
        sheet: 'ChecklistItems',
        row,
        column: 'A',
        message: missing('task_key', value.task_key, 'Tasks', unresolved.tasks),
      });
      continue;
    }
    if (task.kind === 'existing') {
      skipped.push({
        sheet: 'ChecklistItems',
        row,
        key: value.task_key,
        label: value.title,
        reason: SKIP_REASON.checklistItem,
        existingId: task.id,
      });
      continue;
    }
    const position = checklistPosition.get(value.task_key) ?? 0;
    checklistPosition.set(value.task_key, position + 1);
    plan.checklistItems.push({
      row,
      taskKey: value.task_key,
      text: value.title,
      completed: value.completed,
      position,
    });
    created.push({ sheet: 'ChecklistItems', row, key: value.task_key, label: value.title });
  }

  // --- Dependencies -------------------------------------------------------
  planDependencies(dependencyRows.rows, plan, workspace, unresolved.tasks, {
    issues,
    created,
    skipped,
  });

  return plan;
}

/**
 * Resolves each dependency row to two real tasks and refuses the graph the app already
 * refuses: no self-dependency, no repeated pair, no cycle. Existing edges are part of the
 * check, because a pair whose ends both already exist can close a loop through them.
 */
function planDependencies(
  rows: { row: number; value: DependencyRow }[],
  plan: PlaybookPlan,
  workspace: WorkspaceSnapshot,
  /** Task keys the workbook names but cannot import, so a reference to one says why. */
  unresolvedTasks: Set<string>,
  collected: {
    issues: PlaybookIssue[];
    created: PlaybookCreation[];
    skipped: PlaybookSkip[];
  },
) {
  const { issues, created, skipped } = collected;
  /** Edge list by dependent task, seeded with the workspace's own edges. */
  const edges = new Map<string, Set<string>>();
  const addEdge = (taskId: string, dependencyId: string) => {
    const set = edges.get(taskId) ?? new Set<string>();
    set.add(dependencyId);
    edges.set(taskId, set);
  };
  for (const edge of workspace.dependencies) addEdge(edge.taskId, edge.dependencyId);
  /** Ids for keys that are still being created; a placeholder is enough for the graph. */
  const idFor = (key: string) => {
    const resolution = plan.resolutions.tasks.get(key)!;
    return resolution.kind === 'existing' ? resolution.id : `new:${key}`;
  };
  const reaches = (from: string, target: string) => {
    const stack = [from];
    const visited = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of edges.get(current) ?? []) stack.push(next);
    }
    return false;
  };
  for (const { row, value } of rows) {
    const task = plan.resolutions.tasks.get(value.task_key);
    const prerequisite = plan.resolutions.tasks.get(value.prerequisite_task_key);
    if (!task || !prerequisite) {
      const key = task ? value.prerequisite_task_key : value.task_key;
      issues.push({
        sheet: 'Dependencies',
        row,
        column: task ? 'B' : 'A',
        message: unresolvedTasks.has(key)
          ? `task_key ${key} is on the Tasks tab, but that row cannot be imported. Fixing it fixes this row too.`
          : `task_key ${key} is not defined on the Tasks tab.`,
      });
      continue;
    }
    if (value.task_key === value.prerequisite_task_key) {
      issues.push({
        sheet: 'Dependencies',
        row,
        message: `${value.task_key} cannot depend on itself.`,
      });
      continue;
    }
    const taskId = idFor(value.task_key);
    const prerequisiteId = idFor(value.prerequisite_task_key);
    if (edges.get(taskId)?.has(prerequisiteId)) {
      skipped.push({
        sheet: 'Dependencies',
        row,
        key: value.task_key,
        label: `${value.task_key} depends on ${value.prerequisite_task_key}`,
        reason: SKIP_REASON.dependency,
        existingId: taskId.startsWith('new:') ? '' : taskId,
      });
      continue;
    }
    if (reaches(prerequisiteId, taskId)) {
      issues.push({
        sheet: 'Dependencies',
        row,
        message: `${value.task_key} depending on ${value.prerequisite_task_key} would create a circular relationship.`,
      });
      continue;
    }
    addEdge(taskId, prerequisiteId);
    plan.dependencies.push({
      row,
      taskKey: value.task_key,
      prerequisiteKey: value.prerequisite_task_key,
    });
    created.push({
      sheet: 'Dependencies',
      row,
      key: value.task_key,
      label: `${value.task_key} depends on ${value.prerequisite_task_key}`,
    });
  }
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

const countBySheet = (entries: { sheet: PlaybookSheet }[]) => {
  const counts = emptyCounts();
  for (const entry of entries) counts[entry.sheet]++;
  return counts;
};

/** The plan as the modal reads it: counts, the rows behind them, and every reason. */
export function toPreview(plan: PlaybookPlan, fingerprint: string): PlaybookPreview {
  // Rows, not issues: one row with three bad cells is one row that failed. A whole-tab
  // problem carries no row number and is left out of the per-tab counts by design — the
  // issue list is where it belongs, and it is not a row anyone can go and fix.
  const failed = new Set<string>();
  const failures = emptyCounts();
  for (const issue of plan.issues) {
    if (issue.row === undefined) continue;
    if (!(PLAYBOOK_SHEETS as readonly string[]).includes(issue.sheet)) continue;
    const at = `${issue.sheet}:${issue.row}`;
    if (failed.has(at)) continue;
    failed.add(at);
    failures[issue.sheet as PlaybookSheet]++;
  }
  return {
    schemaVersion: plan.schemaVersion,
    ok: planIsClean(plan),
    creates: countBySheet(plan.created),
    skips: countBySheet(plan.skipped),
    failures,
    created: plan.created,
    skipped: plan.skipped,
    issues: plan.issues,
    duplicateRule: DUPLICATE_RULE,
    fingerprint,
  };
}
