import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, FileText, Play, RefreshCw } from 'lucide-react';
import { SIGNAL_CHANNEL_LABEL, signalMediaKind, type SignalPost } from '../../../shared/signal';
import {
  publishCapabilityFor,
  PUBLISH_POST_KIND_LABEL,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
} from '../../../shared/publish-capabilities';
import {
  publishVariantFieldSupported,
  publishVariantPlacements,
  PUBLISH_VARIANT_FIELD_LABEL,
  PUBLISH_VARIANT_SCOPE_LABEL,
  type PublishContentVariant,
  type PublishVariantField,
  type PublishVariantRecord,
} from '../../../shared/publish-variants';
import {
  DELIVERY_MODE_LABEL,
  PUBLISH_CHANNEL_STATUS_LABEL,
  type PublishChannelReport,
  type PublishPreview,
} from '../../../shared/publish';
import { previewPlatforms, variantFieldCount, variantKey } from './signal-variants';

/**
 * The composer's side of platform and account content variants, and the on-demand preview.
 *
 * Two rules shape everything here and are worth stating before the code:
 *
 * 1. **A control exists only where the provider would carry it.** Every field is rendered from
 *    `publishVariantFieldSupported`, the same function the HTTP boundary refuses with and the
 *    publisher's preflight checks stored content against. A form offering a field the API rejects
 *    is a form that teaches the user something untrue about the provider.
 * 2. **Nothing remote loads until the preview is asked for.** No thumbnail, no video, no provider
 *    call. The composer above renders text alone, and pressing **Show preview** is the only thing
 *    in this file that causes the browser to fetch anything at all. Video needs a second explicit
 *    press, because a preview that starts playing is a preview that decided for you.
 *
 * The server fetches none of these URLs, before or after. It never has, for media or anything else
 * (`server/db.ts`, `signal_post_media`), and a preview is the last place to start.
 */

/**
 * One layer's fields, for whichever layer is being edited.
 *
 * The platform layer and an account layer take the same fields, so they take the same component:
 * two forms would be two places for the supported-field rule to drift, and the second one would be
 * the one nobody remembered to update.
 */
function VariantFields({
  capability,
  value,
  postMedia,
  onChange,
  disabled,
}: {
  capability: PublishPlatformCapability;
  value: PublishContentVariant;
  /** The post's own media, in its order. A selection can only ever be a subset of this. */
  postMedia: string[];
  onChange: (next: PublishContentVariant) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const supports = (field: PublishVariantField) => publishVariantFieldSupported(field, capability);
  const set = (patch: PublishContentVariant) => onChange({ ...value, ...patch });
  const placements = publishVariantPlacements(capability);
  const selection = value.mediaUrls;

  return (
    <div className="signal-variant-fields">
      {/* The running count is described by the field rather than part of its name: a name that
          changes on every keystroke is a name a screen reader re-announces on every keystroke. */}
      {supports('caption') && (
        <div className="signal-variant-field">
          <label>
            {PUBLISH_VARIANT_FIELD_LABEL.caption} for {capability.label}
            <textarea
              rows={4}
              value={value.caption ?? ''}
              disabled={disabled}
              aria-describedby={`${id}-caption-count`}
              placeholder="Leave empty to use the post's own caption"
              onChange={(event) => set({ caption: event.target.value })}
            />
          </label>
          <span className="signal-variant-count" id={`${id}-caption-count`}>
            {(value.caption ?? '').length} of {capability.captionMax} characters
            {capability.captionOverLimitRefuses ? ' · over the limit refuses' : ''}
          </span>
        </div>
      )}
      {supports('title') && (
        <label>
          {PUBLISH_VARIANT_FIELD_LABEL.title}
          {capability.title.required ? ' (used instead of the caption)' : ''}
          <input
            type="text"
            value={value.title ?? ''}
            disabled={disabled}
            {...(capability.title.maxLength !== null
              ? { maxLength: capability.title.maxLength }
              : {})}
            onChange={(event) => set({ title: event.target.value })}
          />
        </label>
      )}
      {supports('firstComment') && (
        <label>
          {PUBLISH_VARIANT_FIELD_LABEL.firstComment}
          <textarea
            rows={2}
            value={value.firstComment ?? ''}
            disabled={disabled}
            placeholder="Posted as the first reply. A good home for a link X would strip."
            onChange={(event) => set({ firstComment: event.target.value })}
          />
        </label>
      )}
      {supports('postKind') && (
        <label>
          {PUBLISH_VARIANT_FIELD_LABEL.postKind}
          <select
            value={value.postKind ?? ''}
            disabled={disabled}
            onChange={(event) =>
              set({
                ...(event.target.value
                  ? { postKind: event.target.value as PublishPostKind }
                  : { postKind: undefined }),
              })
            }
          >
            <option value="">Use the post's format</option>
            {placements.map((kind) => (
              <option key={kind} value={kind}>
                {PUBLISH_POST_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </label>
      )}
      {supports('coverImageUrl') && (
        <label>
          {PUBLISH_VARIANT_FIELD_LABEL.coverImageUrl}
          <input
            type="url"
            value={value.coverImageUrl ?? ''}
            disabled={disabled}
            onChange={(event) => set({ coverImageUrl: event.target.value })}
          />
        </label>
      )}
      {supports('thumbnailUrl') && (
        <label>
          {PUBLISH_VARIANT_FIELD_LABEL.thumbnailUrl}
          <input
            type="url"
            value={value.thumbnailUrl ?? ''}
            disabled={disabled}
            onChange={(event) => set({ thumbnailUrl: event.target.value })}
          />
        </label>
      )}
      {supports('discloseSyntheticMedia') && (
        <div className="signal-variant-field">
          <label className="signal-variant-check">
            <input
              type="checkbox"
              checked={value.discloseSyntheticMedia ?? false}
              disabled={disabled}
              aria-describedby={`${id}-disclosure-note`}
              onChange={(event) => set({ discloseSyntheticMedia: event.target.checked })}
            />
            Disclose AI-generated or altered media
          </label>
          <span className="signal-variant-count" id={`${id}-disclosure-note`}>
            {capability.syntheticMediaDisclosure === 'IN_CAPTION'
              ? `${capability.label} has no disclosure field, so this is written into the caption.`
              : `${capability.label} carries a disclosure flag.`}
          </span>
        </div>
      )}
      {supports('mediaUrls') && postMedia.length > 0 && (
        <fieldset className="signal-variant-media">
          <legend>{PUBLISH_VARIANT_FIELD_LABEL.mediaUrls}</legend>
          {/* Two radios rather than an empty selection meaning both things: no selection inherits
              the post's media and an empty one is a platform that deliberately receives none. */}
          <label className="signal-variant-check">
            <input
              type="radio"
              name={`${id}-media-mode`}
              checked={selection === undefined}
              disabled={disabled}
              onChange={() => set({ mediaUrls: undefined })}
            />
            Use the post's media ({postMedia.length})
          </label>
          <label className="signal-variant-check">
            <input
              type="radio"
              name={`${id}-media-mode`}
              checked={selection !== undefined}
              disabled={disabled}
              onChange={() => set({ mediaUrls: [...postMedia] })}
            />
            Choose media for {capability.label}
          </label>
          {selection !== undefined && (
            <ol>
              {postMedia.map((url, index) => (
                <li key={`${index}-${url}`}>
                  <label className="signal-variant-check">
                    <input
                      type="checkbox"
                      checked={selection.includes(url)}
                      disabled={disabled}
                      onChange={(event) =>
                        set({
                          mediaUrls: event.target.checked
                            ? postMedia.filter(
                                (candidate) => candidate === url || selection.includes(candidate),
                              )
                            : selection.filter((candidate) => candidate !== url),
                        })
                      }
                    />
                    Media {index + 1} · {signalMediaKind(url)}
                    <span className="signal-variant-url">{url}</span>
                  </label>
                </li>
              ))}
            </ol>
          )}
        </fieldset>
      )}
    </div>
  );
}

/**
 * The platform layer for every platform the post's channels reach.
 *
 * Saved on its own rather than with the post: these are separate records with their own route, and
 * folding them into the post's `PATCH` would make one write able to half-apply across two tables.
 * The preview is held back until they are saved, for the same reason it is held back until the post
 * is — a preview of unsaved content is a preview of something that is not going out.
 */
export function PlatformVariantsEditor({
  post,
  layers,
  onChange,
  onSave,
  dirty,
  busy,
}: {
  post: SignalPost;
  layers: Map<string, PublishVariantRecord>;
  onChange: (next: Map<string, PublishVariantRecord>) => void;
  onSave: () => void;
  dirty: boolean;
  busy: boolean;
}) {
  const platforms = previewPlatforms(post);
  if (platforms.length === 0) return null;

  const update = (platform: PublishPlatform, next: PublishContentVariant) => {
    const copy = new Map(layers);
    copy.set(variantKey(platform, null), { platform, accountId: null, ...next });
    onChange(copy);
  };
  const clear = (platform: PublishPlatform) => {
    const copy = new Map(layers);
    copy.delete(variantKey(platform, null));
    onChange(copy);
  };

  return (
    <fieldset className="signal-variants-fieldset">
      <legend>Per-platform content</legend>
      <p>
        Each platform starts from the post above and keeps only what you change here. Nothing is
        fetched or previewed until you ask for it.
      </p>
      {platforms.map(({ channel, platform }) => {
        const capability = publishCapabilityFor(platform);
        if (!capability) return null;
        const stored = layers.get(variantKey(platform, null));
        const overridden = variantFieldCount(stored);
        return (
          // Keyed by the provider platform rather than the channel, the way a chip carries
          // `data-channel`: the override belongs to the platform, and a test or a stylesheet
          // reaching for one should say which platform rather than which label it was given.
          <details key={platform} className="signal-variant-platform" data-platform={platform}>
            <summary>
              {SIGNAL_CHANNEL_LABEL[channel]}
              <span className="signal-variant-summary-state">
                {overridden > 0
                  ? `${overridden} field${overridden === 1 ? '' : 's'} tailored`
                  : 'Same as the post'}
              </span>
            </summary>
            {/* A group with the platform's name, so the fields inside are announced as belonging
                to one platform. The legend is hidden because the summary above already reads it
                out to a sighted user, and hearing it twice is worse than not seeing it once. */}
            <fieldset>
              <legend className="sr-only">{capability.label}</legend>
              <VariantFields
                capability={capability}
                value={stored ?? {}}
                postMedia={post.mediaUrls}
                disabled={busy}
                onChange={(next) => update(platform, next)}
              />
              {overridden > 0 && (
                <button
                  type="button"
                  className="text-btn"
                  disabled={busy}
                  onClick={() => clear(platform)}
                >
                  Reset {capability.label} to the post
                </button>
              )}
            </fieldset>
          </details>
        );
      })}
      <div className="signal-variant-actions">
        <button type="button" className="secondary" onClick={onSave} disabled={busy || !dirty}>
          {busy ? <RefreshCw className="spin" /> : null}
          {dirty ? 'Save per-platform content' : 'Per-platform content saved'}
        </button>
      </div>
    </fieldset>
  );
}

/**
 * One media reference, rendered as small as it can be while still being worth looking at.
 *
 * An image loads with the preview, because that is what the preview was asked for. A video does
 * not: it takes a second, explicit press, and even then it arrives with controls rather than
 * playing — nothing here autoplays, and no `autoplay` attribute exists in this file to be flipped
 * later. A PDF and an unclassifiable URL are shown as what they are and never embedded.
 *
 * `referrerPolicy="no-referrer"` is on the elements the attribute is defined for, and the app's
 * `Referrer-Policy: no-referrer` response header covers the rest, so nothing this renders tells a
 * media host which page asked for it.
 */
function PreviewMedia({ url, index }: { url: string; index: number }) {
  const kind = signalMediaKind(url);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const label = `Media ${index + 1} · ${kind}`;

  const fallback = (
    <p className="signal-preview-media-fallback">
      <AlertTriangle aria-hidden="true" /> This media could not be shown here. It is still sent to
      the provider by its address.
    </p>
  );

  return (
    <li className="signal-preview-media">
      <p className="signal-preview-media-head">
        <strong>{label}</strong>
        <a href={url} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">
          Open <ExternalLink aria-hidden="true" />
        </a>
      </p>
      <span className="signal-preview-media-url">{url}</span>
      {kind === 'image' &&
        (broken ? (
          fallback
        ) : (
          <img
            className="signal-preview-thumb"
            src={url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setBroken(true)}
          />
        ))}
      {kind === 'video' &&
        (broken ? (
          fallback
        ) : loaded ? (
          // No `referrerPolicy` here and none missing: HTML defines the attribute for images,
          // links, scripts and frames, and not for media elements. The app's
          // `Referrer-Policy: no-referrer` response header is what covers this request, which is
          // why `server/app.test.ts` asserts the header rather than trusting the attribute.
          <video
            className="signal-preview-thumb"
            src={url}
            controls
            preload="metadata"
            playsInline
            onError={() => setBroken(true)}
          />
        ) : (
          <button type="button" className="secondary" onClick={() => setLoaded(true)}>
            <Play aria-hidden="true" /> Load this video
          </button>
        ))}
      {(kind === 'pdf' || kind === 'unknown') && (
        <p className="signal-preview-media-note">
          <FileText aria-hidden="true" />{' '}
          {kind === 'pdf'
            ? 'A PDF is not shown here; open it to check it.'
            : 'This address carries no file extension, so its kind could not be read from the URL.'}
        </p>
      )}
    </li>
  );
}

/** A channel's tab label: the account it resolved to, or the channel alone when none did. */
const tabLabel = (report: PublishChannelReport) =>
  `${SIGNAL_CHANNEL_LABEL[report.channel] ?? report.channel}${report.handle ? ` → ${report.handle}` : ''}`;

/**
 * What one target receives, in full.
 *
 * Self-contained on purpose: the instant, the mode, the text, the media order and the reasons all
 * sit in the panel for the account they belong to, so reading a tab answers "what does this account
 * get" without looking anywhere else. That is the whole reason the preview is tabbed rather than a
 * single list — a merged list makes the reader work out which target each line was about.
 */
function PreviewPanel({
  report,
  preview,
  post,
  accountLayer,
  onAccountChange,
  onAccountSave,
  accountDirty,
  busy,
}: {
  report: PublishChannelReport;
  preview: PublishPreview;
  post: SignalPost;
  accountLayer: PublishContentVariant | undefined;
  onAccountChange: (next: PublishContentVariant) => void;
  onAccountSave: () => void;
  accountDirty: boolean;
  busy: boolean;
}) {
  const content = report.content;
  const capability = report.platform ? publishCapabilityFor(report.platform) : undefined;
  const overridden = content
    ? (Object.keys(content.sources) as PublishVariantField[]).filter(
        (field) => content.sources[field] !== 'BASE',
      )
    : [];

  return (
    <>
      <p className="signal-preview-verdict">
        <strong>{tabLabel(report)}</strong> · {PUBLISH_CHANNEL_STATUS_LABEL[report.status]}
      </p>
      {content && (
        <p className="signal-preview-mode">
          {PUBLISH_POST_KIND_LABEL[content.postKind]} · {DELIVERY_MODE_LABEL[content.deliveryMode]}
        </p>
      )}
      {preview.scheduledInstant && (
        <p className="signal-preview-when">
          {post.date} at {post.time} in {preview.timezone}
          <br />
          Provider instant: {preview.scheduledInstant}
        </p>
      )}
      {content ? (
        <>
          <h4>Text this account receives</h4>
          <p className="signal-preview-caption">{content.caption}</p>
          {overridden.length > 0 && (
            <ul className="signal-preview-sources">
              {overridden.map((field) => (
                <li key={field}>
                  {PUBLISH_VARIANT_FIELD_LABEL[field]} from{' '}
                  {PUBLISH_VARIANT_SCOPE_LABEL[content.sources[field]]}
                </li>
              ))}
            </ul>
          )}
          {content.title !== undefined && (
            <p className="signal-preview-field">
              <strong>{PUBLISH_VARIANT_FIELD_LABEL.title}:</strong> {content.title}
            </p>
          )}
          {content.firstComment !== undefined && (
            <p className="signal-preview-field">
              <strong>{PUBLISH_VARIANT_FIELD_LABEL.firstComment}:</strong> {content.firstComment}
            </p>
          )}
          {content.discloseSyntheticMedia && (
            <p className="signal-preview-field">
              <strong>{PUBLISH_VARIANT_FIELD_LABEL.discloseSyntheticMedia}:</strong> included
            </p>
          )}
          <h4>Media, in this order</h4>
          {content.mediaUrls.length === 0 ? (
            <p className="signal-preview-field">No media on this target.</p>
          ) : (
            <ol className="signal-preview-media-list">
              {content.mediaUrls.map((url, index) => (
                <PreviewMedia key={`${index}-${url}`} url={url} index={index} />
              ))}
            </ol>
          )}
        </>
      ) : (
        <p className="signal-preview-field">
          Nothing is tailored for this channel because no provider platform reaches it.
        </p>
      )}
      {report.refusals.map((refusal) => (
        <p className="form-error" key={refusal}>
          {refusal}
        </p>
      ))}
      {report.warnings.map((warning) => (
        <p className="form-warning" key={warning}>
          {warning}
        </p>
      ))}
      {capability && report.accountId !== undefined && (
        <details className="signal-variant-account">
          <summary>Override for {report.handle} only</summary>
          <p>
            This layer sits over the platform's. Saving it re-checks the preview, because the plan
            that goes out has to be the plan you last looked at.
          </p>
          <VariantFields
            capability={capability}
            value={accountLayer ?? {}}
            postMedia={post.mediaUrls}
            disabled={busy}
            onChange={onAccountChange}
          />
          <button
            type="button"
            className="secondary"
            onClick={onAccountSave}
            disabled={busy || !accountDirty}
          >
            {busy ? <RefreshCw className="spin" /> : null} Save and re-check
          </button>
        </details>
      )}
    </>
  );
}

/**
 * The preview, one tab per target.
 *
 * Arrow keys move between tabs and Home and End jump to the ends, because a tablist that only
 * answers to a mouse is a tablist half the users cannot reach. Only the selected panel is in the
 * document, so a screen reader reads one target's content rather than seven interleaved.
 */
export function PublishPreviewTabs({
  preview,
  post,
  layers,
  onChange,
  onSaveAccount,
  savedLayers,
  busy,
}: {
  preview: PublishPreview;
  post: SignalPost;
  layers: Map<string, PublishVariantRecord>;
  onChange: (next: Map<string, PublishVariantRecord>) => void;
  onSaveAccount: () => void;
  /** What the server currently holds, so an account layer knows whether it is unsaved. */
  savedLayers: Map<string, PublishVariantRecord>;
  busy: boolean;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const reports = preview.channels;

  // A channel removed from the post between two previews must not leave the selection past the end.
  useEffect(() => {
    setActive((current) => (current < reports.length ? current : 0));
  }, [reports.length]);

  if (reports.length === 0) return null;
  const selected = reports[Math.min(active, reports.length - 1)] as PublishChannelReport;

  const move = (to: number) => {
    const next = (to + reports.length) % reports.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  const accountKey =
    selected.platform && selected.accountId !== undefined
      ? variantKey(selected.platform, selected.accountId)
      : undefined;
  const accountLayer = accountKey ? layers.get(accountKey) : undefined;
  const savedAccount = accountKey ? savedLayers.get(accountKey) : undefined;

  return (
    <div className="signal-preview-tabs">
      <div role="tablist" aria-label="Target accounts" className="signal-preview-tablist">
        {reports.map((report, index) => (
          <button
            key={report.channel}
            type="button"
            role="tab"
            id={`${id}-tab-${index}`}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            aria-selected={index === active}
            aria-controls={`${id}-panel-${index}`}
            tabIndex={index === active ? 0 : -1}
            className={`channel-${report.status.toLowerCase()}`}
            onClick={() => setActive(index)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') move(active + 1);
              else if (event.key === 'ArrowLeft') move(active - 1);
              else if (event.key === 'Home') move(0);
              else if (event.key === 'End') move(reports.length - 1);
              else return;
              event.preventDefault();
            }}
          >
            {tabLabel(report)}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-${Math.min(active, reports.length - 1)}`}
        aria-labelledby={`${id}-tab-${Math.min(active, reports.length - 1)}`}
        tabIndex={0}
        className="signal-preview-panel"
      >
        <PreviewPanel
          report={selected}
          preview={preview}
          post={post}
          accountLayer={accountLayer}
          accountDirty={JSON.stringify(accountLayer) !== JSON.stringify(savedAccount)}
          busy={busy}
          onAccountChange={(next) => {
            if (!selected.platform || selected.accountId === undefined) return;
            const copy = new Map(layers);
            copy.set(variantKey(selected.platform, selected.accountId), {
              platform: selected.platform,
              accountId: selected.accountId,
              ...next,
            });
            onChange(copy);
          }}
          onAccountSave={onSaveAccount}
        />
      </div>
    </div>
  );
}
