import {
  App,
  MemoryRouter,
  afterEach,
  describe,
  expect,
  fireEvent,
  it,
  render,
  screen,
  testState,
  vi,
  within,
} from './App.test-setup';

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
};

afterEach(() => vi.restoreAllMocks());

describe('Command AI assistant settings', () => {
  it('disables live-updates controls while the assistant is enabled', async () => {
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
    testState.liveTipsPayload = { enabled: true };

    await renderSettings();

    expect(screen.getByLabelText('Enable live updates')).toBeDisabled();
    expect(screen.getByText(/Required while Command AI is on/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Command AI assistant' })).toBeVisible();
    expect(screen.getByLabelText('Assistant provider')).toHaveValue('openai');
    expect(screen.getByLabelText('Assistant API key')).toHaveAttribute(
      'placeholder',
      'Stored key ending in 1234',
    );
  });

  it('lists assistant credential scopes and lowers daily caps', async () => {
    await renderSettings();

    expect(screen.getByLabelText('Read workspace and Signal data')).toBeVisible();
    expect(screen.getByLabelText('Write workspace tasks and projects')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Daily turn cap'), { target: { value: '50' } });
    expect(screen.getByLabelText('Daily turn cap')).toHaveValue(50);
  });

  it('stores a new assistant api key from settings', async () => {
    await renderSettings();
    fireEvent.change(screen.getByLabelText('Assistant API key'), {
      target: { value: 'sk-test-key-for-assistant-settings' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    expect(await screen.findByText(/Command AI assistant saved/i)).toBeVisible();
  });

  it('submits assistant settings changes', async () => {
    await renderSettings();
    fireEvent.change(screen.getByLabelText('Daily turn cap'), { target: { value: '80' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    expect(await screen.findByText(/Command AI assistant saved/i)).toBeVisible();
  });

  it('resets assistant settings to defaults', async () => {
    await renderSettings();
    const section = screen
      .getByRole('heading', { name: 'Command AI assistant' })
      .closest('section');
    expect(section).toBeTruthy();
    fireEvent.change(within(section!).getByLabelText('Daily turn cap'), {
      target: { value: '25' },
    });
    fireEvent.click(within(section!).getByRole('button', { name: 'Reset to defaults' }));
    expect(within(section!).getByLabelText('Daily turn cap')).toHaveValue(100);
  });

  it('toggles assistant credential scopes before saving', async () => {
    await renderSettings();
    const writeScope = screen.getByLabelText('Write workspace tasks and projects');
    expect(writeScope).toBeChecked();
    fireEvent.click(writeScope);
    expect(writeScope).not.toBeChecked();
    fireEvent.click(writeScope);
    expect(writeScope).toBeChecked();
  });

  it('switches provider models when the provider changes', async () => {
    testState.commandAiAssistantPayload = {
      assistant: {
        enabled: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        dailyTurnCap: 100,
        dailyTokenCap: 300_000,
        scopes: ['workspace:read', 'workspace:write'],
      },
      key: { provider: 'openai', hasKey: false, keyLast4: null },
      ready: false,
    };
    await renderSettings();
    fireEvent.change(screen.getByLabelText('Assistant provider'), {
      target: { value: 'anthropic' },
    });
    expect(screen.getByLabelText('Assistant model')).toHaveValue('claude-sonnet-4-20250514');
  });

  it('shows the missing-key hint and keeps short keys from saving', async () => {
    testState.commandAiAssistantPayload = {
      assistant: {
        enabled: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        dailyTurnCap: 100,
        dailyTokenCap: 300_000,
        scopes: ['workspace:read', 'workspace:write'],
      },
      key: { provider: 'openai', hasKey: false, keyLast4: null },
      ready: false,
    };
    await renderSettings();
    expect(screen.getByText(/No key stored yet/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save API key' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Assistant API key'), { target: { value: 'short' } });
    expect(screen.getByRole('button', { name: 'Save API key' })).toBeDisabled();
  });

  it('enables the assistant and locks live updates after save', async () => {
    testState.commandAiAssistantPayload = {
      assistant: {
        enabled: false,
        provider: 'openai',
        model: 'gpt-4o-mini',
        dailyTurnCap: 100,
        dailyTokenCap: 300_000,
        scopes: ['workspace:read', 'workspace:write'],
      },
      key: { provider: 'openai', hasKey: true, keyLast4: '1234' },
      ready: false,
    };
    await renderSettings();
    fireEvent.click(screen.getByLabelText('Enable Command AI assistant'));
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    expect(await screen.findByText(/Command AI assistant saved/i)).toBeVisible();
    expect(screen.getByLabelText('Enable live updates')).toBeDisabled();
  });

  it('lowers the daily token cap before saving assistant settings', async () => {
    await renderSettings();
    fireEvent.change(screen.getByLabelText('Daily token cap'), { target: { value: '250000' } });
    expect(screen.getByLabelText('Daily token cap')).toHaveValue(250000);
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));
    expect(await screen.findByText(/Command AI assistant saved/i)).toBeVisible();
  });
});
