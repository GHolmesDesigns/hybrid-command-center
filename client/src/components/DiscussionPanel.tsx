import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Send } from 'lucide-react';
import { api, send } from '../api';

type Conversation = {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
  state: 'ACTIVE' | 'ARCHIVED';
};
type Message = { id: string; senderLabel: string; sentAt: string; body: string };
type Page<T> = { items: T[]; nextCursor: string | null };

export function DiscussionPanel({
  scopeType,
  scopeId,
  subjectLabel,
  subjectPath,
}: {
  scopeType: 'client' | 'project' | 'task';
  scopeId: string;
  subjectLabel: string;
  subjectPath: string;
}) {
  const [items, setItems] = useState<Conversation[]>([]),
    [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]),
    [body, setBody] = useState(''),
    [title, setTitle] = useState('');
  const load = useCallback(async () => {
    try {
      const page = await api<Page<Conversation>>(
        `/agent-conversations?state=ACTIVE&scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`,
      );
      setItems(page.items ?? []);
    } catch {
      setItems([]);
    }
  }, [scopeType, scopeId]);
  useEffect(() => {
    void load();
  }, [load]);
  const open = async (conversation: Conversation) => {
    setSelected(conversation);
    setMessages(
      (
        await api<Page<Message>>(
          `/agent-conversations/${conversation.id}/messages?limit=20&direction=before`,
        )
      ).items,
    );
  };
  const start = async () => {
    if (!title.trim()) return;
    const created = await send<Conversation>('/agent-conversations', 'POST', {
      title,
      scope: { type: scopeType, id: scopeId },
    });
    setTitle('');
    await load();
    await open(created);
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
  return (
    <section className="panel discussion-panel" aria-label={`${subjectLabel} discussion`}>
      <div className="section-title">
        <div>
          <span className="eyebrow">Discussion</span>
          <h2>
            <MessageSquare /> Threads
          </h2>
        </div>
        <Link
          className="buttonlike secondary"
          to={`/agents/conversations?scopeType=${scopeType}&scopeId=${scopeId}`}
        >
          Open all
        </Link>
      </div>
      {items.length === 0 && !selected && (
        <p className="empty">No discussion yet. Start a thread for this {scopeType}.</p>
      )}
      <div className="discussion-thread-list">
        {items.map((item) => (
          <button
            className={`list-row ${selected?.id === item.id ? 'selected' : ''}`}
            key={item.id}
            onClick={() => void open(item)}
          >
            <strong>{item.title}</strong>
            <span>
              {item.messageCount} messages · {new Date(item.updatedAt).toLocaleString()}
            </span>
          </button>
        ))}
      </div>
      {!selected && (
        <form
          className="discussion-start"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <input
            aria-label="Thread title"
            placeholder={`Start a thread about ${subjectLabel}`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button type="submit">
            <MessageSquare /> Start thread
          </button>
          <Link className="field-hint" to={subjectPath}>
            Back to subject
          </Link>
        </form>
      )}
      {selected && (
        <div className="discussion-detail">
          <h3>{selected.title}</h3>
          {messages.map((message) => (
            <article className="conversation-message" key={message.id}>
              <strong>{message.senderLabel}</strong>
              <time>{new Date(message.sentAt).toLocaleString()}</time>
              <p>{message.body}</p>
            </article>
          ))}
          <form
            className="conversation-compose"
            onSubmit={(event) => {
              event.preventDefault();
              void post();
            }}
          >
            <textarea
              aria-label="Discussion reply"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder="Write a reply"
              maxLength={4000}
            />
            <button type="submit">
              <Send /> Reply
            </button>
          </form>
        </div>
      )}
    </section>
  );
}
