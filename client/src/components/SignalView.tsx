import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { api, send } from '../api';
import {
  SIGNAL_CHANNEL_INITIAL,
  SIGNAL_CHANNEL_LABEL,
  SIGNAL_CHANNELS,
  SIGNAL_CTA_LABEL,
  SIGNAL_CTAS,
  SIGNAL_FORMAT_LABEL,
  SIGNAL_FORMATS,
  SIGNAL_STATUS_LABEL,
  SIGNAL_STATUSES,
  signalDaysInMonth,
  signalMonthBounds,
  type SignalChannel,
  type SignalCta,
  type SignalFormat,
  type SignalPost,
  type SignalStatus,
} from '../../../shared/signal';
import { Empty } from './Primitives';
import { Select } from './FormControls';
import { PageHead } from './Shell';

type SignalRange = {
  from: string;
  to: string;
  posts: SignalPost[];
  truncated: boolean;
};

type Draft = {
  text: string;
  channels: SignalChannel[];
  date: string;
  time: string;
  format: SignalFormat;
  status: SignalStatus;
  campaign: string;
  cta: SignalCta;
};

const pad = (value: number) => String(value).padStart(2, '0');

/** Today as a local calendar label, never a UTC instant. */
const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const monthHeading = (month: string) => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return new Date(year, index - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
};

const shiftMonth = (month: string, by: number) => {
  const [year, index] = month.split('-').map(Number) as [number, number];
  const zero = year * 12 + index - 1 + by;
  return `${Math.floor(zero / 12)}-${pad((zero % 12) + 1)}`;
};

const draftFor = (post: SignalPost): Draft => ({
  text: post.text,
  channels: post.channels,
  date: post.date ?? '',
  time: post.time,
  format: post.format,
  status: post.status,
  campaign: post.campaign ?? '',
  cta: post.cta,
});

const StatusIcon = ({ status }: { status: SignalStatus }) =>
  status === 'PUBLISHED' ? (
    <CheckCircle2 aria-hidden="true" />
  ) : status === 'SCHEDULED' ? (
    <Clock3 aria-hidden="true" />
  ) : (
    <Circle aria-hidden="true" />
  );

function PostMeta({ post }: { post: SignalPost }) {
  return (
    <div className="signal-post-meta">
      <span className={`signal-status status-${post.status.toLowerCase()}`}>
        <StatusIcon status={post.status} /> {SIGNAL_STATUS_LABEL[post.status]}
      </span>
      {post.channels.map((channel) => (
        <span className={`signal-channel ch-${channel}`} key={channel}>
          <span aria-hidden="true">{SIGNAL_CHANNEL_INITIAL[channel]}</span>
          <span className="sr-only">{SIGNAL_CHANNEL_LABEL[channel]}</span>
        </span>
      ))}
    </div>
  );
}

function PostButton({ post, open }: { post: SignalPost; open: (post: SignalPost) => void }) {
  return (
    <button className="signal-post" onClick={() => open(post)} aria-label={`Edit ${post.text}`}>
      <PostMeta post={post} />
      <span className="signal-post-text">{post.text}</span>
      <span className="signal-post-detail">
        {post.time} · {SIGNAL_FORMAT_LABEL[post.format]}
      </span>
    </button>
  );
}

function Editor({
  post,
  close,
  saved,
  removed,
}: {
  post: SignalPost;
  close: () => void;
  saved: (post: SignalPost) => Promise<void>;
  removed: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFor(post));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [close]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.text.trim()) {
      setError('A post needs content.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = await send<SignalPost>(`/signal/posts/${post.id}`, 'PATCH', {
        ...draft,
        text: draft.text.trim(),
        date: draft.date || null,
        campaign: draft.campaign.trim() || null,
      });
      await saved(next);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this Signal post? This cannot be undone.')) return;
    setBusy(true);
    setError('');
    try {
      await send(`/signal/posts/${post.id}`, 'DELETE');
      await removed(post.id);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const toggleChannel = (channel: SignalChannel) =>
    setDraft((current) => ({
      ...current,
      channels: current.channels.includes(channel)
        ? current.channels.filter((value) => value !== channel)
        : [...current.channels, channel],
    }));

  return (
    <div
      className="signal-editor-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <aside
        className="signal-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signal-editor-title"
      >
        <header>
          <div>
            <span className="eyebrow">Signal Campaign</span>
            <h2 id="signal-editor-title">Edit post</h2>
          </div>
          <button className="icon-btn" onClick={close} aria-label="Close editor">
            <X />
          </button>
        </header>
        <form className="form signal-editor-form" onSubmit={submit}>
          <label>
            Content
            <textarea
              ref={textRef}
              rows={10}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
              required
            />
          </label>
          <fieldset className="signal-channel-fieldset">
            <legend>Channels</legend>
            <div>
              {SIGNAL_CHANNELS.map((channel) => (
                <label key={channel}>
                  <input
                    type="checkbox"
                    checked={draft.channels.includes(channel)}
                    onChange={() => toggleChannel(channel)}
                  />
                  <span className={`signal-channel ch-${channel}`} aria-hidden="true">
                    {SIGNAL_CHANNEL_INITIAL[channel]}
                  </span>
                  {SIGNAL_CHANNEL_LABEL[channel]}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="form-row">
            <label>
              Date
              <input
                type="date"
                value={draft.date}
                onChange={(event) => setDraft({ ...draft, date: event.target.value })}
              />
            </label>
            <label>
              Time
              <input
                type="time"
                value={draft.time}
                onChange={(event) => setDraft({ ...draft, time: event.target.value })}
                required
              />
            </label>
          </div>
          {draft.date && (
            <button
              type="button"
              className="secondary signal-unschedule"
              onClick={() => setDraft({ ...draft, date: '' })}
            >
              Move to unscheduled queue
            </button>
          )}
          <div className="form-row triple">
            <Select
              label="Format"
              name="format"
              value={draft.format}
              options={SIGNAL_FORMATS}
              labels={SIGNAL_FORMAT_LABEL}
              onChange={(event) =>
                setDraft({ ...draft, format: event.target.value as SignalFormat })
              }
            />
            <Select
              label="Status"
              name="status"
              value={draft.status}
              options={SIGNAL_STATUSES}
              labels={SIGNAL_STATUS_LABEL}
              onChange={(event) =>
                setDraft({ ...draft, status: event.target.value as SignalStatus })
              }
            />
            <Select
              label="CTA"
              name="cta"
              value={draft.cta}
              options={SIGNAL_CTAS}
              labels={SIGNAL_CTA_LABEL}
              onChange={(event) => setDraft({ ...draft, cta: event.target.value as SignalCta })}
            />
          </div>
          <label>
            Campaign
            <input
              value={draft.campaign}
              maxLength={200}
              onChange={(event) => setDraft({ ...draft, campaign: event.target.value })}
            />
          </label>
          <div className="form-error" role="alert">
            {error}
          </div>
          <div className="signal-editor-actions">
            <button
              type="button"
              className="secondary danger-text"
              disabled={busy}
              onClick={remove}
            >
              <Trash2 /> Delete
            </button>
            <button className="submit" disabled={busy}>
              {busy ? (
                <>
                  <RefreshCw className="spin" /> Saving…
                </>
              ) : (
                'Save post'
              )}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

export function SignalView() {
  const [params, setParams] = useSearchParams();
  const month = /^\d{4}-\d{2}$/.test(params.get('month') ?? '')
    ? (params.get('month') as string)
    : today().slice(0, 7);
  const [posts, setPosts] = useState<SignalPost[]>([]);
  const [queue, setQueue] = useState<SignalPost[]>([]);
  const [editing, setEditing] = useState<SignalPost | null>(null);
  const [idea, setIdea] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { from, to } = signalMonthBounds(`${month}-01`);
    try {
      const [range, nextQueue] = await Promise.all([
        api<SignalRange>(`/signal/posts?from=${from}&to=${to}`),
        api<SignalPost[]>('/signal/queue'),
      ]);
      setPosts(range.posts);
      setTruncated(range.truncated);
      setQueue(nextQueue);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDate = useMemo(() => {
    const grouped = new Map<string, SignalPost[]>();
    for (const post of posts) {
      if (!post.date) continue;
      grouped.set(post.date, [...(grouped.get(post.date) ?? []), post]);
    }
    return grouped;
  }, [posts]);

  const addIdea = async (event: FormEvent) => {
    event.preventDefault();
    if (!idea.trim()) return;
    setAdding(true);
    setError('');
    try {
      const created = await send<SignalPost>('/signal/posts', 'POST', { text: idea.trim() });
      setIdea('');
      await load();
      setEditing(created);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const refreshed = async () => {
    setEditing(null);
    await load();
  };

  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const leading = new Date(year, monthNumber - 1, 1).getDay();
  const days = Array.from(
    { length: signalDaysInMonth(year, monthNumber) },
    (_, index) => index + 1,
  );

  return (
    <>
      <PageHead
        eyebrow="Signal Campaign"
        title="Content planner"
        body="Plan the schedule, keep new ideas in the queue, and record what has gone out. Nothing here publishes automatically."
        action={
          <button className="secondary" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : ''} /> Refresh
          </button>
        }
      />
      {error && (
        <div className="refresh-error" role="alert">
          {error}
        </div>
      )}
      {truncated && (
        <div className="refresh-error" role="status">
          This month has more than 500 posts. Only the first 500 are shown.
        </div>
      )}
      <div className="signal-layout">
        <aside className="signal-queue" aria-labelledby="signal-queue-title">
          <div className="signal-section-head">
            <div>
              <span className="eyebrow">Ideas</span>
              <h2 id="signal-queue-title">Unscheduled queue</h2>
            </div>
            <span className="signal-count">{queue.length}</span>
          </div>
          <form className="signal-quick-add" onSubmit={addIdea}>
            <label className="sr-only" htmlFor="signal-idea">
              Add an idea
            </label>
            <textarea
              id="signal-idea"
              rows={3}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder="Capture a new post idea…"
            />
            <button disabled={adding || !idea.trim()}>
              {adding ? <RefreshCw className="spin" /> : <Plus />} Add idea
            </button>
          </form>
          {!loading && queue.length === 0 ? (
            <Empty compact title="Queue clear" body="New ideas without a date will wait here." />
          ) : (
            <ul className="signal-queue-list">
              {queue.map((post) => (
                <li key={post.id}>
                  <PostButton post={post} open={setEditing} />
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="signal-calendar" aria-labelledby="signal-month-title">
          <div className="signal-month-nav">
            <button
              className="secondary"
              onClick={() => setParams({ month: shiftMonth(month, -1) })}
              aria-label="Previous month"
            >
              <ChevronLeft />
            </button>
            <div>
              <CalendarClock aria-hidden="true" />
              <h2 id="signal-month-title">{monthHeading(month)}</h2>
            </div>
            <button
              className="secondary"
              onClick={() => setParams({ month: shiftMonth(month, 1) })}
              aria-label="Next month"
            >
              <ChevronRight />
            </button>
          </div>
          <div className="signal-weekdays" aria-hidden="true">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="signal-grid">
            {Array.from({ length: leading }, (_, index) => (
              <div className="signal-day is-blank" key={`blank-${index}`} />
            ))}
            {days.map((day) => {
              const date = `${month}-${pad(day)}`;
              const scheduled = byDate.get(date) ?? [];
              return (
                <section
                  className={`signal-day ${date === today() ? 'is-today' : ''}`}
                  key={date}
                  aria-label={date}
                >
                  <header>
                    <span>{day}</span>
                    {date === today() && <strong>Today</strong>}
                  </header>
                  {scheduled.length === 0 ? (
                    <span className="signal-day-empty">No posts</span>
                  ) : (
                    <ul>
                      {scheduled.map((post) => (
                        <li key={post.id}>
                          <PostButton post={post} open={setEditing} />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
          {loading && (
            <div className="signal-loading">
              <RefreshCw className="spin" /> Loading planner…
            </div>
          )}
        </section>
      </div>
      {editing && (
        <Editor
          post={editing}
          close={() => setEditing(null)}
          saved={refreshed}
          removed={refreshed}
        />
      )}
    </>
  );
}
