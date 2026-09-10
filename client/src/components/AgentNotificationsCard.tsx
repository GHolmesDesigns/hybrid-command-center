import { useCallback, useEffect, useState } from 'react';
import { Bell, Check } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, send } from '../api';
import type { AgentNotification } from '../../../shared/agent-summaries';

type Page = { notifications: AgentNotification[]; unreadCount: number; nextCursor: string | null };
const destinationHref = (n: AgentNotification) => {
  if (!n.destination) return null;
  return n.destination.type === 'conversation'
    ? '/agents/conversations'
    : `/agents#${n.destination.type === 'agents' ? 'agent-directory' : n.destination.type === 'memory' ? 'agent-memory' : 'agent-handoffs'}`;
};

export function AgentNotificationsCard({
  flash,
}: {
  flash: (message: string, type?: 'success' | 'error') => void;
}) {
  const [unreadOnly, setUnreadOnly] = useState(true);
  const [page, setPage] = useState<Page>({ notifications: [], unreadCount: 0, nextCursor: null });
  const load = useCallback(
    async (cursor?: string) => {
      try {
        const q = new URLSearchParams({ unreadOnly: String(unreadOnly), limit: '50' });
        if (cursor) q.set('cursor', cursor);
        const raw = (await api<Partial<Page>>(`/agent-notifications?${q}`)) ?? {};
        const result: Page = {
          notifications: Array.isArray(raw.notifications) ? raw.notifications : [],
          unreadCount: typeof raw.unreadCount === 'number' ? raw.unreadCount : 0,
          nextCursor: typeof raw.nextCursor === 'string' ? raw.nextCursor : null,
        };
        setPage((current) =>
          cursor
            ? { ...result, notifications: [...current.notifications, ...result.notifications] }
            : result,
        );
      } catch (error) {
        flash(error instanceof Error ? error.message : 'Notifications unavailable.', 'error');
      }
    },
    [flash, unreadOnly],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const mark = async (id: string) => {
    try {
      await send(`/agent-notifications/${id}/read`, 'POST');
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Unable to mark notification read.', 'error');
    }
  };
  const markAll = async () => {
    try {
      await send('/agent-notifications/mark-all-read', 'POST');
      await load();
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Unable to mark notifications read.', 'error');
    }
  };
  return (
    <section
      className="panel settings-card"
      id="agent-notifications"
      aria-labelledby="agent-notifications-heading"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">Operator inbox</p>
          <h2 id="agent-notifications-heading">
            <Bell /> Notifications{' '}
            {page.unreadCount > 0 && (
              <span aria-label={`${page.unreadCount} unread notifications`}>
                ({page.unreadCount})
              </span>
            )}
          </h2>
        </div>
        <button
          className="secondary-btn"
          onClick={() => void markAll()}
          disabled={page.unreadCount === 0}
        >
          <Check /> Mark all read
        </button>
      </div>
      <div className="filter-row">
        <label>
          Show{' '}
          <select
            aria-label="Notification filter"
            value={String(unreadOnly)}
            onChange={(e) => setUnreadOnly(e.target.value === 'true')}
          >
            <option value="true">Unread</option>
            <option value="false">All</option>
          </select>
        </label>
      </div>
      {page.notifications.length === 0 ? (
        <p>No notifications match this filter.</p>
      ) : (
        <div className="agent-notification-list">
          {page.notifications.map((n) => {
            const href = destinationHref(n);
            return (
              <article
                className={`agent-notification-entry ${n.readAt ? 'read' : 'unread'}`}
                key={n.id}
              >
                <div>
                  <strong>{n.title}</strong>
                  <small>
                    {n.kind} · {n.agentLabel} ·{' '}
                    <time>{new Date(n.createdAt).toLocaleString()}</time>
                  </small>
                </div>
                <p>{n.body}</p>
                <div className="button-row">
                  {href && (
                    <Link className="secondary-btn" to={href}>
                      Open destination
                    </Link>
                  )}
                  {!n.readAt && (
                    <button className="secondary-btn" onClick={() => void mark(n.id)}>
                      Mark read
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {page.nextCursor && (
        <button className="secondary-btn" onClick={() => void load(page.nextCursor!)}>
          Load more
        </button>
      )}
    </section>
  );
}
