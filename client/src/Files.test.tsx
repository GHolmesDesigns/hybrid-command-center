import {
  MemoryRouter,
  branding,
  describe,
  driveFile,
  driveFolder,
  driveListing,
  expect,
  fireEvent,
  it,
  project,
  render,
  requests,
  screen,
  testState,
  waitFor,
  within,
  App,
} from './App.test-setup';

const openFiles = async (entry = '/files?project=p1') => {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText(branding.title);
  return screen.findByRole('heading', { level: 1, name: 'Files' });
};

/** Every request the page made for a listing, in order. */
const listingCalls = () =>
  requests.filter((call) => call.method === 'GET' && call.url.includes('/files?'));

describe('Files module', () => {
  it('links Files from the sidebar, alongside the calendar that used to be unbuilt', async () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );

    await screen.findByText(branding.title);
    expect(screen.getByRole('link', { name: 'Files' })).toHaveAttribute('href', '/files');
    expect(screen.getByRole('link', { name: 'Calendar' })).toHaveAttribute('href', '/calendar');
    // Nothing is parked under "Coming next" any more; the divider goes with the last stub.
    expect(screen.queryByText('Coming next')).toBeNull();
  });

  it('lists a folder, shows what each row is, and opens every row in Drive', async () => {
    testState.driveListingPayload = () =>
      driveListing({
        files: [
          driveFolder('folder-p1-admin', '01_Admin'),
          driveFile('f1', 'Creative brief.pdf'),
          driveFile('f2', 'Cutdown.mp4', { mimeType: 'video/mp4', size: 15_728_640 }),
        ],
      });
    await openFiles();

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Creative brief.pdf')).toBeVisible();
    expect(within(table).getByText('PDF')).toBeVisible();
    expect(within(table).getByText('Video')).toBeVisible();
    expect(within(table).getByText('15 MB')).toBeVisible();
    // A Google-native item and a folder report no size, which is not a zero-byte file.
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);
    expect(
      within(table).getByRole('link', { name: 'Open Creative brief.pdf in Drive' }),
    ).toHaveAttribute('href', 'https://drive.test/file/f1');
  });

  it('pages forward with the cursor the server sent and appends to the list', async () => {
    testState.driveListingPayload = (_projectId, query) =>
      query.get('pageToken') === 'page-2'
        ? driveListing({ files: [driveFile('f2', 'Second page.pdf')], nextPageToken: null })
        : driveListing({ files: [driveFile('f1', 'First page.pdf')], nextPageToken: 'page-2' });
    await openFiles();

    await screen.findByText('First page.pdf');
    fireEvent.click(screen.getByRole('button', { name: /Show 25 more/ }));

    await screen.findByText('Second page.pdf');
    // Appended, not replaced: paging forward never loses the rows already read.
    expect(screen.getByText('First page.pdf')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Show 25 more/ })).toBeNull();
    expect(listingCalls().at(-1)?.url).toContain('pageToken=page-2');
  });

  it('browses into a subfolder of the same project and records it in the address', async () => {
    testState.driveListingPayload = (_projectId, query) =>
      query.get('folderId') === 'folder-p1-admin'
        ? driveListing({
            folder: { id: 'folder-p1-admin', name: '01_Admin', url: 'https://drive.test/admin' },
            files: [driveFile('f9', 'Statement of work.pdf')],
          })
        : driveListing({ files: [driveFolder('folder-p1-admin', '01_Admin')] });
    await openFiles();

    fireEvent.click(await screen.findByRole('button', { name: '01_Admin' }));

    await screen.findByText('Statement of work.pdf');
    expect(listingCalls().at(-1)?.url).toContain('folderId=folder-p1-admin');
    expect((screen.getByLabelText('Folder') as HTMLSelectElement).value).toBe('folder-p1-admin');
  });

  it('says a folder is empty rather than showing an empty table', async () => {
    testState.driveListingPayload = () => driveListing({ files: [] });
    await openFiles();

    expect(await screen.findByText('This folder is empty')).toBeVisible();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('tells the user which Drive problem they have, with a different step for each', async () => {
    const cases = [
      ['NOT_CONFIGURED', /not set up on this computer/],
      ['NOT_CONNECTED', /not connected/],
      ['NO_FOLDER', /has no Drive folder yet/],
      ['FAILED', /could not list this folder/],
    ] as const;
    for (const [state, message] of cases) {
      testState.driveListingPayload = () =>
        driveListing({ state, folder: null, error: state === 'FAILED' ? 'Rate limited' : null });
      const view = render(
        <MemoryRouter initialEntries={['/files?project=p1']}>
          <App />
        </MemoryRouter>,
      );
      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.queryByRole('table')).toBeNull();
      view.unmount();
    }
  });

  it('retries a failed listing without changing the folder', async () => {
    let attempts = 0;
    testState.driveListingPayload = () => {
      attempts += 1;
      return attempts === 1
        ? driveListing({ state: 'FAILED', error: 'Rate limited' })
        : driveListing({ files: [driveFile('f1', 'Recovered.pdf')] });
    };
    await openFiles();

    expect(await screen.findByText('Rate limited')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));

    expect(await screen.findByText('Recovered.pdf')).toBeVisible();
  });

  it('reloads when another project is chosen, and drops the folder that belonged to the last one', async () => {
    testState.driveListingPayload = (projectId) =>
      driveListing({
        projectId,
        files: [driveFile(`${projectId}-file`, `${projectId} brief.pdf`)],
      });
    await openFiles('/files?project=p1&folder=folder-p1-admin');
    await screen.findByText('p1 brief.pdf');

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p2' } });

    await screen.findByText('p2 brief.pdf');
    expect(listingCalls().at(-1)?.url).toContain('/api/projects/p2/files');
    expect(listingCalls().at(-1)?.url).not.toContain('folderId');
  });

  it('offers no way to change a file, and says deletion leaves Drive alone', async () => {
    testState.driveListingPayload = () =>
      driveListing({ files: [driveFile('f1', 'Creative brief.pdf')] });
    await openFiles();
    await screen.findByRole('table');

    for (const forbidden of [/upload/i, /delete/i, /rename/i, /move/i, /download/i])
      expect(screen.queryByRole('button', { name: forbidden })).toBeNull();
    expect(screen.getByText(/never touches a Drive file/)).toBeVisible();
    // Read-only means read-only at the wire too: the page only ever issues GETs.
    expect(requests.every((call) => call.method === 'GET')).toBe(true);
  });

  it('sends the user to Projects when there is nothing to browse', async () => {
    testState.projectsPayload = [project('p3', 'Old retainer', 'ARCHIVED')];
    await openFiles('/files');

    expect(await screen.findByText('No projects to browse')).toBeVisible();
    expect(screen.getByRole('link', { name: /Go to Projects/ })).toHaveAttribute(
      'href',
      '/projects',
    );
    await waitFor(() => expect(listingCalls()).toHaveLength(0));
  });
});
