import {
  DEFAULT_BRANDING,
  MemoryRouter,
  App,
  afterEach,
  describe,
  expect,
  fireEvent,
  it,
  render,
  screen,
  setBranding,
  testState,
  vi,
  waitFor,
  requests,
} from './App.test-setup';
import { meetsAaText } from '../../shared/contrast';

const renderSettings = async () => {
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <App />
    </MemoryRouter>,
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await waitFor(() =>
    expect(requests.some((request) => request.url.endsWith('/api/settings/drive'))).toBe(true),
  );
};

const sidebar = () => document.querySelector('aside.sidebar') as HTMLElement;
const paletteOf = (element: HTMLElement, property: string) =>
  element.style.getPropertyValue(property).trim();
const saveButton = () => screen.getByRole('button', { name: 'Save branding' });
const brandingPuts = () =>
  requests.filter((r) => r.method === 'PUT' && r.url.endsWith('/api/settings/branding'));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => vi.restoreAllMocks());

describe('sidebar branding', () => {
  it('paints the sidebar with the stored colours and their derived values', async () => {
    setBranding({ background: '#2b0f3a', foreground: '#ffe9ff', accent: '#f0c419' });
    await renderSettings();

    const aside = sidebar();
    expect(paletteOf(aside, '--sidebar-bg')).toBe('#2b0f3a');
    expect(paletteOf(aside, '--sidebar-fg')).toBe('#ffe9ff');
    expect(paletteOf(aside, '--sidebar-accent')).toBe('#f0c419');
    // The mark's lettering and secondary labels are derived, never chosen, so no palette
    // can produce a sidebar whose own text fails AA.
    expect(paletteOf(aside, '--sidebar-mark-ink')).toBe('#2b0f3a');
    expect(meetsAaText(paletteOf(aside, '--sidebar-muted'), '#2b0f3a')).toBe(true);
  });

  it('shows the logo with its alt text, and keeps the mark when none is set', async () => {
    setBranding({ logoUrl: 'https://cdn.example.com/logo.svg', logoAlt: 'GHolmes Designs' });
    await renderSettings();

    const logo = screen.getAllByRole('img', { name: 'GHolmes Designs' })[0];
    expect(logo).toHaveAttribute('src', 'https://cdn.example.com/logo.svg');
    expect(sidebar().querySelector('.brand-mark')).toBeNull();
  });

  it('links the brand mark to the company site without a new-tab icon', async () => {
    await renderSettings();

    const link = sidebar().querySelector<HTMLAnchorElement>('.brand-mark-link');
    expect(link).not.toBeNull();
    expect(link).toHaveAttribute('href', 'https://gholmesdesigns.com');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAccessibleName('Open Test Command Center website in a new tab');
    expect(link?.querySelector('.brand-new-tab')).toBeNull();
    expect(link?.querySelector('svg')).toBeNull();
    expect(link?.querySelector('.brand-mark')).toHaveTextContent('TC');
  });

  it('falls back to the text mark when the logo address stops loading', async () => {
    setBranding({ logoUrl: 'https://cdn.example.com/gone.svg', logoAlt: 'GHolmes Designs' });
    await renderSettings();

    fireEvent.error(sidebar().querySelector('.brand-logo')!);

    await waitFor(() => {
      expect(sidebar().querySelector('.brand-mark')).toHaveTextContent('TC');
      expect(sidebar().querySelector('.brand-logo')).toBeNull();
    });
  });

  it('renders the text mark when no logo is set', async () => {
    await renderSettings();

    expect(sidebar().querySelector('.brand-mark')).toHaveTextContent('TC');
    expect(sidebar().querySelector('.brand-logo')).toBeNull();
  });
});

describe('branding settings form', () => {
  it('reports when Drive status cannot be loaded', async () => {
    testState.driveSettingsError = 'Drive settings are temporarily unavailable.';

    await renderSettings();

    expect(await screen.findByRole('alert')).toHaveTextContent('Drive status unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Drive settings are temporarily unavailable.',
    );
  });

  it('reports each contrast pair in words and blocks a failing save', async () => {
    await renderSettings();

    type('Sidebar text hex value', '#2a3330');

    const failing = screen.getByText('Sidebar text on the sidebar background').closest('li')!;
    expect(failing).toHaveTextContent('Fails AA');
    expect(screen.getByText('Accent on the sidebar background').closest('li')).toHaveTextContent(
      'Passes AA',
    );
    expect(saveButton()).toBeDisabled();
    expect(screen.getByText(/Saving is blocked/)).toBeVisible();
    // Blocked in the form and never attempted, so the stored sidebar is untouched.
    fireEvent.submit(failing.closest('form')!);
    expect(await screen.findByText(/WCAG AA needs 4.5:1/)).toBeVisible();
    expect(brandingPuts()).toEqual([]);
  });

  it('saves colours and a logo once every reading passes', async () => {
    await renderSettings();

    type('Sidebar background hex value', '#FFFFFF');
    type('Sidebar text hex value', '#202522');
    type('Accent hex value', '#315f79');
    type(/Logo address/, 'https://cdn.example.com/logo.svg');
    type(/Logo alt text/, 'GHolmes Designs');
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    await waitFor(() => expect(brandingPuts()).toHaveLength(1));
    expect(brandingPuts()[0].body).toMatchObject({
      background: '#FFFFFF',
      foreground: '#202522',
      accent: '#315f79',
      logoUrl: 'https://cdn.example.com/logo.svg',
      logoAlt: 'GHolmes Designs',
    });
  });

  it('will not save a logo nobody could hear described', async () => {
    await renderSettings();

    type(/Logo address/, 'https://cdn.example.com/logo.svg');

    expect(screen.getByRole('alert')).toHaveTextContent('Describe the logo');
    expect(saveButton()).toBeDisabled();
    expect(brandingPuts()).toEqual([]);
  });

  it('edits the mark, title, subtitle, tagline, and a colour picker directly', async () => {
    await renderSettings();

    type('Mark', 'GD');
    type('Title', 'Growth Dashboard');
    type('Subtitle', 'Ops at a glance');
    type('Tagline', 'Ship steady');
    fireEvent.change(screen.getByLabelText('Sidebar background'), {
      target: { value: '#123456' },
    });
    expect(screen.getByLabelText('Mark')).toHaveValue('GD');
    expect(screen.getByLabelText('Title')).toHaveValue('Growth Dashboard');
    expect(screen.getByLabelText('Subtitle')).toHaveValue('Ops at a glance');
    expect(screen.getByLabelText('Tagline')).toHaveValue('Ship steady');
    expect(screen.getByLabelText('Sidebar background')).toHaveValue('#123456');
  });

  it('restores every field to the defaults', async () => {
    await renderSettings();

    type('Sidebar background hex value', '#2b0f3a');
    type(/Logo address/, 'https://cdn.example.com/logo.svg');
    fireEvent.click(
      screen
        .getByRole('heading', { name: 'Branding' })
        .closest('.settings-card')!
        .querySelector('button.secondary')!,
    );

    expect(screen.getByLabelText('Sidebar background hex value')).toHaveValue(
      DEFAULT_BRANDING.background,
    );
    expect(screen.getByLabelText('Accent hex value')).toHaveValue(DEFAULT_BRANDING.accent);
    expect(screen.getByLabelText(/Logo address/)).toHaveValue('');
    expect(screen.getByLabelText('Mark')).toHaveValue(DEFAULT_BRANDING.mark);
    expect(screen.getByLabelText('Tagline')).toHaveValue(DEFAULT_BRANDING.tagline);

    fireEvent.click(saveButton());
    await waitFor(() => expect(brandingPuts()).toHaveLength(1));
    expect(brandingPuts()[0].body).toEqual(DEFAULT_BRANDING);
  });
});
