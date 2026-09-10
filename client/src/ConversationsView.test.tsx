import { ConversationsView } from './components/ConversationsView';
import {
  afterEach,
  describe,
  expect,
  fireEvent,
  it,
  MemoryRouter,
  render,
  screen,
  vi,
} from './App.test-setup';

describe('ConversationsView', () => {
  afterEach(() => vi.restoreAllMocks());
  it('opens the newest messages, posts an operator reply, and archives', async () => {
    const conversation = {
      id: 'c1',
      title: 'Review',
      state: 'ACTIVE',
      scope: { type: 'freeform', id: null },
      participants: ['cursor'],
      messageCount: 1,
      updatedAt: '2026-09-10T12:00:00Z',
    };
    const message = {
      id: 'm1',
      senderLabel: 'cursor',
      sentAt: '2026-09-10T12:00:00Z',
      body: 'Hello',
      provenance: 'ASSERTED',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/messages') && init?.method === 'POST')
        return new Response(
          JSON.stringify({
            ...message,
            id: 'm2',
            senderLabel: 'operator',
            body: 'Reply',
            provenance: 'VERIFIED',
          }),
          { status: 201 },
        );
      if (url.includes('/archive'))
        return new Response(JSON.stringify({ ...conversation, state: 'ARCHIVED' }));
      if (url.includes('/messages'))
        return new Response(JSON.stringify({ items: [message], nextCursor: null, hasMore: false }));
      return new Response(
        JSON.stringify({ items: [conversation], nextCursor: null, hasMore: false }),
      );
    });
    render(
      <MemoryRouter>
        <ConversationsView flash={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Review')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    expect(await screen.findByText('Hello')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Reply')).toBeVisible();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Archive/ }));
    expect(await screen.findByText('Review')).toBeVisible();
    expect(screen.getByLabelText('Conversation state')).toHaveValue('ACTIVE');
  });
});
