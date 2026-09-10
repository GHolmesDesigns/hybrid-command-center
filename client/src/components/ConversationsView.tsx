import { useCallback, useEffect, useState } from 'react';
import { Archive, ArrowDown, MessageSquare, Send } from 'lucide-react';
import { api, send } from '../api';
import { PageHead } from './Shell';

type Conversation = {
  id: string;
  title: string;
  state: 'ACTIVE' | 'ARCHIVED';
  scope: { type: string; id: string | null };
  participants: string[];
  messageCount: number;
  updatedAt: string;
};
type Message = {
  id: string;
  senderLabel: string;
  sentAt: string;
  body: string;
  provenance: 'UNKNOWN' | 'ASSERTED' | 'VERIFIED';
};
type Page<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };

export function ConversationsView({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [state, setState] = useState<'ACTIVE' | 'ARCHIVED'>('ACTIVE');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const load = useCallback(async () => {
    try {
      setConversations(
        (await api<Page<Conversation>>(`/agent-conversations?state=${state}`)).items,
      );
    } catch (error) {
      flash((error as Error).message, 'error');
    }
  }, [flash, state]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = async (conversation: Conversation) => {
    setSelected(conversation);
    const page = await api<Page<Message>>(
      `/agent-conversations/${conversation.id}/messages?limit=50&direction=before`,
    );
    setMessages(page.items);
    setOlder(page.nextCursor);
  };
  const post = async () => {
    if (!selected || !body.trim()) return;
    const message = await send<Message>(`/agent-conversations/${selected.id}/messages`, 'POST', {
      body,
    });
    setMessages((current) => [...current, message]);
    setBody('');
    await load();
  };
  const archive = async () => {
    if (!selected) return;
    if (!window.confirm('Archive this conversation?')) return;
    await send(`/agent-conversations/${selected.id}/archive`, 'POST');
    setSelected(null);
    await load();
  };
  const loadOlder = async () => {
    if (!selected || !older) return;
    const page = await api<Page<Message>>(
      `/agent-conversations/${selected.id}/messages?limit=50&direction=before&cursor=${encodeURIComponent(older)}`,
    );
    setMessages((current) => [...page.items, ...current]);
    setOlder(page.nextCursor);
  };
  return (
    <div className="page">
      <PageHead
        eyebrow="Agents"
        title="Conversations"
        body="Review and respond to agent threads with frozen message provenance."
      />
      <div className="split-layout">
        <section className="card" aria-label="Conversation list">
          <div className="card-head">
            <h2>
              <MessageSquare /> Threads
            </h2>
            <select
              aria-label="Conversation state"
              value={state}
              onChange={(event) => setState(event.target.value as typeof state)}
            >
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </select>
          </div>
          {conversations.length === 0 && <p className="empty">No conversations.</p>}
          {conversations.map((conversation) => (
            <button
              className={`list-row ${selected?.id === conversation.id ? 'selected' : ''}`}
              key={conversation.id}
              onClick={() => void open(conversation)}
            >
              <strong>{conversation.title}</strong>
              <span>
                {conversation.scope.type} · {conversation.messageCount} messages
              </span>
              <small>{conversation.participants.join(', ')}</small>
            </button>
          ))}
        </section>
        {selected && (
          <section className="card" aria-label="Conversation detail">
            <div className="card-head">
              <div>
                <h2>{selected.title}</h2>
                <p>
                  {selected.scope.type} · {selected.participants.join(', ')}
                </p>
              </div>
              {selected.state === 'ACTIVE' && (
                <button className="secondary-btn" onClick={() => void archive()}>
                  <Archive /> Archive
                </button>
              )}
            </div>
            <div className="conversation-messages">
              {older && (
                <button className="secondary-btn" onClick={() => void loadOlder()}>
                  <ArrowDown /> Load older
                </button>
              )}
              {messages.map((message) => (
                <article className="conversation-message" key={message.id}>
                  <div>
                    <strong>{message.senderLabel}</strong>
                    <span className={`provenance ${message.provenance.toLowerCase()}`}>
                      {message.provenance}
                    </span>
                    <time>{new Date(message.sentAt).toLocaleString()}</time>
                  </div>
                  <p>{message.body}</p>
                </article>
              ))}
            </div>
            {selected.state === 'ACTIVE' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void post();
                }}
                className="conversation-compose"
              >
                <textarea
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  maxLength={4000}
                  placeholder="Write an operator reply"
                  aria-label="Message"
                />
                <button className="primary-btn" type="submit">
                  <Send /> Send
                </button>
              </form>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
