import {
  MemoryRouter,
  branding,
  describe,
  emptyCounts,
  expect,
  fireEvent,
  it,
  preview,
  receipt,
  render,
  requests,
  screen,
  testState,
  waitFor,
  within,
  App,
} from './App.test-setup';

const openImportModal = async () => {
  render(
    <MemoryRouter initialEntries={['/import']}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Import a playbook/ }));
  return screen.getByRole('dialog');
};

const pasteAndCheck = async (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText('Or paste the tabs'), {
    target: { value: '[Clients]\nclient_key\tname\nCLI-A\tAcme Studio' },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: /Check this playbook/ }));
};

describe('Import module', () => {
  it('links Import from the sidebar, collapsed or not, and leaves Calendar unbuilt', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.getByRole('link', { name: 'Import' })).toHaveAttribute('href', '/import');
    expect(screen.getByText('Calendar')).toHaveClass('nav-disabled');
  });

  it('keeps the shipped modules reachable when the sidebar is collapsed, unlike the unbuilt one', async () => {
    localStorage.setItem('hcc-sidebar-collapsed', '1');
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.getByRole('link', { name: 'Import' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Files' })).toBeVisible();
    expect(screen.queryByText('Calendar')).toBeNull();
  });

  it('points Settings at the shipped module rather than listing it as future work', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(screen.queryByText('Campaign playbook import')).toBeNull();
    // The card that used to list it as future work now points at the built module. The other
    // link with this name is the sidebar's, which every page carries.
    expect(
      within(screen.getByText(/Campaign playbook import has shipped/)).getByRole('link', {
        name: 'Import',
      }),
    ).toBeVisible();
  });

  it('says so plainly when no import has run yet', async () => {
    render(
      <MemoryRouter initialEntries={['/import']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
    expect(screen.getByText('No imports yet')).toBeVisible();
  });

  it('previews before it writes, and only enables the confirm button for a clean preview', async () => {
    testState.importPreviewPayload = preview({
      ok: false,
      creates: emptyCounts(),
      failures: { ...emptyCounts(), Tasks: 1 },
      created: [],
      issues: [
        {
          sheet: 'Tasks',
          row: 4,
          column: 'H',
          message: 'due_date: that is not a real calendar date.',
        },
      ],
    });
    const dialog = await openImportModal();
    await pasteAndCheck(dialog);

    expect(await within(dialog).findByText('1 row to fix first')).toBeVisible();
    expect(within(dialog).getByText('Tasks · row 4 · column H')).toBeVisible();
    expect(within(dialog).getByText('due_date: that is not a real calendar date.')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Fix 1 row first/ })).toBeDisabled();
    expect(
      within(dialog).getByText(/Importing is blocked until every problem above is fixed/),
    ).toBeVisible();
    // The dry run is the only write-side request that has been made.
    expect(requests.filter((call) => call.url.endsWith('/api/import/playbook'))).toHaveLength(0);
  });

  it('shows what will be skipped and the rule that decided it', async () => {
    testState.importPreviewPayload = preview({
      creates: { ...emptyCounts(), Tasks: 1 },
      skips: { ...emptyCounts(), Clients: 1 },
      skipped: [
        {
          sheet: 'Clients',
          row: 2,
          key: 'CLI-A',
          label: 'Acme Studio',
          reason: 'A client with this name already exists; the import will use it.',
          existingId: 'client-1',
        },
      ],
    });
    const dialog = await openImportModal();
    await pasteAndCheck(dialog);

    expect(await within(dialog).findByText('Ready to create 1 record')).toBeVisible();
    // The skipped rows are one summary away, so the list cannot bury the counts above it.
    const skips = within(dialog).getByText('1 row already in this workspace');
    expect(skips).toBeVisible();
    fireEvent.click(skips);
    expect(within(dialog).getByText('Acme Studio')).toBeVisible();
    expect(
      within(dialog).getByText(/A client with this name already exists/, { exact: false }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('What counts as already imported')).toBeVisible();
  });

  it('imports a clean playbook, reports the receipt, and reloads the list behind it', async () => {
    testState.importPreviewPayload = preview();
    testState.importCommitPayload = {
      status: 201,
      body: { receipt: receipt({ filename: 'spring.xlsx' }), preview: preview() },
    };
    const dialog = await openImportModal();
    await pasteAndCheck(dialog);
    fireEvent.click(await within(dialog).findByRole('button', { name: /Import 4 records/ }));

    expect(await within(dialog).findByText('Imported 4 records')).toBeVisible();
    // The commit carries the fingerprint the preview came back with, which is what makes the
    // server able to refuse a file that changed in between.
    const commit = requests.find((call) => call.url.endsWith('/api/import/playbook'))!;
    expect(commit.body.fingerprint).toBe('a'.repeat(64));
    expect(commit.body.text).toContain('[Clients]');
    expect(await screen.findByText(/Imported 4 records from the playbook/)).toBeVisible();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The receipt is on the page behind the modal, which reloaded its list when the import
    // wrote one — the point of keeping receipts server-side rather than in the modal.
    expect(await screen.findByText('spring.xlsx')).toBeVisible();
    expect(screen.getByText(/4 created · 0 skipped · 0 failed/)).toBeVisible();
  });

  it('does not claim success when the server refuses the commit', async () => {
    testState.importPreviewPayload = preview();
    testState.importCommitPayload = {
      status: 409,
      body: {
        receipt: receipt({
          outcome: 'REJECTED',
          createdCount: 0,
          failedCount: 1,
          creates: emptyCounts(),
          created: [],
          issues: [{ sheet: 'Clients', row: 2, message: 'name: needs at least 2 characters.' }],
        }),
        preview: preview({
          ok: false,
          creates: emptyCounts(),
          failures: { ...emptyCounts(), Clients: 1 },
          created: [],
          issues: [{ sheet: 'Clients', row: 2, message: 'name: needs at least 2 characters.' }],
        }),
        error: 'Fix the playbook first.',
      },
    };
    const dialog = await openImportModal();
    await pasteAndCheck(dialog);
    fireEvent.click(await within(dialog).findByRole('button', { name: /Import 4 records/ }));

    // The refusal replaces the stale clean preview with the reasons that came back with it.
    expect(await within(dialog).findByText('1 row to fix first')).toBeVisible();
    expect(within(dialog).getByText('name: needs at least 2 characters.')).toBeVisible();
    expect(within(dialog).queryByText(/^Imported /)).toBeNull();
    expect(within(dialog).getByRole('button', { name: /Fix 1 row first/ })).toBeDisabled();
  });

  it('keeps a past import readable after the modal is gone', async () => {
    testState.importReceiptsPayload = [
      receipt({
        id: 'receipt-old',
        outcome: 'FAILED',
        filename: 'broken.xlsx',
        inputKind: 'xlsx',
        createdCount: 0,
        skippedCount: 0,
        failedCount: 0,
        creates: emptyCounts(),
        created: [],
        error: 'disk is on fire',
      }),
    ];
    render(
      <MemoryRouter initialEntries={['/import']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText('broken.xlsx')).toBeVisible();
    expect(screen.getByText('Failed')).toBeVisible();
    fireEvent.click(screen.getByText('broken.xlsx'));
    expect(screen.getByText('disk is on fire')).toBeVisible();
  });
});
