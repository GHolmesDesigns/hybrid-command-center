import {
  MemoryRouter,
  describe,
  emptySignalImportCounts,
  expect,
  fireEvent,
  it,
  render,
  requests,
  screen,
  signalPreview,
  testState,
  within,
  App,
} from './App.test-setup';

const openSignalImport = async () => {
  render(
    <MemoryRouter initialEntries={['/import']}>
      <App />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Import Signal queue/ }));
  return screen.getByRole('dialog');
};

const pasteAndCheck = async (dialog: HTMLElement) => {
  fireEvent.change(within(dialog).getByLabelText('Or paste the tabs'), {
    target: {
      value:
        '[SignalPosts]\npost_key\ttext\nPOST-1\tImported copy\n[SignalMedia]\npost_key\tmedia_order\tsource\turl\nPOST-1\t1\tDRIVE\thttps://drive.google.com/file/d/abc/view',
    },
  });
  fireEvent.click(within(dialog).getByRole('button', { name: /Check Signal import/ }));
};

describe('Signal import modal', () => {
  it('shows resolved Drive media in the preview and blocks when a file did not bind', async () => {
    testState.signalImportPreviewPayload = signalPreview({
      ok: false,
      creates: { ...emptySignalImportCounts(), SignalPosts: 1, SignalMedia: 1 },
      driveNamed: 1,
      driveResolved: 0,
      resolvedMedia: [
        {
          sheet: 'SignalMedia',
          row: 2,
          postKey: 'POST-1',
          order: 1,
          source: 'DRIVE',
          url: 'https://drive.google.com/file/d/abc/view',
          resolved: false,
        },
      ],
      issues: [
        {
          sheet: 'SignalMedia',
          row: 2,
          message: 'Drive could not return that file: File not found: abc',
        },
      ],
    });
    const dialog = await openSignalImport();
    await pasteAndCheck(dialog);

    expect(await within(dialog).findByText('1 problems to fix first')).toBeVisible();
    expect(within(dialog).getByText(/Resolved 0 of 1 Drive files/)).toBeVisible();
    expect(within(dialog).getByText('Drive file did not resolve')).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Fix problems first/ })).toBeDisabled();
    expect(requests.filter((call) => call.url.endsWith('/api/import/signal'))).toHaveLength(0);
  });

  it('lists Drive name, type, size, and resolution time for a clean preview', async () => {
    testState.signalImportPreviewPayload = signalPreview({
      driveNamed: 1,
      driveResolved: 1,
      resolvedMedia: [
        {
          sheet: 'SignalMedia',
          row: 2,
          postKey: 'POST-1',
          order: 1,
          source: 'DRIVE',
          url: 'https://drive.google.com/file/d/abc/view',
          resolved: true,
          driveName: 'launch.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 4096,
          resolvedAt: '2026-08-24T12:00:00.000Z',
        },
      ],
    });
    testState.signalImportCommitPayload = {
      status: 200,
      body: {
        preview: signalPreview({
          driveNamed: 1,
          driveResolved: 1,
          resolvedMedia: [
            {
              sheet: 'SignalMedia',
              row: 2,
              postKey: 'POST-1',
              order: 1,
              source: 'DRIVE',
              url: 'https://drive.google.com/file/d/abc/view',
              resolved: true,
              driveName: 'launch.mp4',
              mimeType: 'video/mp4',
              sizeBytes: 4096,
              resolvedAt: '2026-08-24T12:00:00.000Z',
            },
          ],
        }),
        receipt: {
          id: 'receipt-1',
          source: 'signal-import',
          inputKind: 'text',
          outcome: 'COMMITTED',
          createdCount: 2,
          updatedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          creates: { ...emptySignalImportCounts(), SignalPosts: 1, SignalMedia: 1 },
          updates: emptySignalImportCounts(),
          skips: emptySignalImportCounts(),
          created: [{ sheet: 'SignalPosts', row: 2, key: 'POST-1', label: 'Imported copy' }],
          updated: [],
          skipped: [],
          issues: [],
          createdAt: '2026-08-24T12:01:00.000Z',
        },
      },
    };
    const dialog = await openSignalImport();
    await pasteAndCheck(dialog);

    expect(await within(dialog).findByText('Ready to import')).toBeVisible();
    expect(within(dialog).getByText('launch.mp4')).toBeVisible();
    expect(within(dialog).getByText(/video\/mp4 · 4\.0 KB/)).toBeVisible();
    expect(within(dialog).getByText(/resolved 2026-08-24T12:00:00.000Z/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: /Import 2 records/ }));
    expect(await within(dialog).findByText('Imported 2 records')).toBeVisible();
  });
});
