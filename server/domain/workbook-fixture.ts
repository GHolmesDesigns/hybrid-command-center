/**
 * Builds a small XLSX workbook in memory, so the reader and the importer can be tested
 * against real ZIP and SpreadsheetML bytes rather than a hand-mocked grid.
 *
 * The refusals the format promises — a formula in a data cell, a merged range, a date serial,
 * a hidden row, a macro part — cannot be exercised any other way: they are properties of the
 * file, not of the values in it. A committed sample workbook per case would be a binary per
 * case; this is one readable function instead.
 *
 * Deliberately minimal: inline strings rather than a shared-string table, `STORED` entries
 * rather than deflate, and no styles unless a case asks for a date format. That is enough for
 * a conforming reader, and it keeps every byte here explainable.
 */
import zlib from 'node:zlib';

export type FixtureValue = string | number | boolean | null | undefined;

export interface FixtureCell {
  value: FixtureValue;
  /** Emits `<f>` alongside the value, which the format refuses. */
  formula?: string;
  /** Emits the value as a date-formatted number: an Excel date serial. */
  dateSerial?: number;
}

export type FixtureRow = (FixtureValue | FixtureCell)[];

export interface FixtureSheet {
  rows: FixtureRow[];
  hidden?: boolean;
  hiddenRows?: number[];
  merges?: string[];
}

export interface FixtureOptions {
  /** Adds a `vbaProject.bin` part, which makes the workbook macro-enabled. */
  macros?: boolean;
}

const escapeXml = (value: string) =>
  value.replace(/[&<>"]/g, (character) =>
    character === '&'
      ? '&amp;'
      : character === '<'
        ? '&lt;'
        : character === '>'
          ? '&gt;'
          : '&quot;',
  );

const columnLetter = (index: number) => {
  let letters = '';
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1)
    letters = String.fromCharCode(65 + (value % 26)) + letters;
  return letters;
};

const asCell = (entry: FixtureValue | FixtureCell): FixtureCell =>
  entry !== null && typeof entry === 'object' ? entry : { value: entry };

/** Style 1 is the date-formatted style; style 0 is the default. */
const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="0"/>
<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>
</styleSheet>`;

function cellXml(reference: string, entry: FixtureCell) {
  const formula = entry.formula ? `<f>${escapeXml(entry.formula)}</f>` : '';
  if (entry.dateSerial !== undefined)
    return `<c r="${reference}" s="1">${formula}<v>${entry.dateSerial}</v></c>`;
  const { value } = entry;
  if (value === null || value === undefined || value === '')
    return formula ? `<c r="${reference}">${formula}</c>` : `<c r="${reference}"/>`;
  if (typeof value === 'boolean')
    return `<c r="${reference}" t="b">${formula}<v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number') return `<c r="${reference}">${formula}<v>${value}</v></c>`;
  return `<c r="${reference}" t="inlineStr">${formula}<is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function sheetXml(sheet: FixtureSheet) {
  const hidden = new Set(sheet.hiddenRows ?? []);
  const rows = sheet.rows
    .map((row, index) => {
      const number = index + 1;
      const cells = row
        .map((entry, column) => cellXml(`${columnLetter(column)}${number}`, asCell(entry)))
        .join('');
      return `<row r="${number}"${hidden.has(number) ? ' hidden="1"' : ''}>${cells}</row>`;
    })
    .join('');
  const merges = (sheet.merges ?? []).length
    ? `<mergeCells count="${sheet.merges!.length}">${sheet.merges!.map((reference) => `<mergeCell ref="${reference}"/>`).join('')}</mergeCells>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${merges}</worksheet>`;
}

/** CRC-32, which a ZIP entry header has to carry even when the data is stored uncompressed. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  name: string;
  data: Buffer;
  /** `8` for deflate, `0` for stored. Both are exercised, since a real workbook deflates. */
  method?: 0 | 8;
}

/** A ZIP archive with no extra fields, no comment, and no ZIP64 — the shape OOXML uses. */
export function buildZip(inputs: ZipInput[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const input of inputs) {
    const method = input.method ?? 8;
    const stored = method === 8 ? zlib.deflateRawSync(input.data) : input.data;
    const name = Buffer.from(input.name, 'utf8');
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(input.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(input.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(input.data), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(input.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, stored);
    centrals.push(central);
    offset += local.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(inputs.length, 8);
  end.writeUInt16LE(inputs.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A workbook whose tabs are the keys of `sheets`, in the order they are written. */
export function buildXlsx(
  sheets: Record<string, FixtureSheet | FixtureRow[]>,
  options: FixtureOptions = {},
) {
  const entries = Object.entries(sheets).map(([name, value], index) => ({
    name,
    sheet: Array.isArray(value) ? { rows: value } : value,
    path: `worksheets/sheet${index + 1}.xml`,
    relationshipId: `rId${index + 10}`,
  }));
  const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${entries
    .map(
      (entry, index) =>
        `<sheet name="${escapeXml(entry.name)}" sheetId="${index + 1}" r:id="${entry.relationshipId}"${entry.sheet.hidden ? ' state="hidden"' : ''}/>`,
    )
    .join('')}</sheets></workbook>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
    .map(
      (entry) =>
        `<Relationship Id="${entry.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${entry.path}"/>`,
    )
    .join(
      '',
    )}<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const parts: ZipInput[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWb" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(relationships, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    ...entries.map((entry) => ({
      name: `xl/${entry.path}`,
      data: Buffer.from(sheetXml(entry.sheet), 'utf8'),
    })),
  ];
  if (options.macros)
    parts.push({
      name: 'xl/vbaProject.bin',
      data: Buffer.from('macro', 'utf8'),
      method: 0 as const,
    });
  return buildZip(parts);
}
