import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WorkbookError,
  columnLetter,
  findSheet,
  readTabbedWorkbook,
  readXlsxWorkbook,
} from './workbook.ts';
import { buildXlsx, buildZip } from './workbook-fixture.ts';

/** The versioned sample workbook, which is also the format's own documentation. */
const SAMPLE = path.join(
  import.meta.dirname,
  '../../docs/examples/campaign-playbook-import-format.xlsx',
);

const cellAt = (rows: { number: number; cells: unknown[] }[], row: number, column: number) =>
  rows.find((candidate) => candidate.number === row)?.cells[column];

describe('workbook reader', () => {
  it('names columns the way a spreadsheet does', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(columnLetter)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
    ]);
  });

  it('reads the committed sample workbook, tabs and all', () => {
    const workbook = readXlsxWorkbook(fs.readFileSync(SAMPLE));
    expect(workbook.kind).toBe('xlsx');
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      'README',
      'Clients',
      'Projects',
      'Tasks',
      'ChecklistItems',
      'Dependencies',
      'DataDictionary',
      'AllowedValues',
    ]);
    const clients = findSheet(workbook, 'Clients')!;
    // Header plus two clients. The sheet is 1000 rows long in the file; the rest are blank.
    expect(clients.rows).toHaveLength(3);
    expect(clients.rows[0].cells.map((cell) => cell?.value)).toEqual([
      'client_key',
      'name',
      'contact_name',
      'email',
      'phone',
      'website',
      'notes',
    ]);
    expect(cellAt(clients.rows, 2, 0)).toEqual({ kind: 'text', value: 'CLI-GHD' });
    const checklist = findSheet(workbook, 'ChecklistItems')!;
    expect(cellAt(checklist.rows, 2, 1)).toEqual({ kind: 'number', value: '1.0' });
    expect(cellAt(checklist.rows, 2, 3)).toEqual({ kind: 'boolean', value: 'TRUE' });
    expect(workbook.sheets.every((sheet) => sheet.mergedRanges.length === 0)).toBe(true);
  });

  it('keeps the spreadsheet row numbers of the rows that survive', () => {
    const workbook = readXlsxWorkbook(buildXlsx({ Clients: [['client_key'], [], [], ['CLI-A']] }));
    expect(findSheet(workbook, 'Clients')!.rows.map((row) => row.number)).toEqual([1, 4]);
  });

  it('reads inline strings, shared-string-free numbers, booleans, and entities', () => {
    const workbook = readXlsxWorkbook(
      buildXlsx({ Clients: [['name & co', 3.5, true, false, '<tagged>']] }),
    );
    expect(findSheet(workbook, 'Clients')!.rows[0].cells).toEqual([
      { kind: 'text', value: 'name & co' },
      { kind: 'number', value: '3.5' },
      { kind: 'boolean', value: 'TRUE' },
      { kind: 'boolean', value: 'FALSE' },
      { kind: 'text', value: '<tagged>' },
    ]);
  });

  it('marks formulas, merged ranges, hidden rows, and hidden sheets rather than reading past them', () => {
    const workbook = readXlsxWorkbook(
      buildXlsx({
        Clients: {
          rows: [['client_key'], [{ value: 'CLI-A', formula: 'CONCAT("CLI","-A")' }], ['CLI-B']],
          hiddenRows: [3],
          merges: ['A1:B1'],
          hidden: true,
        },
      }),
    );
    const clients = findSheet(workbook, 'Clients')!;
    expect(clients.hidden).toBe(true);
    expect(clients.mergedRanges).toEqual(['A1:B1']);
    expect(clients.rows[1].cells[0]).toMatchObject({ value: 'CLI-A', formula: true });
    expect(clients.rows[2].hidden).toBe(true);
  });

  it('marks a date-formatted number, which is how an Excel date serial arrives', () => {
    const workbook = readXlsxWorkbook(
      buildXlsx({ Tasks: [['due_date'], [{ value: null, dateSerial: 46023 }]] }),
    );
    expect(findSheet(workbook, 'Tasks')!.rows[1].cells[0]).toEqual({
      kind: 'number',
      value: '46023',
      dateFormatted: true,
    });
  });

  it('refuses a file that is not a workbook', () => {
    expect(() => readXlsxWorkbook(Buffer.from('client_key,name\nCLI-A,Acme'))).toThrow(
      WorkbookError,
    );
    expect(() => readXlsxWorkbook(Buffer.alloc(4))).toThrow(/too small/);
    // The OLE signature of a password-protected or pre-2007 Excel file.
    expect(() =>
      readXlsxWorkbook(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(40)])),
    ).toThrow(/unprotected/);
  });

  it('refuses a macro-enabled workbook', () => {
    expect(() =>
      readXlsxWorkbook(buildXlsx({ Clients: [['client_key']] }, { macros: true })),
    ).toThrow(/macros/);
  });

  it('refuses a zip that carries no workbook part', () => {
    expect(() =>
      readXlsxWorkbook(buildZip([{ name: 'notes.txt', data: Buffer.from('hello') }])),
    ).toThrow(/not an .xlsx workbook/);
  });
});

describe('pasted playbook reader', () => {
  it('reads tab-separated rows under bracketed tab names', () => {
    const workbook = readTabbedWorkbook(
      ['[Clients]', 'client_key\tname', 'CLI-A\tAcme Studio', '', '[Projects]', 'project_key'].join(
        '\n',
      ),
    );
    expect(workbook.kind).toBe('text');
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Clients', 'Projects']);
    const clients = findSheet(workbook, 'Clients')!;
    // Row numbers count from the tab heading, which is the row the author sees in that tab.
    expect(clients.rows.map((row) => row.number)).toEqual([1, 2]);
    expect(clients.rows[1].cells).toEqual([
      { kind: 'text', value: 'CLI-A' },
      { kind: 'text', value: 'Acme Studio' },
    ]);
  });

  it('treats an empty cell as absent and every value as text', () => {
    const workbook = readTabbedWorkbook('[ChecklistItems]\nTSK-1\t\t2\tTRUE');
    expect(findSheet(workbook, 'ChecklistItems')!.rows[0].cells).toEqual([
      { kind: 'text', value: 'TSK-1' },
      undefined,
      { kind: 'text', value: '2' },
      { kind: 'text', value: 'TRUE' },
    ]);
  });

  it('reads Windows line endings', () => {
    const workbook = readTabbedWorkbook('[Clients]\r\nclient_key\r\nCLI-A\r\n');
    expect(findSheet(workbook, 'Clients')!.rows).toHaveLength(2);
  });

  it('refuses text with no tab heading at all', () => {
    expect(() => readTabbedWorkbook('client_key\tname')).toThrow(/square brackets/);
    expect(() => readTabbedWorkbook('   ')).toThrow(/Paste at least one tab/);
  });
});
