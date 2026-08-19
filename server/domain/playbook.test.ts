import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPlan, emptyWorkspace, planIsClean, toPreview } from './playbook.ts';
import type { WorkspaceSnapshot } from './playbook.ts';
import { readTabbedWorkbook, readXlsxWorkbook } from './workbook.ts';
import { SKIP_REASON } from '../../shared/playbook.ts';
import { buildXlsx } from './workbook-fixture.ts';

const SAMPLE = path.join(
  import.meta.dirname,
  '../../docs/examples/campaign-playbook-import-format.xlsx',
);

/** A minimal playbook in the pasted form, with the pieces a case wants replaced. */
function playbook(
  overrides: Partial<
    Record<'Clients' | 'Projects' | 'Tasks' | 'ChecklistItems' | 'Dependencies', string[][]>
  > = {},
) {
  const tabs = {
    Clients: [
      ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
      ['CLI-A', 'Acme Studio', '', '', '', '', ''],
    ],
    Projects: [
      [
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
      ['PRJ-A', 'CLI-A', 'Spring Campaign', 'ACTIVE', 'HIGH', '', '', '', '', '1'],
    ],
    Tasks: [
      [
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
      [
        'TSK-1',
        'PRJ-A',
        'Week 1 blog post',
        'BLOG_POST',
        'TODO',
        'HIGH',
        '',
        '2026-03-02',
        '',
        '',
        '1',
      ],
      ['TSK-2', 'PRJ-A', 'Week 1 social set', '', 'BACKLOG', 'MEDIUM', '', '', '', '', '2'],
    ],
    ChecklistItems: [
      ['task_key', 'item_order', 'title', 'completed'],
      ['TSK-1', '1', 'Draft the post', 'TRUE'],
      ['TSK-1', '2', 'Edit for clarity', 'FALSE'],
    ],
    Dependencies: [
      ['task_key', 'prerequisite_task_key'],
      ['TSK-2', 'TSK-1'],
    ],
    ...overrides,
  };
  return readTabbedWorkbook(
    Object.entries(tabs)
      .map(([name, rows]) => [`[${name}]`, ...rows.map((row) => row.join('\t'))].join('\n'))
      .join('\n'),
  );
}

const plan = (overrides?: Parameters<typeof playbook>[0], workspace = emptyWorkspace()) =>
  buildPlan(playbook(overrides), workspace);

const messages = (result: ReturnType<typeof buildPlan>) =>
  result.issues.map(
    (issue) => `${issue.sheet}${issue.row ? ` ${issue.row}` : ''} ${issue.message}`,
  );

describe('campaign playbook plan', () => {
  it('plans the committed sample workbook into an empty workspace with no issues', () => {
    const result = buildPlan(readXlsxWorkbook(fs.readFileSync(SAMPLE)), emptyWorkspace());
    expect(messages(result)).toEqual([]);
    expect(planIsClean(result)).toBe(true);
    expect(result.schemaVersion).toBe(1);
    const preview = toPreview(result, 'digest');
    expect(preview.creates).toEqual({
      Clients: 2,
      Projects: 2,
      Tasks: 64,
      ChecklistItems: 151,
      Dependencies: 25,
    });
    expect(preview.ok).toBe(true);
    expect(preview.duplicateRule.length).toBeGreaterThan(0);
  });

  it('plans a small playbook, defaulting the optional enums and zero-basing the order', () => {
    const result = plan();
    expect(messages(result)).toEqual([]);
    expect(result.clients).toEqual([
      {
        row: 2,
        key: 'CLI-A',
        name: 'Acme Studio',
        contactName: null,
        email: null,
        phone: null,
        website: null,
        notes: null,
      },
    ]);
    expect(result.projects[0]).toMatchObject({ status: 'ACTIVE', priority: 'HIGH', position: 0 });
    expect(result.tasks.map((task) => [task.key, task.status, task.position])).toEqual([
      ['TSK-1', 'TODO', 0],
      ['TSK-2', 'BACKLOG', 0],
    ]);
    expect(result.tasks[1].taskType).toBeNull();
    expect(result.checklistItems.map((item) => [item.text, item.completed, item.position])).toEqual(
      [
        ['Draft the post', true, 0],
        ['Edit for clarity', false, 1],
      ],
    );
    expect(result.dependencies).toEqual([{ row: 2, taskKey: 'TSK-2', prerequisiteKey: 'TSK-1' }]);
  });

  it('orders rows by their workbook position rather than the order they were written', () => {
    const result = plan({
      Tasks: [
        [
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
        ['TSK-2', 'PRJ-A', 'Second', '', 'TODO', 'MEDIUM', '', '', '', '', '2'],
        ['TSK-1', 'PRJ-A', 'First', '', 'TODO', 'MEDIUM', '', '', '', '', '1'],
        ['TSK-3', 'PRJ-A', 'Unnumbered', '', 'TODO', 'MEDIUM', '', '', '', '', ''],
      ],
      ChecklistItems: [['task_key', 'item_order', 'title', 'completed']],
      Dependencies: [['task_key', 'prerequisite_task_key']],
    });
    expect(messages(result)).toEqual([]);
    expect(result.tasks.map((task) => [task.title, task.position])).toEqual([
      ['First', 0],
      ['Second', 1],
      ['Unnumbered', 2],
    ]);
  });

  describe('validation', () => {
    it('reports a missing required tab', () => {
      const workbook = readTabbedWorkbook('[Clients]\nclient_key\tname\nCLI-A\tAcme Studio');
      const result = buildPlan(workbook, emptyWorkspace());
      expect(messages(result)).toContain(
        'Projects This tab is required. Add a Projects tab with the documented columns.',
      );
    });

    it('accepts a playbook with no checklist or dependency tab', () => {
      const workbook = readTabbedWorkbook(
        [
          '[Clients]',
          'client_key\tname\tcontact_name\temail\tphone\twebsite\tnotes',
          'CLI-A\tAcme Studio',
          '[Projects]',
          'project_key\tclient_key\tname\tstatus\tpriority\tstart_date\ttarget_deadline\tdescription\tnotes\tposition',
          'PRJ-A\tCLI-A\tSpring Campaign',
          '[Tasks]',
          'task_key\tproject_key\ttitle\ttask_type\tstatus\tpriority\tstart_date\tdue_date\tdescription\tnotes\tposition',
          'TSK-1\tPRJ-A\tWeek 1 blog post',
        ].join('\n'),
      );
      const result = buildPlan(workbook, emptyWorkspace());
      expect(messages(result)).toEqual([]);
      // The tabs the format leaves optional default the same way an empty tab would.
      expect(result.projects[0]).toMatchObject({ status: 'ACTIVE', priority: 'MEDIUM' });
      expect(result.tasks[0]).toMatchObject({ status: 'BACKLOG', priority: 'MEDIUM' });
    });

    it('reports a misspelled and an unknown column instead of ignoring them', () => {
      const result = plan({
        Clients: [
          ['client_key', 'Name', 'contact_name', 'email', 'phone', 'website', 'notes', 'owner'],
          ['CLI-A', 'Acme Studio'],
        ],
      });
      expect(messages(result)).toEqual(
        expect.arrayContaining([
          'Clients 1 The name column is missing.',
          'Clients 1 Name is not a column of this tab. Remove it or correct its spelling.',
          'Clients 1 owner is not a column of this tab. Remove it or correct its spelling.',
        ]),
      );
    });

    it('reports an unknown tab', () => {
      const workbook = readTabbedWorkbook('[Campaigns]\nclient_key');
      expect(messages(buildPlan(workbook, emptyWorkspace()))[0]).toMatch(
        /Campaigns This tab is not part of the format/,
      );
    });

    it('names the row and column of every bad cell', () => {
      const result = plan({
        Clients: [
          ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
          ['cli-a', 'A', '', 'not-an-email', '', 'gholmesdesigns.com', ''],
        ],
      });
      expect(messages(result)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('client_key: keys start with a capital letter'),
          'Clients 2 name: needs at least 2 characters.',
          'Clients 2 email: expected an email address.',
          'Clients 2 website: expected a full web address, starting with https://.',
        ]),
      );
      expect(result.issues.find((issue) => issue.message.startsWith('email'))?.column).toBe('D');
    });

    it('rejects an impossible date, a mis-typed date, and an Excel date serial', () => {
      const textual = plan({
        Tasks: [
          [
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
          ['TSK-1', 'PRJ-A', 'Impossible', '', 'TODO', 'HIGH', '', '2026-02-30', '', '', '1'],
          ['TSK-2', 'PRJ-A', 'Wrong shape', '', 'TODO', 'HIGH', '', '03/02/2026', '', '', '2'],
        ],
        ChecklistItems: [['task_key', 'item_order', 'title', 'completed']],
        Dependencies: [['task_key', 'prerequisite_task_key']],
      });
      expect(messages(textual)).toEqual(
        expect.arrayContaining([
          'Tasks 2 due_date: that is not a real calendar date.',
          'Tasks 3 due_date: expected a date written as YYYY-MM-DD.',
        ]),
      );

      const serial = buildPlan(
        readXlsxWorkbook(
          buildXlsx({
            Clients: [
              ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
              ['CLI-A', 'Acme Studio'],
            ],
            Projects: [
              [
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
              ['PRJ-A', 'CLI-A', 'Spring Campaign'],
            ],
            Tasks: [
              [
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
              [
                'TSK-1',
                'PRJ-A',
                'Serial date',
                null,
                null,
                null,
                null,
                { value: null, dateSerial: 46083 },
              ],
            ],
          }),
        ),
        emptyWorkspace(),
      );
      expect(messages(serial)).toEqual([
        'Tasks 2 due_date: this is a spreadsheet date value. Format the column as plain text and type the date as YYYY-MM-DD.',
      ]);
    });

    it('refuses a deadline that falls before its start date', () => {
      const result = plan({
        Projects: [
          [
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
          [
            'PRJ-A',
            'CLI-A',
            'Spring Campaign',
            'ACTIVE',
            'HIGH',
            '2026-03-10',
            '2026-03-01',
            '',
            '',
            '1',
          ],
        ],
      });
      expect(messages(result)).toContain(
        'Projects 2 target_deadline: cannot fall before start_date.',
      );
    });

    it('refuses a value outside an enum, naming the vocabulary', () => {
      const result = plan({
        Projects: [
          [
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
          ['PRJ-A', 'CLI-A', 'Spring Campaign', 'active', 'HIGH', '', '', '', '', '1'],
        ],
      });
      expect(messages(result)).toContain(
        'Projects 2 status: expected one of PLANNING, ACTIVE, ON_HOLD, COMPLETE.',
      );
    });

    it('reports a formula, a merged range, and a hidden row', () => {
      const workbook = readXlsxWorkbook(
        buildXlsx({
          Clients: {
            rows: [
              ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
              ['CLI-A', { value: 'Acme Studio', formula: 'A2&" Studio"' }],
              ['CLI-B', 'Beta Studio'],
            ],
            merges: ['F1:G1'],
            hiddenRows: [3],
          },
        }),
      );
      expect(messages(buildPlan(workbook, emptyWorkspace()))).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Merged cells are not allowed on a data tab (F1:G1)'),
          'Clients 2 name: formulas are not allowed. Replace it with the value it produces.',
          expect.stringContaining('Clients 3 This row is hidden.'),
        ]),
      );
    });

    it('refuses a duplicate key, an unresolved reference, and a repeated position', () => {
      const result = plan({
        Tasks: [
          [
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
          ['TSK-1', 'PRJ-A', 'First', '', 'TODO', 'HIGH', '', '', '', '', '1'],
          ['TSK-1', 'PRJ-A', 'Same key', '', 'TODO', 'HIGH', '', '', '', '', '2'],
          ['TSK-3', 'PRJ-MISSING', 'Orphan', '', 'TODO', 'HIGH', '', '', '', '', '3'],
          ['TSK-4', 'PRJ-A', 'Position clash', '', 'TODO', 'HIGH', '', '', '', '', '1'],
        ],
        ChecklistItems: [['task_key', 'item_order', 'title', 'completed']],
        Dependencies: [['task_key', 'prerequisite_task_key']],
      });
      expect(messages(result)).toEqual(
        expect.arrayContaining([
          'Tasks 3 task_key TSK-1 is already defined on another row.',
          'Tasks 4 project_key PRJ-MISSING is not defined on the Projects tab.',
          'Tasks 5 position 1 is already used by row 2 for PRJ-A in TODO.',
        ]),
      );
    });

    it('sends the children of a rejected row to the row that has to be fixed', () => {
      // One bad cell on the Tasks tab. Its checklist rows and its dependency row cannot be
      // imported either, and saying their key "is not defined" would send the author looking
      // for a row that is sitting right there.
      const result = plan({
        Tasks: [
          [
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
          ['TSK-1', 'PRJ-A', 'Week 1 blog post', '', 'TODO', 'HIGH', '', '2026-02-30', '', '', '1'],
          ['TSK-2', 'PRJ-A', 'Week 1 social set', '', 'TODO', 'HIGH', '', '', '', '', '2'],
        ],
      });
      expect(messages(result)).toEqual([
        'Tasks 2 due_date: that is not a real calendar date.',
        'ChecklistItems 2 task_key TSK-1 is on the Tasks tab, but that row cannot be imported. Fixing it fixes this row too.',
        'ChecklistItems 3 task_key TSK-1 is on the Tasks tab, but that row cannot be imported. Fixing it fixes this row too.',
        'Dependencies 2 task_key TSK-1 is on the Tasks tab, but that row cannot be imported. Fixing it fixes this row too.',
      ]);
      // A key that really is absent still says so.
      const absent = plan({
        ChecklistItems: [
          ['task_key', 'item_order', 'title', 'completed'],
          ['TSK-NOPE', '1', 'Draft the post', 'TRUE'],
        ],
        Dependencies: [['task_key', 'prerequisite_task_key']],
      });
      expect(messages(absent)).toEqual([
        'ChecklistItems 2 task_key TSK-NOPE is not defined on the Tasks tab.',
      ]);
    });

    it('reports a project whose client failed against the client row, not as a missing key', () => {
      const result = plan({
        Clients: [
          ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
          ['CLI-A', 'A'],
        ],
        ChecklistItems: [['task_key', 'item_order', 'title', 'completed']],
        Dependencies: [['task_key', 'prerequisite_task_key']],
      });
      expect(messages(result)).toEqual([
        'Clients 2 name: needs at least 2 characters.',
        'Projects 2 client_key CLI-A is on the Clients tab, but that row cannot be imported. Fixing it fixes this row too.',
        'Tasks 2 project_key PRJ-A is on the Projects tab, but that row cannot be imported. Fixing it fixes this row too.',
        'Tasks 3 project_key PRJ-A is on the Projects tab, but that row cannot be imported. Fixing it fixes this row too.',
      ]);
    });

    it('refuses two workbook rows that describe the same record', () => {
      const result = plan({
        Clients: [
          ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
          ['CLI-A', 'Acme Studio'],
          ['CLI-B', 'acme studio'],
        ],
      });
      expect(messages(result)).toContain(
        'Clients 3 Two rows describe a client called “acme studio”. Give one of them a different name.',
      );
    });

    it('refuses a self-dependency, a repeated pair, and a cycle', () => {
      const result = plan({
        Dependencies: [
          ['task_key', 'prerequisite_task_key'],
          ['TSK-1', 'TSK-1'],
          ['TSK-2', 'TSK-1'],
          ['TSK-1', 'TSK-2'],
        ],
      });
      expect(messages(result)).toEqual(
        expect.arrayContaining([
          'Dependencies 2 TSK-1 cannot depend on itself.',
          'Dependencies 4 TSK-1 depending on TSK-2 would create a circular relationship.',
        ]),
      );
    });

    it('counts failed rows once however many cells in them are wrong', () => {
      const result = plan({
        Clients: [
          ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
          ['CLI-A', 'A', '', 'nope', '', 'nope', ''],
        ],
      });
      const preview = toPreview(result, 'digest');
      expect(preview.failures.Clients).toBe(1);
      expect(preview.issues.filter((issue) => issue.sheet === 'Clients').length).toBeGreaterThan(1);
      expect(preview.ok).toBe(false);
    });

    it('refuses a workbook that declares a schema version this build does not import', () => {
      const workbook = readTabbedWorkbook(
        [
          '[README]',
          'Schema version\t7',
          '[Clients]',
          'client_key\tname',
          'CLI-A\tAcme Studio',
        ].join('\n'),
      );
      const result = buildPlan(workbook, emptyWorkspace());
      expect(messages(result)).toContain(
        'README 1 This workbook declares schema version 7. This build imports version 1.',
      );
      expect(result.schemaVersion).toBe(7);
    });
  });

  describe('the duplicate rule', () => {
    const workspace = (): WorkspaceSnapshot => ({
      ...emptyWorkspace(),
      clients: [{ id: 'client-1', name: 'ACME studio' }],
      projects: [{ id: 'project-1', clientId: 'client-1', name: 'Spring Campaign' }],
      tasks: [
        { id: 'task-1', projectId: 'project-1', title: 'Week 1 blog post', dueDate: '2026-03-02' },
      ],
      projectPosition: 4,
      taskPosition: { TODO: 2 },
    });

    it('attaches to an existing client and project rather than creating a second one', () => {
      const result = plan(undefined, workspace());
      expect(messages(result)).toEqual([]);
      expect(result.clients).toEqual([]);
      expect(result.projects).toEqual([]);
      expect(result.resolutions.clients.get('CLI-A')).toEqual({
        kind: 'existing',
        id: 'client-1',
      });
      expect(result.skipped.map((skip) => [skip.sheet, skip.label, skip.existingId])).toEqual([
        ['Clients', 'Acme Studio', 'client-1'],
        ['Projects', 'Spring Campaign', 'project-1'],
        ['Tasks', 'Week 1 blog post', 'task-1'],
        ['ChecklistItems', 'Draft the post', 'task-1'],
        ['ChecklistItems', 'Edit for clarity', 'task-1'],
      ]);
    });

    it('matches a task on title and due date together, so repeated work is not lost', () => {
      const result = plan(
        {
          Tasks: [
            [
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
            [
              'TSK-1',
              'PRJ-A',
              'Week 1 blog post',
              '',
              'TODO',
              'HIGH',
              '',
              '2026-03-02',
              '',
              '',
              '1',
            ],
            [
              'TSK-2',
              'PRJ-A',
              'Week 1 blog post',
              '',
              'TODO',
              'HIGH',
              '',
              '2026-03-09',
              '',
              '',
              '2',
            ],
          ],
          ChecklistItems: [['task_key', 'item_order', 'title', 'completed']],
          Dependencies: [['task_key', 'prerequisite_task_key']],
        },
        workspace(),
      );
      expect(messages(result)).toEqual([]);
      expect(result.tasks.map((task) => [task.title, task.dueDate])).toEqual([
        ['Week 1 blog post', '2026-03-09'],
      ]);
      expect(result.skipped.map((skip) => skip.key)).toEqual(['CLI-A', 'PRJ-A', 'TSK-1']);
    });

    it('continues the positions the workspace already uses', () => {
      const result = plan(
        {
          Clients: [
            ['client_key', 'name', 'contact_name', 'email', 'phone', 'website', 'notes'],
            ['CLI-B', 'Beta Studio'],
          ],
          Projects: [
            [
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
            ['PRJ-B', 'CLI-B', 'Summer Campaign', 'ACTIVE', 'HIGH', '', '', '', '', '1'],
          ],
          Tasks: [
            [
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
            ['TSK-9', 'PRJ-B', 'Kickoff', '', 'TODO', 'HIGH', '', '', '', '', '1'],
          ],
          ChecklistItems: [['task_key', 'item_order', 'title', 'completed']],
          Dependencies: [['task_key', 'prerequisite_task_key']],
        },
        workspace(),
      );
      expect(result.projects[0].position).toBe(5);
      expect(result.tasks[0].position).toBe(3);
    });

    it('skips a dependency both of whose tasks already have it', () => {
      const existing = workspace();
      existing.tasks.push({
        id: 'task-2',
        projectId: 'project-1',
        title: 'Week 1 social set',
        dueDate: null,
      });
      existing.dependencies.push({ taskId: 'task-2', dependencyId: 'task-1' });
      const result = plan(undefined, existing);
      expect(messages(result)).toEqual([]);
      expect(result.dependencies).toEqual([]);
      expect(result.skipped.filter((skip) => skip.sheet === 'Dependencies')).toHaveLength(1);
    });

    it('sees a cycle that closes through dependencies the workspace already holds', () => {
      const existing = workspace();
      existing.tasks.push({
        id: 'task-2',
        projectId: 'project-1',
        title: 'Week 1 social set',
        dueDate: null,
      });
      // task-1 already depends on task-2, so making task-2 depend on task-1 closes the loop.
      existing.dependencies.push({ taskId: 'task-1', dependencyId: 'task-2' });
      const result = plan(undefined, existing);
      expect(messages(result)).toContain(
        'Dependencies 2 TSK-2 depending on TSK-1 would create a circular relationship.',
      );
    });
  });

  /**
   * C70. A name says what a client is called; an identity says which client it is. Renaming the
   * client at its source used to make the next import create a second one, so a `Clients` row may
   * carry the `(source, id)` pair the client has where the playbook was written, and that pair is
   * what it resolves by from then on.
   *
   * A row that fails takes its children with it, so a case about a refused row asserts the message
   * it is about rather than the whole cascade behind it.
   */
  describe('a client identity at its source', () => {
    const SOURCE = '9d3f1c62-5a47-4e8b-b0d2-7c6841ae5f30';
    const NAMESPACE = `campaign-playbook:${SOURCE}`;
    const CLIENT_HEADER = [
      'client_key',
      'name',
      'contact_name',
      'email',
      'phone',
      'website',
      'notes',
      'client_import_source',
      'client_import_id',
    ];
    /** The one-client `Clients` tab, with the identity pair each case wants on it. */
    const clientsTab = (name: string, source = SOURCE, externalId = 'ghd-studio') => [
      CLIENT_HEADER,
      ['CLI-A', name, '', '', '', '', '', source, externalId],
    ];

    /** A workspace holding clients, with the identities already recorded against them. */
    const holding = (
      clients: { id: string; name: string; mergedIntoId?: string }[],
      clientAliases: { namespace: string; externalId: string; clientId: string }[] = [],
    ): WorkspaceSnapshot => ({ ...emptyWorkspace(), clients, clientAliases });

    it('resolves a client whose name changed at its source, by identity alone', () => {
      const workspace = holding(
        [{ id: 'client-1', name: 'Acme Studio' }],
        [{ namespace: NAMESPACE, externalId: 'ghd-studio', clientId: 'client-1' }],
      );

      // The workbook now calls it something else entirely. The identity still names client-1.
      const result = plan({ Clients: clientsTab('Acme Worldwide') }, workspace);

      expect(messages(result)).toEqual([]);
      expect(result.clients).toEqual([]);
      expect(result.resolutions.clients.get('CLI-A')).toEqual({
        kind: 'existing',
        id: 'client-1',
      });
      expect(result.skipped[0]).toMatchObject({
        sheet: 'Clients',
        label: 'Acme Worldwide',
        existingId: 'client-1',
        reason: SKIP_REASON.clientIdentity,
      });
      // Nothing to record: the identity is already there, and the client keeps its own name.
      expect(result.clientIdentities).toEqual([]);
    });

    it('refuses the whole import when the identity and the name are two different clients', () => {
      const workspace = holding(
        [
          { id: 'client-1', name: 'Acme Studio' },
          { id: 'client-2', name: 'Acme Worldwide' },
        ],
        [{ namespace: NAMESPACE, externalId: 'ghd-studio', clientId: 'client-1' }],
      );

      const result = plan({ Clients: clientsTab('Acme Worldwide') }, workspace);

      expect(planIsClean(result)).toBe(false);
      expect(messages(result)[0]).toBe(
        'Clients 2 The source identity on this row belongs to “Acme Studio” and the name on it matches “Acme Worldwide”. Nothing was imported. Correct the row, or merge the two clients first.',
      );
      // Nothing is planned for this row, and nothing is recorded either.
      expect(result.clients).toEqual([]);
      expect(result.clientIdentities).toEqual([]);
      expect(result.skipped).toEqual([]);
    });

    it('records a new identity against the client its name already matched', () => {
      const workspace = holding([{ id: 'client-1', name: 'acme studio' }]);

      const result = plan({ Clients: clientsTab('Acme Studio') }, workspace);

      expect(messages(result)).toEqual([]);
      expect(result.clients).toEqual([]);
      expect(result.skipped[0]).toMatchObject({
        existingId: 'client-1',
        reason: SKIP_REASON.clientIdentityAttach,
      });
      expect(result.clientIdentities).toEqual([
        { row: 2, clientKey: 'CLI-A', namespace: NAMESPACE, externalId: 'ghd-studio' },
      ]);
    });

    it('records the identity against a client created by the same import', () => {
      const result = plan({ Clients: clientsTab('Acme Studio') }, emptyWorkspace());

      expect(messages(result)).toEqual([]);
      expect(result.clients.map((client) => client.name)).toEqual(['Acme Studio']);
      expect(result.clientIdentities).toEqual([
        { row: 2, clientKey: 'CLI-A', namespace: NAMESPACE, externalId: 'ghd-studio' },
      ]);
    });

    it('records it against the surviving client when the name matched through a merge', () => {
      const workspace = holding([
        { id: 'client-1', name: 'Acme Studio', mergedIntoId: 'client-2' },
        { id: 'client-2', name: 'Acme Group' },
      ]);

      const result = plan({ Clients: clientsTab('Acme Studio') }, workspace);

      expect(messages(result)).toEqual([]);
      expect(result.skipped[0]).toMatchObject({
        existingId: 'client-2',
        reason: SKIP_REASON.clientIdentityAttachMergedAlias,
      });
      expect(result.clientIdentities[0]).toMatchObject({ clientKey: 'CLI-A' });
    });

    it('follows a merge from an identity, so no work lands under a client that was emptied', () => {
      const workspace = holding(
        [
          { id: 'client-1', name: 'Acme Studio', mergedIntoId: 'client-2' },
          { id: 'client-2', name: 'Acme Group' },
        ],
        [{ namespace: NAMESPACE, externalId: 'ghd-studio', clientId: 'client-1' }],
      );

      const result = plan({ Clients: clientsTab('Whatever It Is Called Now') }, workspace);

      expect(messages(result)).toEqual([]);
      expect(result.resolutions.clients.get('CLI-A')).toEqual({
        kind: 'existing',
        id: 'client-2',
      });
    });

    it('lets one client carry an identity from a second source', () => {
      const other = '11111111-2222-3333-4444-555555555555';
      const workspace = holding(
        [{ id: 'client-1', name: 'Acme Studio' }],
        [{ namespace: NAMESPACE, externalId: 'ghd-studio', clientId: 'client-1' }],
      );

      const result = plan({ Clients: clientsTab('Acme Studio', other, 'acme-42') }, workspace);

      expect(messages(result)).toEqual([]);
      expect(result.clientIdentities).toEqual([
        {
          row: 2,
          clientKey: 'CLI-A',
          namespace: `campaign-playbook:${other}`,
          externalId: 'acme-42',
        },
      ]);
    });

    it('reads the source case-insensitively and the id exactly', () => {
      const workspace = holding(
        [{ id: 'client-1', name: 'Renamed Here' }],
        [{ namespace: NAMESPACE, externalId: 'ghd-studio', clientId: 'client-1' }],
      );

      // The same source in capitals is the same source.
      expect(
        plan({ Clients: clientsTab('Whatever', SOURCE.toUpperCase()) }, workspace).skipped[0],
      ).toMatchObject({ existingId: 'client-1', reason: SKIP_REASON.clientIdentity });
      // A different capitalisation of the id is a different id, so this one is new here.
      const other = plan({ Clients: clientsTab('Whatever', SOURCE, 'GHD-Studio') }, workspace);
      expect(other.clients.map((client) => client.name)).toEqual(['Whatever']);
      expect(other.clientIdentities[0]).toMatchObject({ externalId: 'GHD-Studio' });
    });

    it('refuses one identity column without the other, naming the one that is missing', () => {
      expect(
        messages(plan({ Clients: clientsTab('Acme Studio', SOURCE, '') }, emptyWorkspace()))[0],
      ).toBe(
        'Clients 2 client_import_id is required alongside client_import_source. Give this client the id it has at that source, or clear both columns.',
      );
      expect(
        messages(
          plan({ Clients: clientsTab('Acme Studio', '', 'ghd-studio') }, emptyWorkspace()),
        )[0],
      ).toBe(
        'Clients 2 client_import_source is required alongside client_import_id. Name the source this id belongs to, or clear both columns.',
      );
    });

    it('refuses a source that is not a UUID, because a label would be renamed too', () => {
      expect(
        messages(plan({ Clients: clientsTab('Acme Studio', 'dana-sheet') }, emptyWorkspace()))[0],
      ).toBe(
        'Clients 2 client_import_source: expected the source as a UUID, for example 7f1c0a4e-2b8d-4f3a-9c15-6a0d8e2b41f7.',
      );
    });

    it('refuses two rows of one workbook claiming the same identity', () => {
      const result = plan(
        {
          Clients: [
            ...clientsTab('Acme Studio'),
            ['CLI-B', 'Beta Studio', '', '', '', '', '', SOURCE, 'ghd-studio'],
          ],
        },
        emptyWorkspace(),
      );

      expect(messages(result)).toEqual([
        'Clients 3 Row 2 already claims the identity ghd-studio at this source. One identity names one client.',
      ]);
      expect(result.clientIdentities).toHaveLength(1);
    });

    it('leaves a workbook with neither column matching by name, exactly as before', () => {
      const workspace = holding([{ id: 'client-1', name: 'Acme Studio' }]);

      const result = plan(undefined, workspace);

      expect(messages(result)).toEqual([]);
      expect(result.clientIdentities).toEqual([]);
      expect(result.skipped[0]).toMatchObject({ reason: SKIP_REASON.client });
    });
  });
});
