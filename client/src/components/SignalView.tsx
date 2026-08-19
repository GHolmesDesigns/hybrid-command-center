import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Copy,
  Plus,
  Paperclip,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { api, send } from '../api';
import {
  SIGNAL_CHANNEL_LABEL,
  SIGNAL_CHANNEL_PRESETS,
  SIGNAL_CHANNELS,
  SIGNAL_CTA_LABEL,
  SIGNAL_CTAS,
  SIGNAL_FORMAT_LABEL,
  SIGNAL_FORMATS,
  SIGNAL_STATUS_LABEL,
  SIGNAL_STATUSES,
  isSignalDate,
  resolveSignalChannelPreset,
  signalChannelPresentation,
  signalMediaKind,
  signalTextHasLink,
  type SignalChannel,
  type SignalCta,
  type SignalFormat,
  type SignalPost,
  type SignalSlot,
  type SignalStatus,
} from '../../../shared/signal';
import {
  CALENDAR_VIEWS,
  calendarViewRange,
  shiftCalendarAnchor,
  type CalendarViewMode,
} from '../../../shared/calendar';
import { signalChannelStyle } from './ui-shared';
import { Empty } from './Primitives';
import { Select } from './FormControls';
import { PageHead } from './Shell';
import {
  publishPreviewRefusals,
  PUBLISH_CHANNEL_STATUS_LABEL,
  type PublishPreview,
  type SignalPublication,
} from '../../../shared/publish';
import type { PublishVariantRecord } from '../../../shared/publish-variants';
import { PlatformVariantsEditor, PublishPreviewTabs } from './SignalVariants';
import { previewPlatforms, variantList, variantMap } from './signal-variants';

type SignalRange = {
  from: string;
  to: string;
  posts: SignalPost[];
  truncated: boolean;
};

type Draft = {
  text: string;
  channels: SignalChannel[];
  mediaUrls: string[];
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

const dayHeading = (date: string, options: Intl.DateTimeFormatOptions) => {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, day).toLocaleDateString(undefined, options);
};

const dateLabels = (from: string, to: string) => {
  const labels: string[] = [];
  let current = from;
  while (current <= to) {
    labels.push(current);
    current = shiftCalendarAnchor('today', current, 1);
  }
  return labels;
};

const draftFor = (post: SignalPost): Draft => ({
  text: post.text,
  channels: post.channels,
  mediaUrls: post.mediaUrls,
  date: post.date ?? '',
  time: post.time,
  format: post.format,
  status: post.status,
  campaign: post.campaign ?? '',
  cta: post.cta,
});

/**
 * A day cell is a fixed height, so a post shows a preview and opens the rest in place. The
 * preview is this short because a cell is a seventh of the calendar and runs to about a dozen
 * characters a line. It is cut here rather than by a CSS line clamp: the cut and the control
 * that undoes it have to agree, and a clamp firing at a width this code cannot see would hide
 * text that no expand control was rendered for.
 */
const POST_PREVIEW_CHARS = 44;
const POST_PREVIEW_LINES = 2;

/** Whether the cell shows less than the whole post, and so owes the reader a way to see it. */
const isTrimmed = (text: string) =>
  text.length > POST_PREVIEW_CHARS || text.split('\n').length > POST_PREVIEW_LINES;

const previewOf = (text: string) => {
  const lines = text.split('\n').slice(0, POST_PREVIEW_LINES).join('\n');
  return `${lines.slice(0, POST_PREVIEW_CHARS).trimEnd()}…`;
};

/** Enough of a post to tell two expand controls apart in a screen reader's list. */
const nameOf = (text: string) => {
  const line = text.split('\n')[0] as string;
  return line.length > 40 ? `${line.slice(0, 40).trimEnd()}…` : line;
};

const StatusIcon = ({ status }: { status: SignalStatus }) =>
  status === 'PUBLISHED' ? (
    <CheckCircle2 aria-hidden="true" />
  ) : status === 'SCHEDULED' ? (
    <Clock3 aria-hidden="true" />
  ) : (
    <Circle aria-hidden="true" />
  );

/**
 * One channel, as a swatch with its initial on it. The colours come from the channel's own
 * treatment and the initial is drawn on top of them, so the chip still names its channel with
 * the hue removed. Beside a checkbox the full name is already the label, which is the one place
 * the chip repeating it would make a screen reader say it twice.
 */
function ChannelChip({ channel, labelled = true }: { channel: SignalChannel; labelled?: boolean }) {
  const { initial, label, ...treatment } = signalChannelPresentation(channel);
  return (
    <span
      className="signal-channel"
      data-channel={channel}
      style={signalChannelStyle(treatment)}
      aria-hidden={labelled ? undefined : 'true'}
    >
      <span aria-hidden="true">{initial}</span>
      {labelled && <span className="sr-only">{label}</span>}
    </span>
  );
}

function PostMeta({ post }: { post: SignalPost }) {
  return (
    <div className="signal-post-meta">
      <span className={`signal-status status-${post.status.toLowerCase()}`}>
        <StatusIcon status={post.status} /> {SIGNAL_STATUS_LABEL[post.status]}
      </span>
      {post.channels.map((channel) => (
        <ChannelChip channel={channel} key={channel} />
      ))}
    </div>
  );
}

const X_LINK_WARNING =
  'X removes links from the post body. Move this link to a reply before publishing.';

/**
 * Editing and expanding are siblings, never nested: a control inside the edit button would be
 * invalid markup and would never receive its own click.
 */
function Post({
  post,
  open,
  preview = false,
}: {
  post: SignalPost;
  open: (post: SignalPost) => void;
  /** Set in a day cell, which has neighbours to stretch. The queue is a column of its own. */
  preview?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();
  const trimmed = preview && isTrimmed(post.text);
  const warnsAboutXLink = post.channels.includes('x') && signalTextHasLink(post.text);

  return (
    <div className={`signal-post ${expanded ? 'is-expanded' : ''}`}>
      <button
        className="signal-post-edit"
        onClick={() => open(post)}
        aria-label={`Edit ${post.text}`}
      >
        <PostMeta post={post} />
        <span className="signal-post-text" id={textId}>
          {trimmed && !expanded ? previewOf(post.text) : post.text}
        </span>
        <span className="signal-post-detail">
          {post.time} · {SIGNAL_FORMAT_LABEL[post.format]}
          {post.mediaUrls.length > 0 && (
            <span className="signal-media-count">
              {' · '}
              <Paperclip aria-hidden="true" /> {post.mediaUrls.length} media
            </span>
          )}
        </span>
        {warnsAboutXLink && (
          <span className="signal-x-link-warning">
            <AlertTriangle aria-hidden="true" /> {X_LINK_WARNING}
          </span>
        )}
      </button>
      {trimmed && (
        <button
          type="button"
          className="text-btn signal-post-expand"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={`${expanded ? 'Show less' : 'Show more'} of ${nameOf(post.text)}`}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

function Editor({
  post,
  close,
  saved,
  opened,
  removed,
}: {
  post: SignalPost;
  close: () => void;
  saved: (post: SignalPost) => Promise<void>;
  opened: (post: SignalPost) => Promise<void>;
  removed: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFor(post));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mediaInput, setMediaInput] = useState('');
  const [publishPreview, setPublishPreview] = useState<PublishPreview | null>(null);
  const [publications, setPublications] = useState<SignalPublication[]>([]);
  const [presetNotice, setPresetNotice] = useState('');
  /**
   * The content variants, twice: what the server holds and what the form is holding.
   *
   * Two copies rather than a dirty flag, because the preview is gated on them being identical and a
   * boolean would have to be maintained by every edit path. Comparing the two says the same thing
   * and cannot fall behind.
   */
  const [savedLayers, setSavedLayers] = useState(() => variantMap([]));
  const [layers, setLayers] = useState(() => variantMap([]));
  const [suggestedSlot, setSuggestedSlot] = useState<SignalSlot | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const hasUnsavedChanges = JSON.stringify(draft) !== JSON.stringify(draftFor(post));
  const hasUnsavedVariants =
    JSON.stringify(variantList(layers)) !== JSON.stringify(variantList(savedLayers));
  const hasPublishableChannel = post.channels.some((channel) => channel !== 'blog');
  const hasTailorablePlatform = previewPlatforms(post).length > 0;
  const warnsAboutXLink = draft.channels.includes('x') && signalTextHasLink(draft.text);

  useEffect(() => {
    textRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [close]);

  useEffect(() => {
    api<SignalPublication[]>(`/signal/posts/${post.id}/publications`)
      .then(setPublications)
      .catch(() => setPublications([]));
  }, [post.id]);

  /**
   * The stored overrides, read as text and nothing else.
   *
   * This is the one request the editor makes on open besides the delivery history, and it touches
   * no remote host: the layers are local rows, and the media addresses in them stay addresses until
   * the preview is asked for.
   */
  useEffect(() => {
    api<PublishVariantRecord[]>(`/signal/posts/${post.id}/variants`)
      .then((stored) => {
        setSavedLayers(variantMap(stored));
        setLayers(variantMap(stored));
      })
      .catch(() => {
        setSavedLayers(variantMap([]));
        setLayers(variantMap([]));
      });
  }, [post.id]);

  const saveVariants = async (): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const stored = await send<PublishVariantRecord[]>(
        `/signal/posts/${post.id}/variants`,
        'PUT',
        { variants: variantList(layers) },
      );
      setSavedLayers(variantMap(stored));
      setLayers(variantMap(stored));
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const previewPublish = async () => {
    setBusy(true);
    setError('');
    try {
      setPublishPreview(
        await send<PublishPreview>(`/signal/posts/${post.id}/publish/preview`, 'POST'),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * An account override saved from inside the preview, and the preview re-run against it.
   *
   * Both halves are this one press: a stored override the open preview does not reflect would be a
   * plan the user confirmed after looking at a different one, and the plan hash would refuse it at
   * commit anyway — later and less clearly.
   */
  const saveAccountVariant = async () => {
    if (await saveVariants()) await previewPublish();
  };

  const confirmPublish = async () => {
    if (!publishPreview || publishPreviewRefusals(publishPreview).length) return;
    setBusy(true);
    setError('');
    try {
      const publication = await send<SignalPublication>(
        `/signal/posts/${post.id}/publish`,
        'POST',
        { planHash: publishPreview.planHash },
      );
      setPublications((current) => [publication, ...current]);
      setPublishPreview(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const markPublished = async () => {
    setBusy(true);
    setError('');
    try {
      await saved(
        await send<SignalPost>(`/signal/posts/${post.id}`, 'PATCH', { status: 'PUBLISHED' }),
      );
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const refreshDelivery = async (publicationId: string) => {
    setBusy(true);
    setError('');
    try {
      const refreshed = await send<SignalPublication>(
        `/signal/publications/${publicationId}/reconcile`,
        'POST',
      );
      setPublications((current) =>
        current.map((publication) => (publication.id === refreshed.id ? refreshed : publication)),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

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

  const duplicate = async () => {
    setBusy(true);
    setError('');
    try {
      await opened(await send<SignalPost>(`/signal/posts/${post.id}/duplicate`, 'POST'));
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const suggestSlot = async () => {
    setBusy(true);
    setError('');
    try {
      setSuggestedSlot(await api<SignalSlot>(`/signal/posts/${post.id}/next-slot?from=${today()}`));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirmSlot = async () => {
    if (!suggestedSlot) return;
    setBusy(true);
    setError('');
    try {
      const next = await send<SignalPost>(`/signal/posts/${post.id}/slot`, 'POST', {
        ...suggestedSlot,
        from: today(),
      });
      setSuggestedSlot(null);
      await opened(next);
    } catch (reason) {
      const failure = reason as Error & { data?: { suggestion?: SignalSlot | null } };
      setError(failure.message);
      if (failure.data?.suggestion) setSuggestedSlot(failure.data.suggestion);
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

  const applyChannelPreset = (presetId: string) => {
    const preset = SIGNAL_CHANNEL_PRESETS.find((candidate) => candidate.id === presetId);
    if (!preset) return;
    const { channels, excludedChannelIds } = resolveSignalChannelPreset(preset);
    setDraft((current) => ({ ...current, channels }));
    setPresetNotice(
      excludedChannelIds.length > 0
        ? `${preset.label} applied. Excluded unavailable channels: ${excludedChannelIds.join(', ')}.`
        : `${preset.label} applied. You can edit the channels below.`,
    );
  };

  const addMedia = () => {
    const value = mediaInput.trim();
    try {
      if (new URL(value).protocol !== 'https:') throw new Error();
    } catch {
      setError('Media URLs must be valid https addresses.');
      return;
    }
    setDraft((current) => ({ ...current, mediaUrls: [...current.mediaUrls, value] }));
    setMediaInput('');
    setError('');
  };

  const updateMedia = (index: number, value: string) =>
    setDraft((current) => ({
      ...current,
      mediaUrls: current.mediaUrls.map((url, currentIndex) =>
        currentIndex === index ? value : url,
      ),
    }));

  const moveMedia = (index: number, by: number) =>
    setDraft((current) => {
      const next = [...current.mediaUrls];
      const [moved] = next.splice(index, 1);
      next.splice(index + by, 0, moved as string);
      return { ...current, mediaUrls: next };
    });

  const removeMedia = (index: number) =>
    setDraft((current) => ({
      ...current,
      mediaUrls: current.mediaUrls.filter((_url, currentIndex) => currentIndex !== index),
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
          {warnsAboutXLink && (
            <p className="signal-x-link-warning signal-editor-link-warning" role="status">
              <AlertTriangle aria-hidden="true" /> {X_LINK_WARNING}
            </p>
          )}
          <fieldset className="signal-channel-fieldset">
            <legend>Channels</legend>
            <label className="signal-channel-preset">
              Channel preset
              <select value="" onChange={(event) => applyChannelPreset(event.target.value)}>
                <option value="">Choose a preset</option>
                {SIGNAL_CHANNEL_PRESETS.map((preset) => (
                  <option value={preset.id} key={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            {presetNotice && (
              <p className="signal-preset-notice" role="status">
                {presetNotice}
              </p>
            )}
            <div>
              {SIGNAL_CHANNELS.map((channel) => (
                <label key={channel}>
                  <input
                    type="checkbox"
                    checked={draft.channels.includes(channel)}
                    onChange={() => toggleChannel(channel)}
                  />
                  <ChannelChip channel={channel} labelled={false} />
                  {SIGNAL_CHANNEL_LABEL[channel]}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="signal-media-fieldset">
            <legend>Media</legend>
            <p>Public https URLs only. Signal stores the references and never fetches the files.</p>
            {draft.mediaUrls.length > 0 && (
              <ol>
                {draft.mediaUrls.map((url, index) => (
                  <li key={`${index}-${url}`}>
                    <label>
                      <span>Media URL {index + 1}</span>
                      <input
                        type="url"
                        value={url}
                        onChange={(event) => updateMedia(index, event.target.value)}
                        required
                      />
                    </label>
                    <span className="signal-media-kind">{signalMediaKind(url)}</span>
                    <div>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => moveMedia(index, -1)}
                        disabled={index === 0}
                        aria-label={`Move media ${index + 1} up`}
                      >
                        <ArrowUp />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => moveMedia(index, 1)}
                        disabled={index === draft.mediaUrls.length - 1}
                        aria-label={`Move media ${index + 1} down`}
                      >
                        <ArrowDown />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger-text"
                        onClick={() => removeMedia(index)}
                        aria-label={`Remove media ${index + 1}`}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <div className="signal-media-add">
              <label>
                Add media URL
                <input
                  type="text"
                  inputMode="url"
                  placeholder="https://example.com/campaign-image.jpg"
                  value={mediaInput}
                  onChange={(event) => setMediaInput(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="secondary"
                onClick={addMedia}
                disabled={!mediaInput.trim()}
              >
                <Plus /> Add media
              </button>
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
          <div className="signal-slot-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || hasUnsavedChanges}
              onClick={() => void duplicate()}
            >
              <Copy aria-hidden="true" /> Duplicate to unscheduled queue
            </button>
            <button
              type="button"
              className="secondary"
              disabled={busy || hasUnsavedChanges}
              onClick={() => void suggestSlot()}
            >
              Suggest next open slot
            </button>
            {draft.date && (
              <button
                type="button"
                className="secondary signal-unschedule"
                onClick={() => setDraft({ ...draft, date: '' })}
              >
                Move to unscheduled queue
              </button>
            )}
          </div>
          {hasUnsavedChanges && (
            <p className="signal-preset-notice">
              Save changes before duplicating or suggesting a slot.
            </p>
          )}
          {suggestedSlot && (
            <section className="signal-slot-suggestion" aria-label="Suggested slot">
              <h3>Suggested slot</h3>
              <p>
                {dayHeading(suggestedSlot.date, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}{' '}
                at {suggestedSlot.time}
              </p>
              <p>Nothing is saved until you confirm. Occupancy is checked again at that moment.</p>
              <div className="signal-editor-actions">
                <button type="button" className="secondary" onClick={() => setSuggestedSlot(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="submit"
                  onClick={() => void confirmSlot()}
                  disabled={busy}
                >
                  Use this slot
                </button>
              </div>
            </section>
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
          {/* Tailored from the post as it is saved, not as it is being typed: a platform override
              of a caption that has not been written yet would be an override of nothing. */}
          {hasTailorablePlatform && (
            <PlatformVariantsEditor
              post={post}
              layers={layers}
              onChange={setLayers}
              onSave={() => void saveVariants()}
              dirty={hasUnsavedVariants}
              busy={busy}
            />
          )}
          {publications.length > 0 && (
            <section className="signal-publications" aria-label="Publishing history">
              <h3>Delivery</h3>
              {publications.map((publication) => (
                <p key={publication.id}>
                  <strong>{publication.state}</strong> · {publication.sentChannels.join(', ')} ·{' '}
                  {new Date(publication.scheduledInstant).toLocaleString()}
                </p>
              ))}
              {publications[0]?.state === 'CONFIRMED' && post.status !== 'PUBLISHED' && (
                <button type="button" className="secondary" onClick={markPublished} disabled={busy}>
                  Mark published
                </button>
              )}
              {publications[0]?.providerPostId && publications[0].state === 'SUBMITTED' && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => refreshDelivery(publications[0]!.id)}
                  disabled={busy}
                >
                  Refresh delivery
                </button>
              )}
            </section>
          )}
          {publishPreview && (
            <section className="signal-publish-preview" aria-label="Publish confirmation">
              <h3>Confirm publishing</h3>
              {publishPreview.scheduledInstant && (
                <p>
                  <strong>{publishPreview.timezone}</strong>: {post.date} at {post.time}
                  <br />
                  UTC: {publishPreview.scheduledInstant}
                </p>
              )}
              {/* The post's own caption. What each target actually receives is in its own tab,
                  because after an override there is no single answer to show here. */}
              <p>{publishPreview.caption}</p>
              {/* Every channel's verdict at a glance, so the shape of the plan is readable without
                  opening seven tabs; each channel's detail, media and reasons are in its tab. */}
              <ul className="signal-publish-channels">
                {publishPreview.channels.map((report) => (
                  <li key={report.channel} className={`channel-${report.status.toLowerCase()}`}>
                    <p>
                      <strong>{SIGNAL_CHANNEL_LABEL[report.channel]}</strong>
                      {report.handle ? ` → ${report.handle}` : ''} ·{' '}
                      {PUBLISH_CHANNEL_STATUS_LABEL[report.status]}
                    </p>
                  </li>
                ))}
              </ul>
              <PublishPreviewTabs
                preview={publishPreview}
                post={post}
                layers={layers}
                savedLayers={savedLayers}
                onChange={setLayers}
                onSaveAccount={() => void saveAccountVariant()}
                busy={busy}
              />
              {publishPreview.warnings.map((warning) => (
                <p className="form-warning" key={warning}>
                  {warning}
                </p>
              ))}
              {publishPreview.refusals.map((refusal) => (
                <p className="form-error" key={refusal}>
                  {refusal}
                </p>
              ))}
              <div className="signal-editor-actions">
                <button type="button" className="secondary" onClick={() => setPublishPreview(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="submit"
                  onClick={confirmPublish}
                  disabled={busy || publishPreviewRefusals(publishPreview).length > 0}
                >
                  Confirm and submit
                </button>
              </div>
            </section>
          )}
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
            {post.date && hasPublishableChannel && !publishPreview && (
              <button
                type="button"
                className="secondary"
                disabled={busy || hasUnsavedChanges || hasUnsavedVariants}
                onClick={previewPublish}
              >
                {hasUnsavedChanges || hasUnsavedVariants
                  ? 'Save changes before preview'
                  : 'Show preview'}
              </button>
            )}
          </div>
        </form>
      </aside>
    </div>
  );
}

export function SignalView() {
  const [params, setParams] = useSearchParams();
  const now = today();
  const requestedView = params.get('view');
  const view: CalendarViewMode = CALENDAR_VIEWS.includes(requestedView as CalendarViewMode)
    ? (requestedView as CalendarViewMode)
    : 'month';
  const requestedDate = params.get('date');
  const requestedMonth = params.get('month');
  const anchor = isSignalDate(requestedDate ?? '')
    ? (requestedDate as string)
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth ?? '')
      ? `${requestedMonth}-01`
      : now;
  const bounds = useMemo(() => calendarViewRange(view, anchor), [view, anchor]);
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
    const { from, to } = bounds;
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
  }, [bounds]);

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

  const days = dateLabels(bounds.from, bounds.to);
  const [firstYear, firstMonth, firstDay] = bounds.from.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const leading = view === 'month' ? new Date(firstYear, firstMonth - 1, firstDay).getDay() : 0;
  const weekdays =
    view === 'month'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : days.map((date) => dayHeading(date, { weekday: 'short' }));

  const goto = (nextView: CalendarViewMode, nextAnchor: string) => {
    if (nextView === 'month' && nextAnchor.slice(0, 7) === now.slice(0, 7)) {
      setParams({});
      return;
    }
    const next: Record<string, string> = { month: nextAnchor.slice(0, 7) };
    if (nextView !== 'month') {
      next.view = nextView;
      next.date = nextAnchor;
    }
    setParams(next);
  };

  const title =
    view === 'today'
      ? dayHeading(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'week'
        ? `${dayHeading(bounds.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${dayHeading(bounds.to, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : monthHeading(anchor.slice(0, 7));
  const spanLabel = view === 'today' ? 'day' : view;

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
          This {spanLabel} has more than 500 posts. Only the first 500 are shown.
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
                  <Post post={post} open={setEditing} />
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="signal-calendar" aria-labelledby="signal-range-title">
          <div className="segmented-control signal-view-switch" aria-label="Signal view">
            {CALENDAR_VIEWS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => goto(option, anchor)}
              >
                {option === 'today' ? 'Today' : option[0]!.toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
          <div className="signal-month-nav">
            <button
              className="secondary"
              onClick={() => goto(view, shiftCalendarAnchor(view, anchor, -1))}
              aria-label={`Previous ${spanLabel}`}
            >
              <ChevronLeft />
            </button>
            <div>
              <CalendarClock aria-hidden="true" />
              <h2 id="signal-range-title">{title}</h2>
            </div>
            <button className="secondary" onClick={() => goto(view, now)}>
              Today
            </button>
            <button
              className="secondary"
              onClick={() => goto(view, shiftCalendarAnchor(view, anchor, 1))}
              aria-label={`Next ${spanLabel}`}
            >
              <ChevronRight />
            </button>
          </div>
          <div className={`signal-weekdays view-${view}`} aria-hidden="true">
            {weekdays.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className={`signal-grid view-${view}`}>
            {Array.from({ length: leading }, (_, index) => (
              <div className="signal-day is-blank" key={`blank-${index}`} />
            ))}
            {days.map((date) => {
              const scheduled = byDate.get(date) ?? [];
              return (
                <section
                  className={`signal-day ${date === now ? 'is-today' : ''}`}
                  key={date}
                  aria-label={date}
                >
                  <header>
                    <span>{Number(date.slice(-2))}</span>
                    {date === now && <strong>Today</strong>}
                  </header>
                  {scheduled.length === 0 ? (
                    <span className="signal-day-empty">No posts</span>
                  ) : (
                    <ul>
                      {scheduled.map((post) => (
                        <li key={post.id}>
                          <Post post={post} open={setEditing} preview />
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
          key={editing.id}
          post={editing}
          close={() => setEditing(null)}
          saved={refreshed}
          opened={async (post) => {
            await load();
            setEditing(post);
          }}
          removed={refreshed}
        />
      )}
    </>
  );
}
