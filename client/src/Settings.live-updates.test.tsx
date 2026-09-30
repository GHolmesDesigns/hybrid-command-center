import {
  App,
  MemoryRouter,
  describe,
  expect,
  fireEvent,
  it,
  render,
  requests,
  screen,
  testState,
} from './App.test-setup';

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
};

const liveUpdatesCard = () =>
  screen.getByRole('heading', { name: 'Live updates' }).closest('.settings-card')!;

describe('Live updates settings', () => {
  it('saves enabled live updates from settings', async () => {
    testState.liveTipsPayload = { enabled: false };
    await renderSettings();

    const enabled = screen.getByLabelText('Enable live updates');
    expect(enabled).not.toBeChecked();
    fireEvent.click(enabled);
    expect(enabled).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Save live updates' }));
    expect(await screen.findByText(/Live updates saved/i)).toBeVisible();
    expect(
      requests.find(
        (request) =>
          request.method === 'PUT' && request.url.endsWith('/api/settings/agent-hub-live-tips'),
      )?.body,
    ).toEqual({ enabled: true });
    expect(testState.liveTipsPayload).toEqual({ enabled: true });
  });

  it('turns live updates off from the reset control', async () => {
    testState.liveTipsPayload = { enabled: true };
    await renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save live updates' }));
    expect(await screen.findByText(/Live updates saved/i)).toBeVisible();
    expect(testState.liveTipsPayload).toEqual({ enabled: false });
  });

  it('shows required copy while Command AI assistant is enabled', async () => {
    testState.commandAiAssistantPayload = {
      assistant: {
        enabled: true,
        provider: 'openai',
        model: 'gpt-4o-mini',
        dailyTurnCap: 100,
        dailyTokenCap: 300_000,
        scopes: ['workspace:read', 'workspace:write'],
      },
      key: { provider: 'openai', hasKey: true, keyLast4: '1234' },
      ready: true,
    };
    await renderSettings();

    expect(liveUpdatesCard()).toHaveTextContent('Required while Command AI is on.');
    expect(screen.getByLabelText('Enable live updates')).toBeDisabled();
  });
});
