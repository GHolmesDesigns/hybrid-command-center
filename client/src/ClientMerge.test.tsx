import { useLocation } from 'react-router-dom';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  MemoryRouter,
  describe,
  expect,
  it,
  App,
  client,
  project,
  requests,
  testState,
} from './App.test-setup';
import { CLIENT_MERGE_NOTICES } from '../../shared/client-merge';

const source = client('client-duplicate', 'Duplicate Studio', 'ARCHIVED');
const destination = client('client-survivor', 'Surviving Studio');
const other = client('client-other', 'Another Studio');
const sourceProject = project('project-moving', 'Spring Campaign', 'ACTIVE', {
  clientId: source.id,
  clientName: source.name,
});
const sourceArchivedProject = project('project-old', 'Retired Campaign', 'ARCHIVED', {
  clientId: source.id,
  clientName: source.name,
});

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="Current location">{location.pathname}</output>;
}

const renderApp = (entry: string) =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <App />
      <LocationProbe />
    </MemoryRouter>,
  );

/** Opens the dialog from a client's own page, which is the only place it is offered. */
async function openMergeDialog(from = source) {
  renderApp(`/clients/${from.id}`);
  fireEvent.click(await screen.findByRole('button', { name: 'Merge client' }));
  return screen.getByRole('dialog');
}

describe('Merging one client into another', () => {
  it('offers only live, unmerged clients as destinations', async () => {
    const merged = client('client-merged', 'Already Merged', 'ARCHIVED', {
      mergedInto: { id: other.id, name: other.name, mergedAt: '2026-08-01T00:00:00.000Z' },
    });
    const archived = client('client-archived', 'Just Archived', 'ARCHIVED');
    testState.clientsPayload = [source, destination, other, merged, archived];
    testState.projectsPayload = [sourceProject];

    const dialog = await openMergeDialog();

    const picker = within(dialog).getByLabelText('Merge into');
    expect(within(picker).getByRole('option', { name: destination.name })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: other.name })).toBeInTheDocument();
    // Not itself, not an archived client, and not a client that was already merged away.
    for (const excluded of [source.name, merged.name, archived.name])
      expect(within(picker).queryByRole('option', { name: excluded })).toBeNull();
  });

  it('previews before it writes, naming every project and what a merge will not do', async () => {
    testState.clientsPayload = [source, destination];
    testState.projectsPayload = [sourceProject, sourceArchivedProject];

    const dialog = await openMergeDialog();
    // Confirm is unusable until a plan is on screen.
    expect(within(dialog).getByRole('button', { name: /Merge clients/ })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Merge into'), {
      target: { value: destination.id },
    });

    const plan = await within(dialog).findByLabelText('Merge preview');
    expect(
      within(plan).getByRole('heading', { name: `${source.name} → ${destination.name}` }),
    ).toBeVisible();
    // Archived and active projects alike, because all of them move.
    expect(within(plan).getByText(sourceProject.name)).toBeVisible();
    expect(within(plan).getByText(sourceArchivedProject.name)).toBeVisible();
    expect(within(plan).getByText(/2 projects will move/)).toBeVisible();
    for (const notice of CLIENT_MERGE_NOTICES) expect(within(plan).getByText(notice)).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Merge clients/ })).toBeEnabled();
    // A preview is a read: no merge was posted.
    expect(requests.some((call) => call.url.endsWith(`/api/clients/${source.id}/merge`))).toBe(
      false,
    );
  });

  /**
   * C70. An import identity is the other thing that points at a client, and the merge moves it. The
   * dialog lists each one rather than counting them: which id follows the work is the fact a later
   * playbook turns on, and an identity nobody expected on this client is worth seeing beforehand.
   */
  it('lists the import identities that will move with the work', async () => {
    testState.clientsPayload = [source, destination];
    testState.projectsPayload = [sourceProject];
    testState.clientImportAliases = [
      { namespace: 'campaign-playbook:9d3f1c62', externalId: 'ghd-studio', clientId: source.id },
      {
        namespace: 'campaign-playbook:9d3f1c62',
        externalId: 'kept-here',
        clientId: destination.id,
      },
    ];

    const dialog = await openMergeDialog();
    fireEvent.change(within(dialog).getByLabelText('Merge into'), {
      target: { value: destination.id },
    });

    const plan = await within(dialog).findByLabelText('Merge preview');
    expect(within(plan).getByText(/One import identity moves/)).toBeVisible();
    const moving = within(plan).getByLabelText('Import identities that move');
    expect(within(moving).getByText('ghd-studio')).toBeVisible();
    // The destination's own identity is not moving anywhere and is not listed.
    expect(within(moving).queryByText('kept-here')).toBeNull();
  });

  it('says nothing about identities when the source carries none', async () => {
    testState.clientsPayload = [source, destination];
    testState.projectsPayload = [sourceProject];

    const dialog = await openMergeDialog();
    fireEvent.change(within(dialog).getByLabelText('Merge into'), {
      target: { value: destination.id },
    });

    const plan = await within(dialog).findByLabelText('Merge preview');
    expect(within(plan).queryByLabelText('Import identities that move')).toBeNull();
    // The fixed notice about identities is still there — it says what a merge does, not what this
    // one will do — so what is absent is the list and the sentence introducing it.
    expect(within(plan).queryByText(/import identity moves|import identities move/)).toBeNull();
  });

  it('confirms with the previewed plan, then lands on the surviving client', async () => {
    testState.clientsPayload = [source, destination];
    testState.projectsPayload = [sourceProject];

    const dialog = await openMergeDialog();
    fireEvent.change(within(dialog).getByLabelText('Merge into'), {
      target: { value: destination.id },
    });
    await within(dialog).findByLabelText('Merge preview');
    fireEvent.click(within(dialog).getByRole('button', { name: /Merge clients/ }));

    await waitFor(() =>
      expect(screen.getByLabelText('Current location')).toHaveTextContent(
        `/clients/${destination.id}`,
      ),
    );
    // The plan's own hash went back with the confirmation.
    expect(requests).toContainEqual({
      url: `/api/clients/${source.id}/merge`,
      method: 'POST',
      body: { destinationId: destination.id, planHash: `hash-${source.id}-1` },
    });
    expect(
      await screen.findByText(`${source.name} merged into ${destination.name}. 1 project moved.`),
    ).toBeVisible();
    // The survivor's page now lists the work that moved.
    expect(await screen.findByRole('heading', { name: destination.name })).toBeVisible();
    expect(screen.getByText(sourceProject.name)).toBeVisible();
  });

  it('shows a refusal in the dialog and re-previews after a stale plan', async () => {
    testState.clientsPayload = [source, destination];
    testState.projectsPayload = [sourceProject];

    const dialog = await openMergeDialog();
    fireEvent.change(within(dialog).getByLabelText('Merge into'), {
      target: { value: destination.id },
    });
    await within(dialog).findByLabelText('Merge preview');
    testState.clientMergeCommitError = {
      status: 409,
      error: 'These clients changed since this merge was previewed.',
    };
    fireEvent.click(within(dialog).getByRole('button', { name: /Merge clients/ }));

    expect(
      await within(dialog).findByText('These clients changed since this merge was previewed.'),
    ).toBeVisible();
    // Still open, still on the source, and the plan was read again for the next attempt.
    expect(screen.getByLabelText('Current location')).toHaveTextContent(`/clients/${source.id}`);
    await waitFor(() =>
      expect(
        requests.filter((call) => call.url.endsWith(`/api/clients/${source.id}/merge/preview`)),
      ).toHaveLength(2),
    );
  });

  it('surfaces a refused preview rather than enabling the confirmation', async () => {
    testState.clientsPayload = [source, destination];
    testState.clientMergePreviewError = {
      status: 409,
      error: 'Choose an active destination client.',
    };

    const dialog = await openMergeDialog();
    fireEvent.change(within(dialog).getByLabelText('Merge into'), {
      target: { value: destination.id },
    });

    expect(await within(dialog).findByText('Choose an active destination client.')).toBeVisible();
    expect(within(dialog).queryByLabelText('Merge preview')).toBeNull();
    expect(within(dialog).getByRole('button', { name: /Merge clients/ })).toBeDisabled();
  });

  it('explains itself when there is no client to merge into', async () => {
    testState.clientsPayload = [source];
    testState.projectsPayload = [sourceProject];
    renderApp(`/clients/${source.id}`);

    expect(await screen.findByRole('button', { name: 'Merge client' })).toBeDisabled();
    expect(
      screen.getByText(
        'Merge is unavailable: there is no other active client to move this work into.',
      ),
    ).toBeVisible();
  });
});

describe('A client that was merged away', () => {
  const merged = client('client-gone', 'Gone Studio', 'ARCHIVED', {
    mergedInto: {
      id: destination.id,
      name: destination.name,
      mergedAt: '2026-08-16T12:00:00.000Z',
    },
  });

  it('links to the survivor instead of offering Unarchive on its own page', async () => {
    testState.clientsPayload = [merged, destination];
    testState.projectsPayload = [];
    renderApp(`/clients/${merged.id}`);

    expect(
      await screen.findByText(`This client was merged into ${destination.name}`),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Unarchive client' })).toBeNull();
    // A merged client has nothing left to merge, so it is not offered the action either.
    expect(screen.queryByRole('button', { name: 'Merge client' })).toBeNull();

    fireEvent.click(screen.getByRole('link', { name: `Open ${destination.name}` }));
    expect(screen.getByLabelText('Current location')).toHaveTextContent(
      `/clients/${destination.id}`,
    );
  });

  it('shows a merged badge and no Unarchive button on its list card', async () => {
    const ordinary = client('client-plain', 'Plain Archived', 'ARCHIVED');
    testState.clientsPayload = [merged, ordinary, destination];
    renderApp('/clients?visibility=archived');

    await screen.findByRole('heading', { name: merged.name });
    expect(screen.getByText(`Merged into ${destination.name}`)).toBeVisible();
    expect(screen.queryByRole('button', { name: `Unarchive ${merged.name}` })).toBeNull();
    // An ordinarily archived client still gets its button.
    expect(screen.getByRole('button', { name: `Unarchive ${ordinary.name}` })).toBeVisible();
  });
});
