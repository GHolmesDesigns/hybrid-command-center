import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
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
  RotateCcw,
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
  SIGNAL_DEFAULT_TIME,
  SIGNAL_DELIVERY_PROVENANCE_LABEL,
  SIGNAL_DELIVERY_PROVENANCES,
  SIGNAL_FORMAT_LABEL,
  SIGNAL_FORMATS,
  SIGNAL_CLIENT_UNBOUND,
  SIGNAL_CLIENT_UNBOUND_LABEL,
  SIGNAL_LIFECYCLE_FILTER_LABEL,
  SIGNAL_LIFECYCLE_FILTERS,
  SIGNAL_STATUS_LABEL,
  SIGNAL_STATUSES,
  isSignalDate,
  parseSignalCreateParam,
  resolveSignalChannelPreset,
  signalChannelPresentation,
  signalMediaKindFor,
  signalTextHasLink,
  type SignalCampaignSummary,
  type SignalChannel,
  type SignalCta,
  type SignalDeliveryProvenance,
  type SignalFormat,
  type SignalLifecycleFilter,
  type SignalPost,
  type SignalSlot,
  type SignalStatus,
} from '../../../shared/signal';
import {
  SIGNAL_CAMPAIGN_NONE,
  SIGNAL_CAMPAIGN_NONE_LABEL,
} from '../../../shared/signal-campaign-analytics';
import {
  urlPostMedia,
  signalPostMediaIssue,
  type SignalPostMedia,
} from '../../../shared/signal-media';
import { formatFileSize } from '../../../shared/drive';
import {
  CALENDAR_VIEWS,
  calendarMonthGridRange,
  calendarViewRange,
  shiftCalendarAnchor,
  type CalendarViewMode,
} from '../../../shared/calendar';
import {
  isCurrentTimePeriod,
  resolveViewChoice,
  type ViewDefaults,
} from '../../../shared/view-defaults';
import type { Client, Project } from '../../../shared/types';
import { signalChannelStyle, type TagDraft } from './ui-shared';
import { ClientCue } from './ClientCue';
import { Empty, SearchBox } from './Primitives';
import { Select, TagChipInput } from './FormControls';
import { SignalCampaignAnalyticsPanel } from './SignalCampaignAnalytics';
import { PageHead } from './Shell';
import {
  deliveryModeFor,
  deliveryModeInstruction,
  deliveryTargetAwaitsPerson,
  deliveryTargetSummary,
  isReconcilableState,
  providerRecordIsMutable,
  providerRecordIsPublished,
  publicationTracksProvider,
  publishPreviewRefusals,
  reconcileSchedule,
  DELIVERY_GROUP_LABEL,
  DELIVERY_MODE_LABEL,
  PROVIDER_ACTION_DESCRIPTION,
  PROVIDER_ACTION_LABEL,
  PROVIDER_DIFF_FIELD_LABEL,
  PROVIDER_POST_STATE_LABEL,
  PUBLICATION_STATE_DESCRIPTION,
  PUBLICATION_STATE_GROUP,
  PUBLICATION_STATE_LABEL,
  PUBLISH_CHANNEL_STATUS_LABEL,
  type DeliveryGroup,
  type ProviderAction,
  type ProviderReconcilePreview,
  type PublishPreview,
  type SignalPublication,
  type SignalPublicationTarget,
} from '../../../shared/publish';
import {
  CARD_DELIVERY_LABEL,
  type CardDelivery,
  type CardDeliverySnapshot,
  type CardDeliveryState,
} from '../../../shared/card-delivery';
import {
  publishPlatformFor,
  publishPostKindFor,
  PUBLISH_PLATFORM_LABEL,
  type PublishPlatform,
} from '../../../shared/publish-capabilities';
import { variantRolePayload, type PublishVariantRecord } from '../../../shared/publish-variants';
import type { PublishVariantMediaRole } from '../../../shared/publish-variant-media';
import { PlatformVariantsEditor, PublishPreviewTabs } from './SignalVariants';
import { SignalHealthPanel } from './SignalHealth';
import { SignalProviderInventoryPanel } from './SignalProviderInventory';
import { SignalAnalyticsWindowPanel } from './SignalAnalyticsWindow';
import { SignalMetrics } from './SignalMetrics';
import { previewPlatforms, variantList, variantMap } from './signal-variants';
import { BUFFER_PROVIDER } from '../../../shared/buffer';
import {
  POST_BRIDGE_PUBLISH_NOW_EVIDENCE,
  publishNowEvidenceEnabled,
} from '../../../shared/publish-now';

type SignalRange = {
  from: string;
  to: string;
  posts: SignalPost[];
  truncated: boolean;
};

type Draft = {
  clientId: string;
  projectId: string;
  text: string;
  channels: SignalChannel[];
  /**
   * The whole ordered media list as descriptors, public URLs and Drive references together.
   *
   * The draft holds what the post holds. A Drive reference's metadata is never edited here and is
   * never sent back: the save states the source and the link, and the server answers with whatever
   * Drive says — which is what makes the stored fingerprint evidence rather than a claim.
   */
  media: SignalPostMedia[];
  date: string;
  time: string;
  format: SignalFormat;
  status: SignalStatus;
  deliveryProvenance: SignalDeliveryProvenance;
  /**
   * The campaigns the draft carries, as chips.
   *
   * A chip typed into the form has a name and no id yet, which is exactly the shape
   * `TagChipInput` works in and the reason the save sends **names**: the server resolves each one
   * against the shared list, so a campaign is never created by a save that then fails.
   */
  campaigns: TagDraft[];
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
  clientId: post.client?.id ?? '',
  projectId: post.projectId ?? '',
  text: post.text,
  channels: post.channels,
  media: post.media,
  date: post.date ?? '',
  time: post.time,
  format: post.format,
  status: post.status,
  deliveryProvenance: post.deliveryProvenance,
  campaigns: post.campaigns,
  cta: post.cta,
});

/**
 * An empty draft for the shared Add Post form.
 *
 * A day-cell entry passes that cell's `YYYY-MM-DD` string; the top navigation and queue actions
 * pass `null` so the post starts in the unscheduled queue. Nothing is written until Save.
 */
const blankDraft = (date: string | null): Draft => ({
  clientId: '',
  projectId: '',
  text: '',
  channels: [],
  media: [],
  date: date ?? '',
  time: SIGNAL_DEFAULT_TIME,
  format: 'TEXT',
  status: 'DRAFT',
  deliveryProvenance: 'IN_SIGNAL',
  campaigns: [],
  cta: 'NONE',
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
 * Delivery on a planner card: icon shape plus words, never colour alone.
 *
 * Reuses the same shapes the delivery panel already taught — check, clock, alert, stop — so a
 * card and an open post agree about what "needs attention" looks like.
 */
const CardDeliveryIcon = ({ state }: { state: CardDeliveryState }) => {
  if (state === 'DELIVERED') return <CheckCircle2 aria-hidden="true" />;
  if (state === 'FAILED' || state === 'AMBIGUOUS' || state === 'PARTIAL' || state === 'MANUAL')
    return <AlertTriangle aria-hidden="true" />;
  if (state === 'IN_FLIGHT') return <Clock3 aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
};

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

/**
 * Planning status, delivery, and lifecycle/provenance cues — each named separately.
 *
 * Planning is the user's Draft/Scheduled/Published claim. Delivery is what a provider did.
 * Lifecycle (Retired) and Outside of Signal provenance are third and fourth facts; neither
 * reuses a planning-status word.
 */
function PostMeta({ post, delivery }: { post: SignalPost; delivery: CardDelivery }) {
  return (
    <div className="signal-post-meta">
      <span className={`signal-status status-${post.status.toLowerCase()}`}>
        <StatusIcon status={post.status} />
        <span className="sr-only">Planning: </span>
        {SIGNAL_STATUS_LABEL[post.status]}
      </span>
      <ClientCue client={post.client} />
      <span className={`signal-card-delivery delivery-${delivery.state.toLowerCase()}`}>
        <CardDeliveryIcon state={delivery.state} />
        <span className="sr-only">Delivery: </span>
        {delivery.label}
      </span>
      {post.lifecycle === 'RETIRED' && (
        <span className="signal-lifecycle lifecycle-retired">
          <Archive aria-hidden="true" />
          <span className="sr-only">Lifecycle: </span>
          Retired
        </span>
      )}
      {post.deliveryProvenance === 'OUTSIDE_SIGNAL' && (
        <span className="signal-provenance provenance-outside">
          <AlertTriangle aria-hidden="true" />
          <span className="sr-only">Provenance: </span>
          Outside of Signal
        </span>
      )}
      {post.channels.map((channel) => (
        <ChannelChip channel={channel} key={channel} />
      ))}
    </div>
  );
}

const X_LINK_WARNING =
  'X removes links from the post body. Move this link to a reply before publishing.';

/**
 * A delivery group, painted and said.
 *
 * The colour is never the only cue: the group carries its own icon shape and the state's own
 * words sit beside it, so "needs attention" survives greyscale, colour-blindness, and a screen
 * reader reading the row aloud.
 */
function DeliveryChip({ group, children }: { group: DeliveryGroup; children: string }) {
  const Icon =
    group === 'DELIVERED'
      ? CheckCircle2
      : group === 'ATTENTION'
        ? AlertTriangle
        : group === 'STOPPED'
          ? X
          : Clock3;
  return (
    <span className={`signal-delivery-chip delivery-${group.toLowerCase()}`}>
      <Icon aria-hidden="true" />
      <span className="sr-only">{DELIVERY_GROUP_LABEL[group]}: </span>
      {children}
    </span>
  );
}

/**
 * The provider comparison, side by side, above the buttons that act on it.
 *
 * Two columns rather than a merged "what changed" sentence, because the whole point of the panel is
 * that two systems hold two values and the user is choosing which one wins. A merged line would say
 * *the caption changed* and leave them to remember what it used to be.
 *
 * Every action carries its own refusals, so a button is either pressable or replaced by the reason
 * it is not — there is no disabled control here whose reason lives in a tooltip.
 */
function ProviderReconcilePanel({
  preview,
  busy,
  apply,
  close,
}: {
  preview: ProviderReconcilePreview;
  busy: boolean;
  apply: (action: ProviderAction) => void;
  close: () => void;
}) {
  return (
    <section className="signal-provider-reconcile" aria-label="Provider comparison">
      <h4>Signal and the provider</h4>
      {preview.record && (
        <p className="signal-provider-state">
          <DeliveryChip
            group={
              providerRecordIsPublished(preview.record.state)
                ? 'DELIVERED'
                : providerRecordIsMutable(preview.record.state)
                  ? 'IN_FLIGHT'
                  : 'ATTENTION'
            }
          >
            {PROVIDER_POST_STATE_LABEL[preview.record.state]}
          </DeliveryChip>{' '}
          <span>Provider post {preview.record.providerPostId}</span>
        </p>
      )}
      {preview.refusals.map((refusal) => (
        <p className="form-error" key={refusal}>
          {refusal}
        </p>
      ))}
      {preview.warnings.map((warning) => (
        <p className="signal-provider-warning" key={warning}>
          {warning}
        </p>
      ))}
      {preview.record && (
        <table className="signal-provider-diff">
          <caption>
            {preview.changed.length === 1
              ? '1 field differs.'
              : preview.changed.length
                ? `${preview.changed.length} fields differ.`
                : 'Signal and the provider agree on every field.'}
          </caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Signal</th>
              <th scope="col">Provider</th>
            </tr>
          </thead>
          <tbody>
            {preview.diffs.map((diff) => (
              <tr
                key={diff.field}
                className={diff.changed ? 'signal-provider-diff-changed' : undefined}
              >
                <th scope="row">
                  {PROVIDER_DIFF_FIELD_LABEL[diff.field]}
                  {/* The state is said as well as painted, so the row that differs is legible
                      without colour — the same rule the delivery chips follow. */}
                  {diff.changed && <span className="signal-provider-diff-flag"> · differs</span>}
                </th>
                <td>{diff.local}</td>
                <td>{diff.remote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ul className="signal-provider-actions">
        {preview.actions.map((offer) => (
          <li key={offer.action}>
            <p className="signal-provider-action-name">
              <strong>{PROVIDER_ACTION_LABEL[offer.action]}</strong>
            </p>
            <p className="signal-provider-action-note">
              {PROVIDER_ACTION_DESCRIPTION[offer.action]}
            </p>
            {offer.available ? (
              <button
                type="button"
                className="secondary"
                onClick={() => apply(offer.action)}
                disabled={busy}
              >
                {PROVIDER_ACTION_LABEL[offer.action]}
              </button>
            ) : (
              offer.refusals.map((refusal) => (
                <p className="signal-provider-refusal" key={refusal}>
                  {refusal}
                </p>
              ))
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="secondary" onClick={close} disabled={busy}>
        Close comparison
      </button>
    </section>
  );
}

/** What a delivery's platform is called in a sentence, falling back to the channel's own name. */
const platformLabelFor = (platform: PublishPlatform | null, channel: SignalChannel) =>
  platform ? PUBLISH_PLATFORM_LABEL[platform] : SIGNAL_CHANNEL_LABEL[channel];

/** One provider account's delivery: what it took, how far it got, and what is left for a person. */
function DeliveryTarget({
  publication,
  target,
  busy,
  finish,
  preview,
  compare,
  apply,
  close,
}: {
  publication: SignalPublication;
  target: SignalPublicationTarget;
  busy: boolean;
  finish: () => void;
  preview?: ProviderReconcilePreview;
  compare?: () => void;
  apply?: (action: ProviderAction) => void;
  close?: () => void;
}) {
  const summary = deliveryTargetSummary(publication, target);
  const platformLabel = platformLabelFor(target.platform, target.channel);
  return (
    <li className={`signal-delivery-target delivery-${summary.group.toLowerCase()}`}>
      <p className="signal-delivery-target-head">
        <ChannelChip channel={target.channel} />
        <strong>{SIGNAL_CHANNEL_LABEL[target.channel]}</strong>
        {target.handle ? ` → ${target.handle}` : ''}{' '}
        <DeliveryChip group={summary.group}>{summary.label}</DeliveryChip>
      </p>
      <p className="signal-delivery-mode">
        <strong>{DELIVERY_MODE_LABEL[target.mode]}.</strong>{' '}
        {deliveryModeInstruction(target.mode, platformLabel)}
      </p>
      {target.permalink && (
        <p>
          <a href={target.permalink} target="_blank" rel="noreferrer noopener">
            Open the {platformLabel} post
          </a>
        </p>
      )}
      {target.error && <p className="form-error">{target.error}</p>}
      {target.manualCompletedAt && (
        <p className="signal-delivery-checked">
          You marked this finished on {new Date(target.manualCompletedAt).toLocaleString()}.
        </p>
      )}
      {deliveryTargetAwaitsPerson(target) && (
        <button type="button" className="secondary" disabled={busy} onClick={finish}>
          Mark {platformLabel} finished
        </button>
      )}
      {target.provider === BUFFER_PROVIDER &&
        target.remotePostId &&
        (preview && apply && close ? (
          <ProviderReconcilePanel preview={preview} busy={busy} apply={apply} close={close} />
        ) : (
          compare && (
            <button type="button" className="secondary" disabled={busy} onClick={compare}>
              Compare this Buffer target
            </button>
          )
        ))}
    </li>
  );
}

/**
 * Editing and expanding are siblings, never nested: a control inside the edit button would be
 * invalid markup and would never receive its own click.
 */
function Post({
  post,
  delivery,
  open,
  preview = false,
}: {
  post: SignalPost;
  delivery: CardDelivery;
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
        <PostMeta post={post} delivery={delivery} />
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
  createDate = null,
  campaigns,
  clients,
  projects,
  defaultClientId = '',
  close,
  saved,
  opened,
  removed,
}: {
  /** Null means Add Post: the same form, writing with POST on save rather than PATCH. */
  post: SignalPost | null;
  /** Prefill when creating; ignored when editing. Null is the unscheduled queue. */
  createDate?: string | null;
  /** The workspace's campaigns, for the chip input to suggest from. Loaded once by the planner. */
  campaigns: SignalCampaignSummary[];
  clients: Client[];
  projects: Project[];
  defaultClientId?: string;
  close: () => void;
  saved: (post: SignalPost) => Promise<void>;
  opened: (post: SignalPost) => Promise<void>;
  removed: (id: string) => Promise<void>;
}) {
  const creating = post === null;
  const [draft, setDraft] = useState(() => {
    if (post) return draftFor(post);
    return { ...blankDraft(createDate), clientId: defaultClientId };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mediaInput, setMediaInput] = useState('');
  const [driveInput, setDriveInput] = useState('');
  const [driveBusy, setDriveBusy] = useState(false);
  /** The refusal from the last paste, shown under the Drive input and cleared by the next one. */
  const [driveError, setDriveError] = useState('');
  /**
   * The refusal from the last recheck of each Drive reference, by file id.
   *
   * Kept per reference rather than as one message so that a failure stays attached to the file it
   * is about — the reference is still there, still showing the metadata it had, and the reason it
   * could not be confirmed belongs beside it rather than at the top of the form.
   */
  const [recheckErrors, setRecheckErrors] = useState<Record<string, string>>({});
  const [recheckingId, setRecheckingId] = useState('');
  const [publishPreview, setPublishPreview] = useState<PublishPreview | null>(null);
  const [publications, setPublications] = useState<SignalPublication[]>([]);
  /**
   * The open provider comparison, keyed by the publication it belongs to.
   *
   * One at a time, and never opened on its own: it is a read of somebody else's record, so it
   * happens when a person asks for it and is dropped the moment an action lands, which forces the
   * next decision to be taken against a freshly read record rather than a stale panel.
   */
  const [providerPreview, setProviderPreview] = useState<ProviderReconcilePreview | null>(null);
  const [providerPreviewTarget, setProviderPreviewTarget] = useState<number | null>(null);
  const [deliveryTick, setDeliveryTick] = useState(0);
  const [presetNotice, setPresetNotice] = useState('');
  const checked = useRef(new Set<string>());
  /**
   * Guards overlapping **Show preview** presses before React can disable the button.
   *
   * `setBusy(true)` is not synchronous with the DOM, so a second click can start another preview
   * while the first is still in flight — a duplicate account refresh and a race where the first
   * failure can overwrite a later success. One in-flight promise is the whole of the guard.
   */
  const previewInFlight = useRef<Promise<void> | null>(null);
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
  const hasUnsavedChanges = creating
    ? JSON.stringify(draft) !== JSON.stringify(blankDraft(createDate))
    : JSON.stringify(draft) !== JSON.stringify(draftFor(post));
  const hasUnsavedVariants =
    JSON.stringify(variantList(layers)) !== JSON.stringify(variantList(savedLayers));
  const hasPublishableChannel = Boolean(post?.channels.some((channel) => channel !== 'blog'));
  const publishNowOffered =
    POST_BRIDGE_PUBLISH_NOW_EVIDENCE.enabled ||
    publishNowEvidenceEnabled() ||
    import.meta.env.VITE_PUBLISH_NOW_EVIDENCE === '1';
  const hasTailorablePlatform = post ? previewPlatforms(post).length > 0 : false;
  const warnsAboutXLink = draft.channels.includes('x') && signalTextHasLink(draft.text);
  const availableProjects = draft.clientId
    ? projects.filter((project) => project.clientId === draft.clientId)
    : [];
  /**
   * Channels on this post that no submission reaches, answered from the same capability contract
   * preflight uses rather than by testing for `blog` by name — a format that leaves a channel with
   * no route is the same fact arriving a different way.
   */
  const undeliverable = useMemo(() => {
    if (!post) return [];
    const delivered = new Set(
      publications.flatMap((publication) => publication.targets.map((target) => target.channel)),
    );
    return post.channels.filter(
      (channel) =>
        !delivered.has(channel) &&
        deliveryModeFor(publishPlatformFor(channel), publishPostKindFor(post.format)) ===
          'UNSUPPORTED',
    );
  }, [post, publications]);
  /**
   * The result identities the deliveries are carrying, as one string.
   *
   * The figures panel re-reads its stored rows when this changes, which is exactly when a refreshed
   * delivery has captured an identity there was none of before — until then the panel is correctly
   * saying it has nothing to ask about. A string rather than the publications themselves so a render
   * that captured nothing new re-reads nothing.
   */
  const metricsKey = useMemo(
    () =>
      publications
        .map(
          (publication) =>
            `${publication.id}:${publication.targets
              .map((target) => `${target.accountId}=${target.resultId ?? ''}`)
              .join(',')}`,
        )
        .join('|'),
    [publications],
  );

  useEffect(() => {
    textRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [close]);

  useEffect(() => {
    if (!post) {
      setPublications([]);
      return;
    }
    api<SignalPublication[]>(`/signal/posts/${post.id}/publications`)
      .then(setPublications)
      .catch(() => setPublications([]));
  }, [post]);

  /**
   * The stored overrides, read as text and nothing else.
   *
   * This is the one request the editor makes on open besides the delivery history, and it touches
   * no remote host: the layers are local rows, and the media addresses in them stay addresses until
   * the preview is asked for.
   */
  useEffect(() => {
    if (!post) {
      setSavedLayers(variantMap([]));
      setLayers(variantMap([]));
      return;
    }
    api<PublishVariantRecord[]>(`/signal/posts/${post.id}/variants`)
      .then((stored) => {
        setSavedLayers(variantMap(stored));
        setLayers(variantMap(stored));
      })
      .catch(() => {
        setSavedLayers(variantMap([]));
        setLayers(variantMap([]));
      });
  }, [post]);

  const saveVariants = async (): Promise<boolean> => {
    if (!post) return false;
    setBusy(true);
    setError('');
    try {
      const stored = await send<PublishVariantRecord[]>(
        `/signal/posts/${post.id}/variants`,
        'PUT',
        // The roles go out as `{ source, url }` rather than as whole descriptors: Drive metadata is
        // never accepted from a request, so a Drive role is stated as its link and resolved again by
        // the server (`server/signal/service.ts`).
        { variants: variantList(layers).map(variantRolePayload), revision: post.revision },
      );
      setSavedLayers(variantMap(stored));
      setLayers(variantMap(stored));
      await opened(await api<SignalPost>(`/signal/posts/${post.id}`));
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * One pasted Drive link resolved for a variant role, through the same route the composer's own
   * media uses.
   *
   * The server parses, host-checks, and looks the file up; this only hands back what it answered.
   * Saving the layer resolves the link again through the same rule, so the stored fingerprint is the
   * one taken at the moment of the write rather than at the moment of the paste.
   */
  const resolveRoleDrive = (link: string) =>
    send<SignalPostMedia>('/signal/drive-media/resolve', 'POST', { link });

  /**
   * Checks one layer's stored role against Drive again, on purpose.
   *
   * The route rewrites the whole variant set through the ordinary replacement, so the answer is the
   * new set and the post's `updated_at` moves exactly when the file's version did — which is why the
   * open preview is dropped here rather than left showing a plan that may no longer be current.
   */
  const recheckRoleMedia = async (
    platform: PublishPlatform,
    accountId: number | null,
    role: PublishVariantMediaRole,
  ) => {
    if (!post) return;
    const stored = await send<PublishVariantRecord[]>(
      `/signal/posts/${post.id}/variants/media/recheck`,
      'POST',
      { platform, accountId, role },
    );
    setSavedLayers(variantMap(stored));
    setLayers(variantMap(stored));
    setPublishPreview(null);
    await opened(post);
  };

  const previewPublish = async () => {
    if (!post) return;
    if (previewInFlight.current) return previewInFlight.current;
    setBusy(true);
    setError('');
    const run = (async () => {
      try {
        setPublishPreview(
          await send<PublishPreview>(`/signal/posts/${post.id}/publish/preview`, 'POST', {}),
        );
      } catch (reason) {
        setError((reason as Error).message);
      } finally {
        setBusy(false);
        previewInFlight.current = null;
      }
    })();
    previewInFlight.current = run;
    return run;
  };

  const previewPublishNow = async () => {
    if (!post) return;
    if (previewInFlight.current) return previewInFlight.current;
    setBusy(true);
    setError('');
    const run = (async () => {
      try {
        setPublishPreview(
          await send<PublishPreview>(`/signal/posts/${post.id}/publish-now/preview`, 'POST', {}),
        );
      } catch (reason) {
        setError((reason as Error).message);
      } finally {
        setBusy(false);
        previewInFlight.current = null;
      }
    })();
    previewInFlight.current = run;
    return run;
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

  /**
   * Persists the whole explicit target selection, then re-previews.
   *
   * Re-previewing is not a nicety: the plan hash covers the chosen ids and what each resolved to,
   * so a selection saved against an open confirmation has to produce a new preview before anything
   * can be confirmed. Saving and leaving the old hash on screen would offer a button that the
   * server would then refuse.
   */
  const saveTargets = async (targets: { channel: string; providerAccountIds: number[] }[]) => {
    if (!post) return;
    if (previewInFlight.current) await previewInFlight.current;
    setBusy(true);
    setError('');
    try {
      await send(`/signal/posts/${post.id}/publish-targets`, 'PUT', {
        targets,
        revision: post.revision,
      });
      await opened(await api<SignalPost>(`/signal/posts/${post.id}`));
      const previewPath =
        publishPreview?.timing === 'now'
          ? `/signal/posts/${post.id}/publish-now/preview`
          : `/signal/posts/${post.id}/publish/preview`;
      setPublishPreview(await send<PublishPreview>(previewPath, 'POST', {}));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not save the accounts.');
    } finally {
      setBusy(false);
    }
  };

  const confirmPublish = async () => {
    if (!post || !publishPreview || publishPreviewRefusals(publishPreview).length) return;
    setBusy(true);
    setError('');
    try {
      const path =
        publishPreview.timing === 'now'
          ? `/signal/posts/${post.id}/publish-now`
          : `/signal/posts/${post.id}/publish`;
      const publication = await send<SignalPublication>(path, 'POST', {
        planHash: publishPreview.planHash,
      });
      setPublications((current) => [publication, ...current]);
      setPublishPreview(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const markPublished = async () => {
    if (!post) return;
    setBusy(true);
    setError('');
    try {
      await saved(
        await send<SignalPost>(`/signal/posts/${post.id}`, 'PATCH', {
          status: 'PUBLISHED',
          revision: post.revision,
        }),
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
        { automatic: false },
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

  /**
   * Reads the provider's record beside Signal's plan. Writes nothing on either side.
   *
   * `keepError` is for the one caller that already has something to say: a refused action retakes
   * the comparison, and clearing the message on the way would erase the refusal that explains why
   * the panel just changed under the reader.
   */
  const compareProvider = async (publicationId: string, keepError = false, accountId?: number) => {
    setBusy(true);
    if (!keepError) setError('');
    try {
      setProviderPreviewTarget(accountId ?? null);
      setProviderPreview(
        await send<ProviderReconcilePreview>(
          accountId === undefined
            ? `/signal/publications/${publicationId}/provider/preview`
            : `/signal/publications/${publicationId}/targets/${accountId}/provider/preview`,
          'POST',
        ),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Commits one action against the provider's copy, carrying the token the comparison returned.
   *
   * The publication list is replaced from the response rather than patched, and the panel is
   * closed: a restore-and-resubmit answers with a *different* publication, so a panel still open on
   * the old one would be describing a record that no longer exists. The delivery history is reread
   * for the same reason.
   */
  const applyProviderAction = async (
    publicationId: string,
    action: ProviderAction,
    accountId?: number,
  ) => {
    if (!post || !providerPreview) return;
    setBusy(true);
    setError('');
    try {
      await send<SignalPublication>(
        accountId === undefined
          ? `/signal/publications/${publicationId}/provider/apply`
          : `/signal/publications/${publicationId}/targets/${accountId}/provider/apply`,
        'POST',
        { action, reconcileHash: providerPreview.reconcileHash },
      );
      setProviderPreview(null);
      setProviderPreviewTarget(null);
      setPublications(await api<SignalPublication[]>(`/signal/posts/${post.id}/publications`));
    } catch (reason) {
      setError((reason as Error).message);
      // A refused action leaves the panel open on a comparison that is now known to be stale, so
      // it is taken again rather than left showing what the refusal just contradicted — and the
      // refusal itself is kept, because it is the reason the panel changed.
      await compareProvider(publicationId, true, accountId).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const finishDelivery = async (publicationId: string, accountId: number) => {
    setBusy(true);
    setError('');
    try {
      const updated = await send<SignalPublication>(
        `/signal/publications/${publicationId}/targets/${accountId}/finish`,
        'POST',
      );
      setPublications((current) =>
        current.map((publication) => (publication.id === updated.id ? updated : publication)),
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * The reconciliation timer.
   *
   * This app has no background job, so the open planner is the only thing that can ask a provider
   * what happened. It holds one timer for the soonest publication that is due, and the schedule it
   * reads is the shared one — the same rule the server enforces, so an early tick costs a refused
   * check rather than a provider call.
   *
   * `checked` remembers which attempt of which publication has already been asked, so a check the
   * server answers from storage cannot become a loop: the key only changes once an attempt is
   * actually spent.
   */
  useEffect(() => {
    const now = new Date();
    const schedules = publications.map(
      (publication) => [publication, reconcileSchedule(publication, now)] as const,
    );
    const due = schedules.filter(
      ([publication, schedule]) =>
        schedule.due && !checked.current.has(`${publication.id}:${publication.checkAttempts}`),
    );
    if (due.length) {
      for (const [publication] of due)
        checked.current.add(`${publication.id}:${publication.checkAttempts}`);
      let cancelled = false;
      void Promise.all(
        due.map(([publication]) =>
          send<SignalPublication>(`/signal/publications/${publication.id}/reconcile`, 'POST', {
            automatic: true,
          }).catch(() => null),
        ),
      ).then((results) => {
        if (cancelled) return;
        setPublications((current) =>
          current.map(
            (publication) => results.find((result) => result?.id === publication.id) ?? publication,
          ),
        );
      });
      return () => {
        cancelled = true;
      };
    }
    const upcoming = schedules
      .map(([, schedule]) => schedule.dueAt)
      .filter((dueAt): dueAt is string => Boolean(dueAt))
      .map((dueAt) => Date.parse(dueAt) - now.getTime());
    if (!upcoming.length) return;
    // Re-evaluate at the soonest due moment, and at least once a minute so a long wait still
    // refreshes the "next check" line the reader is looking at.
    const wait = Math.min(Math.max(Math.min(...upcoming), 1_000), 60_000);
    const timer = setTimeout(() => setDeliveryTick((tick) => tick + 1), wait);
    return () => clearTimeout(timer);
  }, [publications, deliveryTick]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.text.trim()) {
      setError('A post needs content.');
      return;
    }
    setBusy(true);
    setError('');
    const body = {
      ...draft,
      text: draft.text.trim(),
      date: draft.date || null,
      // The source and the address, and nothing else. A Drive item sends its link, which the
      // server parses and resolves; the metadata beside it here is what the server last said and
      // is never sent back as if it were a fact this form knows.
      media: draft.media.map((item) => ({ source: item.source, url: item.url })),
      clientId: draft.clientId || null,
      projectId: draft.projectId || null,
      // Names, so a campaign typed here is resolved or created inside the same transaction as the
      // post. An empty array is *this post belongs to none*, which is why it is always sent.
      campaigns: draft.campaigns.map((campaign) => campaign.name),
    };
    try {
      const next = creating
        ? await send<SignalPost>('/signal/posts', 'POST', body)
        : await send<SignalPost>(`/signal/posts/${post.id}`, 'PATCH', {
            ...body,
            revision: post.revision,
          });
      await saved(next);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!post) return;
    if (
      !window.confirm(
        'Retire this Signal plan?\n\nIt will leave the ordinary planner, calendar, and queue-health counts. Publication history stays. This does not withdraw a provider submission and does not unpublish platform content. There is no undelete in this version.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await send(`/signal/posts/${post.id}/retire`, 'POST');
      await removed(post.id);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  const duplicate = async () => {
    if (!post) return;
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
    if (!post) return;
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
    if (!post || !suggestedSlot) return;
    setBusy(true);
    setError('');
    try {
      const next = await send<SignalPost>(`/signal/posts/${post.id}/slot`, 'POST', {
        ...suggestedSlot,
        from: today(),
        revision: post.revision,
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
    const issue = signalPostMediaIssue(urlPostMedia(value));
    if (issue) {
      setError(issue);
      return;
    }
    setDraft((current) => ({ ...current, media: [...current.media, urlPostMedia(value)] }));
    setMediaInput('');
    setError('');
  };

  /**
   * Resolves a pasted Drive link and puts what came back in the draft.
   *
   * The server does the parsing, the host check, and the lookup; this shows the answer. What is
   * held here is a preview of the reference — the save resolves the link again through the same
   * rule, so the stored fingerprint is the one taken at the moment of the write.
   */
  const addDriveMedia = async () => {
    const link = driveInput.trim();
    if (!link) return;
    setDriveBusy(true);
    setDriveError('');
    try {
      const resolved = await send<SignalPostMedia>('/signal/drive-media/resolve', 'POST', { link });
      if (
        draft.media.some(
          (item) => item.source === 'DRIVE' && item.driveFileId === resolved.driveFileId,
        )
      ) {
        setDriveError('This post already carries that Drive file.');
        return;
      }
      setDraft((current) => ({ ...current, media: [...current.media, resolved] }));
      setDriveInput('');
    } catch (reason) {
      setDriveError((reason as Error).message);
    } finally {
      setDriveBusy(false);
    }
  };

  /**
   * Checks one saved Drive reference against Drive again, on purpose.
   *
   * Only for a reference the post has actually stored, and only with the form clean: it is a write
   * through the ordinary edit transaction, so running it over unsaved edits would either discard
   * them or save them without being asked. A failure leaves the reference and its last known
   * metadata exactly where they are and shows the reason beside it.
   */
  const recheckDriveMedia = async (driveFileId: string) => {
    if (!post) return;
    setRecheckingId(driveFileId);
    setDriveError('');
    setRecheckErrors((current) => {
      const next = { ...current };
      delete next[driveFileId];
      return next;
    });
    try {
      const next = await send<SignalPost>(`/signal/posts/${post.id}/media/recheck`, 'POST', {
        driveFileId,
      });
      setDraft(draftFor(next));
      // The fingerprint moved, so any preview taken against the old one is no longer the plan.
      setPublishPreview(null);
      // `opened` rather than `saved`: saving closes the composer, and a recheck is something you do
      // while composing — the whole point is to see what came back beside the reference it is about.
      await opened(next);
    } catch (reason) {
      setRecheckErrors((current) => ({ ...current, [driveFileId]: (reason as Error).message }));
    } finally {
      setRecheckingId('');
    }
  };

  const updateMedia = (index: number, value: string) =>
    setDraft((current) => ({
      ...current,
      media: current.media.map((item, currentIndex) =>
        currentIndex === index ? urlPostMedia(value) : item,
      ),
    }));

  const moveMedia = (index: number, by: number) =>
    setDraft((current) => {
      const next = [...current.media];
      const [moved] = next.splice(index, 1);
      next.splice(index + by, 0, moved as SignalPostMedia);
      return { ...current, media: next };
    });

  const removeMedia = (index: number) =>
    setDraft((current) => ({
      ...current,
      media: current.media.filter((_item, currentIndex) => currentIndex !== index),
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
            <h2 id="signal-editor-title">{creating ? 'Add post' : 'Edit post'}</h2>
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
            <p>
              A public https URL, or a file in the connected Drive. Signal stores the references and
              never the files.
            </p>
            {draft.media.length > 0 && (
              <ol>
                {draft.media.map((item, index) => (
                  <li key={`${index}-${item.url}`}>
                    {item.source === 'DRIVE' ? (
                      <div className="signal-media-drive">
                        <span className="signal-media-source">Drive file {index + 1}</span>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          {item.driveName}
                        </a>
                        <span className="signal-media-detail">
                          {`${item.mimeType} · ${formatFileSize(item.sizeBytes)}`}
                        </span>
                        <span className="signal-media-detail">
                          {item.driveVerifiedAt
                            ? `Checked ${new Date(item.driveVerifiedAt).toLocaleString()}`
                            : 'Not checked yet'}
                        </span>
                        {recheckErrors[item.driveFileId ?? ''] && (
                          <p className="signal-media-unresolved" role="status">
                            <AlertTriangle aria-hidden="true" /> Could not confirm this file:{' '}
                            {recheckErrors[item.driveFileId ?? '']} The details above are the last
                            ones Drive gave.
                          </p>
                        )}
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => recheckDriveMedia(item.driveFileId as string)}
                          disabled={
                            busy ||
                            recheckingId !== '' ||
                            hasUnsavedChanges ||
                            !post?.media.some(
                              (stored) =>
                                stored.source === 'DRIVE' &&
                                stored.driveFileId === item.driveFileId,
                            )
                          }
                          title={
                            hasUnsavedChanges
                              ? 'Save this post before rechecking: a recheck is itself an edit.'
                              : undefined
                          }
                        >
                          <RefreshCw aria-hidden="true" /> Recheck Drive file
                        </button>
                      </div>
                    ) : (
                      <label>
                        <span>Media URL {index + 1}</span>
                        <input
                          type="url"
                          value={item.url}
                          onChange={(event) => updateMedia(index, event.target.value)}
                          required
                        />
                      </label>
                    )}
                    <span className="signal-media-kind">{signalMediaKindFor(item)}</span>
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
                        disabled={index === draft.media.length - 1}
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
            {/*
              Pasting a link is the whole input surface for a Drive file: there is no picker, and
              no way to name a file by id. The link is sent to the server, which parses it, checks
              the host, and asks Drive what the file is — the browser is shown the answer and never
              given a way to read the file itself.
            */}
            <div className="signal-media-add">
              <label>
                Add a Drive file by link
                <input
                  type="text"
                  inputMode="url"
                  placeholder="https://drive.google.com/file/d/…/view"
                  value={driveInput}
                  onChange={(event) => setDriveInput(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="secondary"
                onClick={addDriveMedia}
                disabled={driveBusy || !driveInput.trim()}
              >
                <Plus /> {driveBusy ? 'Checking…' : 'Add Drive file'}
              </button>
            </div>
            {driveError && (
              <p className="signal-media-unresolved" role="alert">
                <AlertTriangle aria-hidden="true" /> {driveError}
              </p>
            )}
          </fieldset>
          <div className="form-row">
            <label>
              Client
              <select
                name="clientId"
                value={draft.clientId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    clientId: event.target.value,
                    projectId:
                      current.projectId &&
                      projects.some(
                        (p) => p.id === current.projectId && p.clientId === event.target.value,
                      )
                        ? current.projectId
                        : '',
                  }))
                }
              >
                <option value="">No client</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Project
              <select
                name="projectId"
                value={draft.projectId}
                onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
                disabled={!draft.clientId}
              >
                <option value="">No project</option>
                {availableProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
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
            {post && (
              <>
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
              </>
            )}
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
          {post && hasUnsavedChanges && (
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
              label="Planning status"
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
          <Select
            label="Delivery provenance"
            name="deliveryProvenance"
            value={draft.deliveryProvenance}
            options={SIGNAL_DELIVERY_PROVENANCES}
            labels={SIGNAL_DELIVERY_PROVENANCE_LABEL}
            onChange={(event) =>
              setDraft({
                ...draft,
                deliveryProvenance: event.target.value as SignalDeliveryProvenance,
              })
            }
          />
          <p className="signal-provenance-note">
            Provenance is not planning status and not provider delivery. Choose Outside of Signal
            only when the content went out in a platform app or another tool without a submission
            from this planner.
          </p>
          {post?.lifecycle === 'RETIRED' && (
            <p className="signal-lifecycle-note" role="status">
              This plan is retired. It stays out of ordinary planner and calendar views. Planning
              status above is unchanged.
              {post.retiredAt ? ` Retired ${new Date(post.retiredAt).toLocaleString()}.` : ''}
            </p>
          )}
          {/* Campaigns are chips from the shared list, not free text: a post belongs to a campaign
              and to the week inside it, and the same run typed twice has to be the same campaign or
              nothing can be grouped by it. Typing a new name creates it when the post is saved. */}
          <TagChipInput
            label="Campaigns"
            noun="campaign"
            chosen={draft.campaigns}
            available={campaigns}
            onChange={(next) => setDraft({ ...draft, campaigns: next })}
          />
          {/* Tailored from the post as it is saved, not as it is being typed: a platform override
              of a caption that has not been written yet would be an override of nothing. */}
          {post && hasTailorablePlatform && (
            <PlatformVariantsEditor
              post={post}
              layers={layers}
              onChange={setLayers}
              onSave={() => void saveVariants()}
              onRecheckRole={recheckRoleMedia}
              resolveDrive={resolveRoleDrive}
              dirty={hasUnsavedVariants}
              busy={busy}
            />
          )}
          {/* Delivery sits beside the planning status above, never inside it. The status select is
              the user's own claim about the post; everything here is what a provider did with one
              submission, per account, and neither one is allowed to write the other. */}
          {post && (publications.length > 0 || undeliverable.length > 0) && (
            <section className="signal-delivery" aria-label="Delivery">
              <h3>Delivery</h3>
              <p className="signal-delivery-note">
                Planning status above is your own claim about this post. Delivery below is what the
                provider did with it, one row per account.
              </p>
              {publications.map((publication) => {
                const schedule = reconcileSchedule(publication, new Date());
                return (
                  <article className="signal-delivery-record" key={publication.id}>
                    <p className="signal-delivery-head">
                      <DeliveryChip group={PUBLICATION_STATE_GROUP[publication.state]}>
                        {PUBLICATION_STATE_LABEL[publication.state]}
                      </DeliveryChip>{' '}
                      <span className="signal-delivery-instant">
                        {publication.scheduledInstant
                          ? new Date(publication.scheduledInstant).toLocaleString()
                          : 'Immediate send'}
                      </span>
                    </p>
                    <p>{PUBLICATION_STATE_DESCRIPTION[publication.state]}</p>
                    {publication.error && <p className="form-error">{publication.error}</p>}
                    <ul className="signal-delivery-targets">
                      {publication.targets.map((target) => (
                        <DeliveryTarget
                          key={target.accountId}
                          publication={publication}
                          target={target}
                          busy={busy}
                          finish={() => finishDelivery(publication.id, target.accountId)}
                          preview={
                            providerPreview?.publicationId === publication.id &&
                            providerPreviewTarget === target.accountId
                              ? providerPreview
                              : undefined
                          }
                          compare={
                            target.provider === BUFFER_PROVIDER && target.remotePostId
                              ? () => void compareProvider(publication.id, false, target.accountId)
                              : undefined
                          }
                          apply={(action) =>
                            void applyProviderAction(publication.id, action, target.accountId)
                          }
                          close={() => {
                            setProviderPreview(null);
                            setProviderPreviewTarget(null);
                          }}
                        />
                      ))}
                    </ul>
                    <p className="signal-delivery-checked" role="status">
                      {publication.checkedAt
                        ? `Last checked ${new Date(publication.checkedAt).toLocaleString()}.`
                        : 'Not checked with the provider yet.'}{' '}
                      {schedule.exhausted
                        ? 'Automatic checks have stopped after their bounded number of tries; refresh to ask again.'
                        : schedule.dueAt
                          ? `Next automatic check ${new Date(schedule.dueAt).toLocaleString()}.`
                          : 'No further checks are due.'}
                    </p>
                    {/* A Signal edit says so here and stops. Nothing about this banner has asked
                        the provider anything — it is the local snapshot against the local post —
                        and nothing changes out there until someone opens the comparison below and
                        confirms an action from it. */}
                    {!!publication.driftFields?.length && (
                      <p className="signal-provider-drift" role="status">
                        <DeliveryChip group="ATTENTION">Provider update required</DeliveryChip>{' '}
                        {publication.driftFields
                          .map((field) => PROVIDER_DIFF_FIELD_LABEL[field])
                          .join(', ')}{' '}
                        {publication.driftFields.length === 1 ? 'has' : 'have'} changed in Signal
                        since this was sent. The provider still holds the earlier version.
                      </p>
                    )}
                    {/* Manual refresh outlives the automatic schedule on purpose: `UNCONFIRMED`
                        is the state a person resolves, and it is exactly the state the timer has
                        stopped asking about. */}
                    {(publication.providerPostId ||
                      (publication.provider === BUFFER_PROVIDER &&
                        publication.targets.some((target) => target.remotePostId))) &&
                      (isReconcilableState(publication.state) ||
                        publication.state === 'UNCONFIRMED') && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => refreshDelivery(publication.id)}
                          disabled={busy}
                        >
                          <RefreshCw /> Refresh delivery
                        </button>
                      )}
                    {publication.providerPostId &&
                      publicationTracksProvider(publication.state) &&
                      (providerPreview?.publicationId === publication.id ? (
                        <ProviderReconcilePanel
                          preview={providerPreview}
                          busy={busy}
                          apply={(action) => void applyProviderAction(publication.id, action)}
                          close={() => setProviderPreview(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => void compareProvider(publication.id)}
                          disabled={busy}
                        >
                          Compare with provider
                        </button>
                      ))}
                  </article>
                );
              })}
              {/* A channel with no provider is a delivery answer too, and a missing row would read
                  as "nothing to say" rather than "nothing can be sent". Its completion is the
                  planning status, which is why it points there instead of carrying its own
                  control — one fact, one writer. */}
              {undeliverable.map((channel) => (
                <p className="signal-delivery-unsupported" key={channel}>
                  <ChannelChip channel={channel} /> <strong>{SIGNAL_CHANNEL_LABEL[channel]}</strong>{' '}
                  <DeliveryChip group="STOPPED">{DELIVERY_MODE_LABEL.UNSUPPORTED}</DeliveryChip>{' '}
                  {deliveryModeInstruction('UNSUPPORTED', SIGNAL_CHANNEL_LABEL[channel])}
                </p>
              ))}
              {post.status !== 'PUBLISHED' && (
                <button type="button" className="secondary" onClick={markPublished} disabled={busy}>
                  Mark published
                </button>
              )}
              {/* Figures sit below the delivery rows they belong to and above nothing: they are the
                  last thing said about a post, they are read from stored rows on open, and the only
                  control in them that touches the provider is the one a person presses. */}
              <SignalMetrics key={metricsKey} postId={post.id} busy={busy} />
            </section>
          )}
          {post && publishPreview && (
            <section
              className="signal-publish-preview"
              aria-label={
                publishPreview.timing === 'now'
                  ? 'Publish now confirmation'
                  : 'Publish confirmation'
              }
            >
              <h3>
                {publishPreview.timing === 'now' ? 'Confirm publish now' : 'Confirm publishing'}
              </h3>
              {publishPreview.timing === 'now' ? (
                <p>
                  <strong>No scheduled instant.</strong> The provider posts immediately. Signal
                  keeps the planned date and time ({post.date} at {post.time}) for planning only.
                </p>
              ) : (
                publishPreview.scheduledInstant && (
                  <p>
                    <strong>{publishPreview.timezone}</strong>: {post.date} at {post.time}
                    <br />
                    UTC: {publishPreview.scheduledInstant}
                  </p>
                )
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
                onSaveTargets={saveTargets}
                onRecheckRole={recheckRoleMedia}
                resolveDrive={resolveRoleDrive}
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
                  {publishPreview.timing === 'now' ? 'Confirm publish now' : 'Confirm and submit'}
                </button>
              </div>
            </section>
          )}
          <div className="form-error" role="alert">
            {error}
          </div>
          <div className="signal-editor-actions">
            {post && post.lifecycle !== 'RETIRED' && (
              <button
                type="button"
                className="secondary danger-text"
                disabled={busy}
                onClick={remove}
              >
                <Archive /> Retire plan
              </button>
            )}
            <button className="submit" disabled={busy}>
              {busy ? (
                <>
                  <RefreshCw className="spin" /> Saving…
                </>
              ) : creating ? (
                'Add post'
              ) : (
                'Save post'
              )}
            </button>
            {post && post.date && hasPublishableChannel && !publishPreview && (
              <>
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
                {publishNowOffered && (
                  <button
                    type="button"
                    className="secondary danger-text"
                    disabled={busy || hasUnsavedChanges || hasUnsavedVariants}
                    onClick={previewPublishNow}
                  >
                    {hasUnsavedChanges || hasUnsavedVariants
                      ? 'Save changes before publish now'
                      : 'Publish now'}
                  </button>
                )}
              </>
            )}
          </div>
        </form>
      </aside>
    </div>
  );
}

/** A comma-separated URL parameter, read defensively: unknown members are simply not applied. */
const listParam = (value: string | null) =>
  (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * One filter value, on or off — the same toggle chip the campaign-figures panel and the board's
 * tag filter use, so a filter behaves the same way everywhere it appears.
 */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`tag-chip toggle ${active ? 'active' : ''}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function SignalView({ viewDefaults }: { viewDefaults: ViewDefaults }) {
  const [params, setParams] = useSearchParams();
  const now = today();
  const view = resolveViewChoice(params.get('view'), CALENDAR_VIEWS, viewDefaults.signal.view);
  const requestedDate = params.get('date');
  const requestedMonth = params.get('month');
  const anchor = isSignalDate(requestedDate ?? '')
    ? (requestedDate as string)
    : /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth ?? '')
      ? `${requestedMonth}-01`
      : now;
  const bounds = useMemo(
    () => (view === 'month' ? calendarMonthGridRange(anchor) : calendarViewRange(view, anchor)),
    [view, anchor],
  );
  const [posts, setPosts] = useState<SignalPost[]>([]);
  const [queue, setQueue] = useState<SignalPost[]>([]);
  /**
   * Delivery answers for every card currently on the planner, keyed by post id.
   *
   * Loaded in the same pass as the posts — one bounded local batch, never a request per card and
   * never a provider call. Absent ids fall back to "not submitted" so a card always has two named
   * indicators even if the batch and the grid briefly disagree.
   */
  const [cardDeliveries, setCardDeliveries] = useState<Map<string, CardDelivery>>(new Map());
  /**
   * The workspace's campaigns, for the editor's chip input to suggest from.
   *
   * Loaded here rather than in the editor so opening a post costs no extra request, and reloaded
   * with the range so a campaign typed into one post is offered on the next one.
   */
  const [campaigns, setCampaigns] = useState<SignalCampaignSummary[]>([]);
  const [editing, setEditing] = useState<SignalPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  /**
   * Bumped whenever this page changes something the health summary is derived from.
   *
   * The summary is a reading of posts and deliveries, so an edit here can move a line there — and
   * the panel has no way of knowing that on its own. This is the planner saying *ask again*.
   */
  const [healthKey, setHealthKey] = useState(0);
  /**
   * The post named in the address, per `docs/view-state-convention.md`.
   *
   * Durable rather than local state so a queue-health alert, or anything else, can link straight to
   * one post — which is the whole of what makes an alert actionable. It is read defensively: an id
   * that no longer resolves reports itself and leaves the planner usable.
   */
  const requestedPost = params.get('post');
  /**
   * Lifecycle filter for the planner lists — active / retired / all. Separate from planning
   * status filters and from delivery. Default active is omitted from the address.
   */
  const lifecycleFilter: SignalLifecycleFilter = SIGNAL_LIFECYCLE_FILTERS.includes(
    params.get('lifecycle') as SignalLifecycleFilter,
  )
    ? (params.get('lifecycle') as SignalLifecycleFilter)
    : 'active';
  /**
   * Shared Add Post creation state. Day cells, the queue action, and the top navigation all set
   * `new`; the editor itself is the same form used for edits. A named `post` wins over `new` so an
   * alert link still opens the post it named.
   */
  const createRequest = parseSignalCreateParam(params.get('new'));
  const creating = createRequest.creating && !requestedPost ? { date: createRequest.date } : null;
  const opened = useRef<string | null>(null);

  /**
   * C186's durable planner scope: client, project, and campaign, each read defensively from the
   * address per `docs/view-state-convention.md`. Named singular (`client`/`project`/`campaign`) and
   * deliberately distinct from the campaign-figures panel's own `campaigns`/`channels`/`accounts` —
   * the two filter sets share this page's one address bar, and a shared name would make choosing
   * one silently move the other.
   */
  const clientIds = listParam(params.get('client'));
  const projectIds = listParam(params.get('project'));
  const campaignIds = listParam(params.get('campaign'));
  /**
   * Copy search over post text. Transient per `docs/view-state-convention.md`: it represents typing
   * within this visit, so it lives in component state rather than the address. Debounced before it
   * reaches the API so a fast typist does not fire a request per keystroke.
   */
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(handle);
  }, [searchInput]);
  /** Clients and projects the filter chips offer. Loaded once — neither depends on the scope. */
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const signalDefaultClient = useMemo(
    () =>
      viewDefaults.signal.clientId &&
      clients.some((client) => client.id === viewDefaults.signal.clientId)
        ? viewDefaults.signal.clientId
        : (clients.find(
            (client) =>
              client.status === 'ACTIVE' && client.name.toLowerCase() === 'g.holmes designs',
          )?.id ?? ''),
    [clients, viewDefaults.signal.clientId],
  );
  const visibleClients = clients.filter(
    (client) => viewDefaults.signal.clientVisibility === 'all' || client.status === 'ACTIVE',
  );
  const visibleProjects = projects.filter(
    (project) => viewDefaults.signal.projectVisibility === 'all' || project.status !== 'ARCHIVED',
  );
  useEffect(() => {
    void api<Client[]>('/clients')
      .then(setClients)
      .catch(() => undefined);
    void api<Project[]>('/projects')
      .then(setProjects)
      .catch(() => undefined);
  }, []);
  const filtered = Boolean(clientIds.length || projectIds.length || campaignIds.length || search);
  /** Sets or clears one filter parameter, leaving every other one in the address alone. */
  const setFilterParam = (key: string, value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const toggleFilter = (key: string, chosen: string[], value: string) =>
    setFilterParam(
      key,
      (chosen.includes(value) ? chosen.filter((item) => item !== value) : [...chosen, value]).join(
        ',',
      ),
    );
  const clearFilters = () => {
    setSearchInput('');
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const key of ['client', 'project', 'campaign']) next.delete(key);
        return next;
      },
      { replace: true },
    );
  };
  /**
   * The scope query, as one string every list read appends — a primitive so `load`'s dependency
   * list can compare it by value rather than by the identity of a freshly split array.
   */
  const filterQuery = useMemo(() => {
    const scope = new URLSearchParams();
    if (clientIds.length) scope.set('client', clientIds.join(','));
    if (projectIds.length) scope.set('project', projectIds.join(','));
    if (campaignIds.length) scope.set('campaign', campaignIds.join(','));
    if (search) scope.set('q', search);
    return scope.toString();
  }, [clientIds, projectIds, campaignIds, search]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { from, to } = bounds;
    const lifecycleParam = lifecycleFilter === 'active' ? '' : `lifecycle=${lifecycleFilter}`;
    const scope = [lifecycleParam, filterQuery].filter(Boolean).join('&');
    const scopeQuery = scope ? `&${scope}` : '';
    const queueQuery = scope ? `?${scope}` : '';
    try {
      const [range, nextQueue, nextCampaigns, nextDeliveries] = await Promise.all([
        api<SignalRange>(`/signal/posts?from=${from}&to=${to}${scopeQuery}`),
        api<SignalPost[]>(`/signal/queue${queueQuery}`),
        api<SignalCampaignSummary[]>('/signal/campaigns'),
        api<CardDeliverySnapshot>(`/signal/card-delivery?from=${from}&to=${to}${scopeQuery}`),
      ]);
      setPosts(range.posts);
      setTruncated(range.truncated);
      setQueue(nextQueue);
      setCampaigns(nextCampaigns);
      setCardDeliveries(new Map(nextDeliveries.deliveries.map((entry) => [entry.postId, entry])));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  }, [bounds, lifecycleFilter, filterQuery]);

  const deliveryFor = useCallback(
    (postId: string): CardDelivery =>
      cardDeliveries.get(postId) ?? {
        postId,
        state: 'NONE',
        label: CARD_DELIVERY_LABEL.NONE,
      },
    [cardDeliveries],
  );
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Opens the post the address names, from the range if it is there and from the API if it is not.
   *
   * An alert can point at a post in another month, so the planner cannot assume the id is one of the
   * cells it is drawing. `opened` records the id this effect has already acted on, so a failed
   * lookup reports once instead of retrying every time the range reloads.
   */
  useEffect(() => {
    if (!requestedPost || opened.current === requestedPost) return;
    opened.current = requestedPost;
    const local = [...posts, ...queue].find((post) => post.id === requestedPost);
    if (local) {
      setEditing(local);
      return;
    }
    void api<SignalPost>(`/signal/posts/${requestedPost}`)
      .then(setEditing)
      .catch((reason: Error) => setError(reason.message));
  }, [requestedPost, posts, queue]);

  /** Closes the composer and drops `post` / `new` from the address, leaving every other parameter. */
  const closeComposer = useCallback(() => {
    setEditing(null);
    opened.current = null;
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('post');
        next.delete('new');
        return next;
      },
      { replace: true },
    );
    // The editor can submit, finish, or cancel a delivery without going through `saved`, so the
    // cards reread their batch when it closes rather than keeping a stale "not submitted".
    void api<CardDeliverySnapshot>(`/signal/card-delivery?from=${bounds.from}&to=${bounds.to}`)
      .then((snapshot) =>
        setCardDeliveries(new Map(snapshot.deliveries.map((entry) => [entry.postId, entry]))),
      )
      .catch(() => undefined);
  }, [bounds.from, bounds.to, setParams]);

  /**
   * Opens the shared Add Post form with an optional local date.
   *
   * Writes `new` into the address and clears any open `post`, so reload and back/forward land on
   * the same creation state. Month/view/campaign filters stay where they were.
   */
  const openCreate = useCallback(
    (date: string | null) => {
      setEditing(null);
      opened.current = null;
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('post');
          next.set('new', date ?? '1');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  /** Opens an existing post and clears creation state so the two modes never compete. */
  const openPost = useCallback(
    (post: SignalPost) => {
      setEditing(post);
      if (params.get('new') === null) return;
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('new');
          return next;
        },
        { replace: true },
      );
    },
    [params, setParams],
  );

  const byDate = useMemo(() => {
    const grouped = new Map<string, SignalPost[]>();
    for (const post of posts) {
      if (!post.date) continue;
      grouped.set(post.date, [...(grouped.get(post.date) ?? []), post]);
    }
    return grouped;
  }, [posts]);

  const refreshed = async () => {
    setHealthKey((key) => key + 1);
    await load();
    closeComposer();
  };

  const days = dateLabels(bounds.from, bounds.to);
  const weekdays =
    view === 'month'
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      : days.map((date) => dayHeading(date, { weekday: 'short' }));

  const configuredView = viewDefaults.signal.view;
  const setLifecycleFilter = (next: SignalLifecycleFilter) => {
    setParams((current) => {
      const params = new URLSearchParams(current);
      if (next === 'active') params.delete('lifecycle');
      else params.set('lifecycle', next);
      return params;
    });
  };
  // Durable filter parameters carried across every navigation below: the client/project/campaign
  // scope is a dimension of the planner, not of the period, so switching view or month must not
  // silently clear it.
  const carriedFilterParams = (source: URLSearchParams): [string, string][] =>
    (['client', 'project', 'campaign'] as const).flatMap((key) => {
      const value = source.get(key);
      return value ? [[key, value] as [string, string]] : [];
    });
  const goto = (nextView: CalendarViewMode, nextAnchor: string) => {
    // Same rule as Calendar: the configured default in the current period keeps a short address.
    // Lifecycle and the client/project/campaign scope are separate dimensions and survive
    // navigation when they are not each dimension's default.
    if (nextView === configuredView && isCurrentTimePeriod(nextView, nextAnchor, now)) {
      setParams((current) => {
        const params = new URLSearchParams(carriedFilterParams(current));
        const lifecycle = current.get('lifecycle');
        if (lifecycle && lifecycle !== 'active') params.set('lifecycle', lifecycle);
        return params;
      });
      return;
    }
    setParams((current) => {
      const next = new URLSearchParams(carriedFilterParams(current));
      next.set('month', nextAnchor.slice(0, 7));
      if (nextView !== configuredView) next.set('view', nextView);
      if (nextView !== 'month') next.set('date', nextAnchor);
      if (lifecycleFilter !== 'active') next.set('lifecycle', lifecycleFilter);
      return next;
    });
  };

  const title =
    view === 'today'
      ? dayHeading(anchor, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      : view === 'week'
        ? `${dayHeading(bounds.from, { month: 'short', day: 'numeric', year: 'numeric' })} – ${dayHeading(bounds.to, { month: 'short', day: 'numeric', year: 'numeric' })}`
        : monthHeading(anchor.slice(0, 7));
  const spanLabel = view === 'today' ? 'day' : view;
  const truncationSpanLabel = view === 'month' ? 'visible month grid' : spanLabel;

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
          This {truncationSpanLabel} {view === 'month' ? 'has' : 'matches'} more than 500 posts.
          Only the first 500 are shown.
        </div>
      )}
      {/* Above the planner, because it narrows what both the grid and the queue below show: a
          filter chosen here has already been applied to every count and card by the time either
          renders. Client, project, and campaign are durable URL state; copy search is transient. */}
      <section className="panel signal-filters" aria-label="Filter the planner">
        <div className="section-title">
          <div>
            <span className="eyebrow">Filter</span>
            <h2>Client, project, campaign, and copy</h2>
          </div>
          {filtered && (
            <button type="button" className="secondary" onClick={clearFilters}>
              <RotateCcw aria-hidden="true" /> Clear filters
            </button>
          )}
        </div>
        <div className="filterbar">
          <SearchBox value={searchInput} set={setSearchInput} placeholder="Search post copy…" />
        </div>
        {visibleClients.length > 0 && (
          <div className="tag-filter">
            <span className="tag-filter-label" id="signal-client-filter-label">
              Client
            </span>
            <div role="group" aria-labelledby="signal-client-filter-label">
              {visibleClients.map((client) => (
                <FilterChip
                  key={client.id}
                  label={client.name}
                  active={clientIds.includes(client.id)}
                  onClick={() => toggleFilter('client', clientIds, client.id)}
                />
              ))}
              {/* Unbound posts are a group a person can ask for by name, not a residue reachable
                  only by clearing every other filter — the same treatment as No campaign below. */}
              <FilterChip
                label={SIGNAL_CLIENT_UNBOUND_LABEL}
                active={clientIds.includes(SIGNAL_CLIENT_UNBOUND)}
                onClick={() => toggleFilter('client', clientIds, SIGNAL_CLIENT_UNBOUND)}
              />
            </div>
          </div>
        )}
        {visibleProjects.length > 0 && (
          <div className="tag-filter">
            <span className="tag-filter-label" id="signal-project-filter-label">
              Project
            </span>
            <div role="group" aria-labelledby="signal-project-filter-label">
              {visibleProjects.map((project) => (
                <FilterChip
                  key={project.id}
                  label={project.name}
                  active={projectIds.includes(project.id)}
                  onClick={() => toggleFilter('project', projectIds, project.id)}
                />
              ))}
            </div>
          </div>
        )}
        {campaigns.length > 0 && (
          <div className="tag-filter">
            <span className="tag-filter-label" id="signal-campaign-filter-label">
              Campaign
            </span>
            <div role="group" aria-labelledby="signal-campaign-filter-label">
              {campaigns.map((campaign) => (
                <FilterChip
                  key={campaign.id}
                  label={campaign.name}
                  active={campaignIds.includes(campaign.id)}
                  onClick={() => toggleFilter('campaign', campaignIds, campaign.id)}
                />
              ))}
              <FilterChip
                label={SIGNAL_CAMPAIGN_NONE_LABEL}
                active={campaignIds.includes(SIGNAL_CAMPAIGN_NONE)}
                onClick={() => toggleFilter('campaign', campaignIds, SIGNAL_CAMPAIGN_NONE)}
              />
            </div>
          </div>
        )}
        {(clientIds.length > 1 || projectIds.length > 1 || campaignIds.length > 1) && (
          <p className="filterbar-hint">
            Several selections within one filter are read as <strong>or</strong>; client, project,
            campaign, and copy search narrow together.
          </p>
        )}
      </section>
      {/* Above the planner, because it is the thing to read first: a failed delivery and an empty
          channel are not visible anywhere in the grid below. */}
      <SignalHealthPanel reloadKey={healthKey} />
      <div className="signal-layout">
        <aside className="signal-queue" aria-labelledby="signal-queue-title">
          <div className="signal-section-head">
            <div>
              <span className="eyebrow">Ideas</span>
              <h2 id="signal-queue-title">Unscheduled queue</h2>
              <p className="signal-filter-caption">
                {SIGNAL_LIFECYCLE_FILTER_LABEL[lifecycleFilter]}
              </p>
            </div>
            <span
              className="signal-count"
              title="Count of plans matching the lifecycle and filter scope"
            >
              {queue.length}
            </span>
          </div>
          <button
            type="button"
            className="signal-add-post"
            onClick={() => openCreate(null)}
            disabled={creating !== null && creating.date === null}
          >
            <Plus /> Add post
          </button>
          {!loading && queue.length === 0 ? (
            <Empty compact title="Queue clear" body="New ideas without a date will wait here." />
          ) : (
            <ul className="signal-queue-list">
              {queue.map((post) => (
                <li key={post.id}>
                  <Post post={post} delivery={deliveryFor(post.id)} open={openPost} />
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
          <div className="segmented-control signal-lifecycle-filter" aria-label="Plan lifecycle">
            {SIGNAL_LIFECYCLE_FILTERS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={lifecycleFilter === option}
                onClick={() => setLifecycleFilter(option)}
              >
                {option === 'active' ? 'Active' : option === 'retired' ? 'Retired' : 'All plans'}
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
            {days.map((date) => {
              const scheduled = byDate.get(date) ?? [];
              const adjacent = view === 'month' && date.slice(0, 7) !== anchor.slice(0, 7);
              return (
                <section
                  className={`signal-day ${adjacent ? 'is-adjacent-month' : ''} ${date === now ? 'is-today' : ''}`}
                  key={date}
                  aria-label={date}
                >
                  <header>
                    <span>{Number(date.slice(-2))}</span>
                    <div className="signal-day-actions">
                      {date === now && <strong>Today</strong>}
                      <button
                        type="button"
                        className="icon-btn signal-day-add"
                        aria-label={`Add post on ${date}`}
                        onClick={() => openCreate(date)}
                      >
                        <Plus aria-hidden="true" />
                      </button>
                    </div>
                  </header>
                  {scheduled.length === 0 ? (
                    <span className="signal-day-empty">No posts</span>
                  ) : (
                    <ul>
                      {scheduled.map((post) => (
                        <li key={post.id}>
                          <Post
                            post={post}
                            delivery={deliveryFor(post.id)}
                            open={openPost}
                            preview
                          />
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
      {/* Below the planner and above the figures, because it is about the schedule rather than about
          what a post did: a slot that looks empty in the grid above may already have something going
          out into it. A local read of stored rows — nothing here contacts the provider until
          somebody presses its own refresh. */}
      <SignalProviderInventoryPanel reloadKey={healthKey} />
      {/* Beside the inventory and before the campaign segmentation, which is the order of the
          questions: what is out there, what does the provider report over a window, and what did our
          own campaigns get. All three are local reads on mount. */}
      <SignalAnalyticsWindowPanel reloadKey={healthKey} />
      {/* Below the planner, because it is what happened rather than what is planned — and because it
          reads the figures a post's own panel already stored, so it belongs after the posts and not
          in front of them. `healthKey` is bumped by every save here, which is also every edit that
          can move a post between campaigns. */}
      <SignalCampaignAnalyticsPanel reloadKey={healthKey} />
      {(creating || editing) && (
        <Editor
          key={creating ? `new-${creating.date ?? 'queue'}` : (editing as SignalPost).id}
          post={creating ? null : editing}
          createDate={creating ? creating.date : null}
          campaigns={campaigns}
          clients={visibleClients}
          projects={visibleProjects}
          defaultClientId={signalDefaultClient}
          close={closeComposer}
          saved={refreshed}
          opened={async (post) => {
            await load();
            opened.current = post.id;
            setEditing(post);
            setParams(
              (current) => {
                const next = new URLSearchParams(current);
                next.delete('new');
                return next;
              },
              { replace: true },
            );
          }}
          removed={refreshed}
        />
      )}
    </>
  );
}
