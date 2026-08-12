/**
 * Reads a spreadsheet into cells, and nothing else.
 *
 * A campaign playbook is authored as an XLSX workbook
 * (`docs/campaign-playbook-import-format.md`), which is a ZIP of XML parts. Node ships both
 * halves of what that needs — `zlib.inflateRawSync` and enough string handling for the small,
 * well-known subset of SpreadsheetML the format uses — so this reads one directly rather than
 * adding a spreadsheet dependency for a single feature. It understands what the format allows
 * and refuses the rest: no macros, no encryption, and it reports the formulas, merged ranges,
 * and hidden rows the format forbids rather than quietly reading through them.
 *
 * The output is deliberately dumb — a grid of typed cells keyed by the spreadsheet's own row
 * numbers and column letters — so every rule about what a playbook *means* lives in
 * `playbook.ts` and can be tested without a binary fixture. `readTabbedWorkbook` produces the
 * same grid from tab-separated text, which is what the import modal's paste box accepts.
 */
import zlib from 'node:zlib';

/**
 * What Excel says a cell holds, kept apart from what the cell displays. The format requires
 * literal dates and native booleans, so a validator that only saw text could not tell
 * `2026-01-05` from a date serial formatted to look like one.
 */
export type CellKind = 'text' | 'number' | 'boolean' | 'error';

export interface Cell {
  kind: CellKind;
  /** The value as text: `TRUE`/`FALSE` for a boolean, the raw digits for a number. */
  value: string;
  /** The cell's number format is a date, which means a number here is an Excel date serial. */
  dateFormatted?: boolean;
  /** The cell carries a formula. Reported against its own row and column. */
  formula?: boolean;
}

export interface WorkbookRow {
  /** The spreadsheet row number, 1-based, so an error message matches what the author sees. */
  number: number;
  /** Indexed by column, `A` at 0. Sparse: a blank cell is absent rather than empty. */
  cells: (Cell | undefined)[];
  hidden?: boolean;
}

export interface WorkbookSheet {
  name: string;
  /** Fully blank rows are dropped here; `row.number` keeps the original numbering. */
  rows: WorkbookRow[];
  hidden?: boolean;
  /** Merged ranges found on the sheet. The format allows none on a data tab. */
  mergedRanges: string[];
}

export interface Workbook {
  sheets: WorkbookSheet[];
  kind: 'xlsx' | 'text';
}

/** A workbook that cannot be read at all: not a spreadsheet, encrypted, or damaged. */
export class WorkbookError extends Error {}

export const findSheet = (workbook: Workbook, name: string) =>
  workbook.sheets.find((sheet) => sheet.name === name);

/** `0` -> `A`, `26` -> `AA`. Column letters are how a spreadsheet user names a column. */
export function columnLetter(index: number) {
  let letters = '';
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1)
    letters = String.fromCharCode(65 + (value % 26)) + letters;
  return letters;
}

/** `A1` -> 0. Only the letters are read; the row number comes from the enclosing `<row>`. */
function columnIndex(reference: string) {
  let index = 0;
  for (const character of reference) {
    const code = character.charCodeAt(0);
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
/** OLE compound file, which is what an encrypted or pre-2007 Excel file actually is. */
const OLE_SIGNATURE = 'd0cf11e0';

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
  encrypted: boolean;
}

/**
 * Locates the end-of-central-directory record, which a ZIP writes last and which is the only
 * safe place to start reading: entry data comes first in the file, and a local header may omit
 * its sizes when the writer used a data descriptor.
 */
function findEndOfCentralDirectory(buffer: Buffer) {
  const earliest = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= earliest; offset--)
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  return -1;
}

function readZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  if (buffer.length < 22) throw new WorkbookError('That file is too small to be a workbook.');
  if (buffer.subarray(0, 4).toString('hex') === OLE_SIGNATURE)
    throw new WorkbookError(
      'That file is an older or password-protected Excel file. Save it as an unprotected .xlsx workbook and try again.',
    );
  if (buffer.readUInt32LE(0) !== LOCAL_HEADER)
    throw new WorkbookError('That file is not an .xlsx workbook.');
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw new WorkbookError('That workbook looks truncated — its index is missing.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || offset === 0xffffffff)
    throw new WorkbookError('That workbook uses ZIP64, which this importer does not read.');
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_HEADER)
      throw new WorkbookError('That workbook is damaged — its index does not parse.');
    const flags = buffer.readUInt16LE(offset + 8);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, {
      name,
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      localOffset: buffer.readUInt32LE(offset + 42),
      encrypted: (flags & 0x1) === 0x1,
    });
    offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return entries;
}

function readZipEntry(buffer: Buffer, entry: ZipEntry) {
  if (entry.encrypted)
    throw new WorkbookError(
      'That workbook is password-protected. Save an unprotected copy and try again.',
    );
  const header = entry.localOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_HEADER)
    throw new WorkbookError(`That workbook is damaged — ${entry.name} could not be located.`);
  const start = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method !== 8)
    throw new WorkbookError('That workbook uses a compression this importer does not read.');
  try {
    return zlib.inflateRawSync(data).toString('utf8');
  } catch {
    throw new WorkbookError(`That workbook is damaged — ${entry.name} could not be read.`);
  }
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

interface Tag {
  name: string;
  attributes: string;
  closing: boolean;
  selfClosing: boolean;
  /** Index of this tag's `<`, which is where the preceding text content ends. */
  start: number;
  /** Index just past this tag's `>`, which is where its text content begins. */
  end: number;
}

/**
 * Walks the tags of an XML document. Deliberately not a general parser: it builds no tree, so
 * a 180 KB worksheet costs one pass and allocates only the tags the caller keeps. Comments,
 * CDATA, doctypes, and processing instructions are skipped.
 */
function* tags(xml: string): Generator<Tag> {
  let index = 0;
  while (index < xml.length) {
    const open = xml.indexOf('<', index);
    if (open < 0) return;
    if (xml.startsWith('<!--', open) || xml.startsWith('<![CDATA[', open)) {
      const terminator = xml.startsWith('<!--', open) ? '-->' : ']]>';
      const close = xml.indexOf(terminator, open);
      index = close < 0 ? xml.length : close + terminator.length;
      continue;
    }
    if (xml.startsWith('<?', open) || xml.startsWith('<!', open)) {
      const close = xml.indexOf('>', open);
      index = close < 0 ? xml.length : close + 1;
      continue;
    }
    const close = xml.indexOf('>', open);
    if (close < 0) return;
    const body = xml.slice(open + 1, close);
    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');
    const inner = body.slice(closing ? 1 : 0, selfClosing ? -1 : undefined);
    const space = inner.search(/\s/);
    yield {
      name: space < 0 ? inner : inner.slice(0, space),
      attributes: space < 0 ? '' : inner.slice(space),
      closing,
      selfClosing,
      start: open,
      end: close + 1,
    };
    index = close + 1;
  }
}

const attribute = (attributes: string, name: string) =>
  decodeXml(new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1] ?? '');

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

/** Built-in number formats that render a date or a time, per ECMA-376 §18.8.30. */
const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Which cell styles carry a date number format, so a date serial can be named as one. */
function readDateStyles(stylesXml: string | undefined) {
  const dateStyles = new Set<number>();
  if (!stylesXml) return dateStyles;
  const customDateFormats = new Set<number>();
  let inCellXfs = false;
  let styleIndex = 0;
  for (const tag of tags(stylesXml)) {
    if (tag.name === 'numFmt' && !tag.closing) {
      // A custom format is a date format when a date part survives stripping the literals.
      const code = attribute(tag.attributes, 'formatCode').replace(/\[[^\]]*\]|"[^"]*"|\\./g, '');
      if (/[ymdhs]/i.test(code))
        customDateFormats.add(Number(attribute(tag.attributes, 'numFmtId')));
      continue;
    }
    if (tag.name === 'cellXfs') {
      inCellXfs = !tag.closing;
      continue;
    }
    if (!inCellXfs || tag.name !== 'xf' || tag.closing) continue;
    const formatId = Number(attribute(tag.attributes, 'numFmtId') || '0');
    if (DATE_FORMAT_IDS.has(formatId) || customDateFormats.has(formatId))
      dateStyles.add(styleIndex);
    styleIndex++;
  }
  return dateStyles;
}

/** Shared strings, in index order. Rich-text runs are joined into the one value they display. */
function readSharedStrings(xml: string | undefined) {
  const strings: string[] = [];
  if (!xml) return strings;
  let current: string[] | null = null;
  let textStart = -1;
  for (const tag of tags(xml)) {
    if (tag.name === 'si') {
      if (tag.closing) {
        strings.push((current ?? []).join(''));
        current = null;
      } else if (tag.selfClosing) strings.push('');
      else current = [];
      continue;
    }
    if (tag.name !== 't' || current === null) continue;
    if (tag.closing) {
      if (textStart >= 0) current.push(decodeXml(xml.slice(textStart, tag.start)));
      textStart = -1;
    } else if (!tag.selfClosing) textStart = tag.end;
  }
  return strings;
}

interface SheetReference {
  name: string;
  hidden: boolean;
  path: string;
}

function readSheetReferences(workbookXml: string, relationships: Map<string, string>) {
  const sheets: SheetReference[] = [];
  for (const tag of tags(workbookXml)) {
    if (tag.name !== 'sheet' || tag.closing) continue;
    const target = relationships.get(attribute(tag.attributes, 'r:id'));
    if (!target) continue;
    const state = attribute(tag.attributes, 'state');
    sheets.push({
      name: attribute(tag.attributes, 'name'),
      hidden: state !== '' && state !== 'visible',
      path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`,
    });
  }
  return sheets;
}

function readRelationships(xml: string) {
  const relationships = new Map<string, string>();
  for (const tag of tags(xml)) {
    if (tag.name !== 'Relationship' || tag.closing) continue;
    relationships.set(attribute(tag.attributes, 'Id'), attribute(tag.attributes, 'Target'));
  }
  return relationships;
}

function cellKind(type: string): CellKind {
  if (type === 'b') return 'boolean';
  if (type === 'e') return 'error';
  return type === '' || type === 'n' ? 'number' : 'text';
}

interface PendingCell {
  index: number;
  kind: CellKind;
  shared: boolean;
  dateFormatted: boolean;
  formula: boolean;
  text: string[];
}

/**
 * One worksheet, in one pass. `<c>` opens a cell, `<v>`/`<t>` collect its text — including the
 * runs inside an inline string — and `</c>` is where the finished value is placed, because
 * only then is the text complete.
 */
function parseSheet(
  name: string,
  hidden: boolean,
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
): WorkbookSheet {
  const rows: WorkbookRow[] = [];
  const mergedRanges: string[] = [];
  let row: WorkbookRow | null = null;
  let cell: PendingCell | null = null;
  let textStart = -1;

  const place = () => {
    if (!row || !cell || cell.index < 0) return;
    const raw = cell.text.join('');
    const value = cell.shared ? (shared[Number(raw)] ?? '') : raw;
    // A styled cell with no value is blank, however many of them a spreadsheet leaves behind
    // below the data. A formula cell is kept even when empty, so it can be reported.
    if (value === '' && !cell.formula) return;
    row.cells[cell.index] = {
      kind: cell.kind,
      value: cell.kind === 'boolean' ? (value === '1' ? 'TRUE' : 'FALSE') : value,
      ...(cell.dateFormatted ? { dateFormatted: true } : {}),
      ...(cell.formula ? { formula: true } : {}),
    };
  };

  for (const tag of tags(xml)) {
    switch (tag.name) {
      case 'mergeCell':
        if (!tag.closing) mergedRanges.push(attribute(tag.attributes, 'ref'));
        break;
      case 'row':
        if (tag.closing) {
          if (row?.cells.some((candidate) => candidate !== undefined)) rows.push(row);
          row = null;
          cell = null;
        } else if (!tag.selfClosing) {
          row = {
            number: Number(attribute(tag.attributes, 'r')) || rows.length + 1,
            cells: [],
            ...(attribute(tag.attributes, 'hidden') === '1' ? { hidden: true } : {}),
          };
        }
        break;
      case 'c':
        if (tag.closing) {
          place();
          cell = null;
        } else if (!tag.selfClosing) {
          cell = {
            index: columnIndex(attribute(tag.attributes, 'r')),
            kind: cellKind(attribute(tag.attributes, 't')),
            shared: attribute(tag.attributes, 't') === 's',
            dateFormatted: dateStyles.has(Number(attribute(tag.attributes, 's') || '0')),
            formula: false,
            text: [],
          };
        }
        break;
      case 'f':
        if (cell && !tag.closing) cell.formula = true;
        break;
      case 'v':
      case 't':
        if (!cell) break;
        if (tag.closing) {
          if (textStart >= 0) cell.text.push(decodeXml(xml.slice(textStart, tag.start)));
          textStart = -1;
        } else if (!tag.selfClosing) textStart = tag.end;
        break;
      default:
        break;
    }
  }
  return { name, rows, mergedRanges, ...(hidden ? { hidden: true } : {}) };
}

export function readXlsxWorkbook(buffer: Buffer): Workbook {
  const entries = readZipEntries(buffer);
  if ([...entries.keys()].some((name) => name.toLowerCase().endsWith('vbaproject.bin')))
    throw new WorkbookError(
      'That workbook contains macros. Save it as a plain .xlsx workbook and try again.',
    );
  const workbookEntry = entries.get('xl/workbook.xml');
  const relationshipsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relationshipsEntry)
    throw new WorkbookError('That file is not an .xlsx workbook.');
  const relationships = readRelationships(readZipEntry(buffer, relationshipsEntry));
  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const stylesEntry = entries.get('xl/styles.xml');
  const shared = readSharedStrings(sharedEntry && readZipEntry(buffer, sharedEntry));
  const dateStyles = readDateStyles(stylesEntry && readZipEntry(buffer, stylesEntry));
  const sheets: WorkbookSheet[] = [];
  for (const reference of readSheetReferences(readZipEntry(buffer, workbookEntry), relationships)) {
    const entry = entries.get(reference.path);
    if (!entry) continue;
    sheets.push(
      parseSheet(reference.name, reference.hidden, readZipEntry(buffer, entry), shared, dateStyles),
    );
  }
  if (sheets.length === 0) throw new WorkbookError('That workbook has no sheets.');
  return { sheets, kind: 'xlsx' };
}

// ---------------------------------------------------------------------------
// Tabbed text
// ---------------------------------------------------------------------------

/** The line that opens a tab in the pasted form: `[Tasks]`, alone on its line. */
const TEXT_SHEET_HEADING = /^\[\s*([A-Za-z][A-Za-z0-9 _-]*)\s*\]$/;

/**
 * Reads the pasted form of a playbook: the same tabs, each introduced by its name in square
 * brackets and followed by tab-separated rows copied straight out of the spreadsheet.
 *
 * Pasted cells carry no types, so every value arrives as text — which is why the validator
 * accepts `TRUE`/`FALSE` and plain digits there, exactly what a spreadsheet copies out. Row
 * numbers restart under each tab heading, matching the rows the author sees in that tab.
 */
export function readTabbedWorkbook(text: string): Workbook {
  const sheets: WorkbookSheet[] = [];
  let current: WorkbookSheet | null = null;
  let lineNumber = 0;
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    lineNumber++;
    const heading = TEXT_SHEET_HEADING.exec(rawLine.trim());
    if (heading) {
      current = { name: heading[1].trim(), rows: [], mergedRanges: [] };
      sheets.push(current);
      lineNumber = 0;
      continue;
    }
    if (rawLine.trim() === '') continue;
    if (!current)
      throw new WorkbookError(
        'Start the pasted playbook with a tab name in square brackets, such as [Clients].',
      );
    current.rows.push({
      number: lineNumber,
      cells: rawLine.split('\t').map((value) => {
        const trimmed = value.trim();
        return trimmed === '' ? undefined : { kind: 'text' as const, value: trimmed };
      }),
    });
  }
  if (sheets.length === 0)
    throw new WorkbookError(
      'Paste at least one tab, starting with its name in square brackets, such as [Clients].',
    );
  return { sheets, kind: 'text' };
}
