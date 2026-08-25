import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ExternalLink, FileText, Play, RefreshCw } from 'lucide-react';
import { SIGNAL_CHANNEL_LABEL, signalMediaKindFor, type SignalPost } from '../../../shared/signal';
import { urlPostMedia, type SignalPostMedia } from '../../../shared/signal-media';
import { formatFileSize } from '../../../shared/drive';
import { useServerSeeded } from '../useServerSeeded';
import {
  publishCapabilityFor,
  PUBLISH_POST_KIND_LABEL,
  type PublishPlatform,
  type PublishPlatformCapability,
  type PublishPostKind,
} from '../../../shared/publish-capabilities';
import { publishCapabilityForProvider } from '../../../shared/buffer-capabilities';
import { BUFFER_TARGET_MEDIA_HINT } from '../../../shared/buffer-media';
import { BUFFER_PROVIDER } from '../../../shared/buffer';
import {
  publishVariantFieldSupported,
  publishVariantPlacements,
  PUBLISH_VARIANT_FIELD_LABEL,
  PUBLISH_VARIANT_MEDIA_FIELD,
  PUBLISH_VARIANT_SCOPE_LABEL,
  type PublishContentVariant,
  type PublishVariantField,
  type PublishVariantRecord,
} from '../../../shared/publish-variants';
import {
  publishRoleDelivers,
  publishRoleWarning,
  PUBLISH_VARIANT_MEDIA_ROLES,
  PUBLISH_VARIANT_MEDIA_ROLE_LABEL,
  type PublishVariantMediaRole,
} from '../../../shared/publish-variant-media';
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
 *    is a form that teaches the user something untrue about the provider. The two media roles
 *    (C76) are the one place where *offered* and *delivered* come apart, and the control says so:
 *    Post Bridge names a cover for Instagram and a thumbnail for YouTube, the live probe verified
 *    neither, so the role is stored, version-bound, and reported as held rather than sent.
 * 2. **Nothing remote loads until the preview is asked for.** No thumbnail, no video, no provider
 *    call. The composer above renders text alone, and pressing **Show preview** is the only thing
 *    in this file that causes the browser to fetch anything at all. Video needs a second explicit
 *    press, because a preview that starts playing is a preview that decided for you.
 *
 * The server fetches none of these URLs, before or after. It never has, for media or anything else
 * (`server/db.ts`, `signal_post_media`), and a preview is the last place to start.
 */

/**
 * How a layer's cover image or thumbnail is chosen, and what is said about where it goes.
 *
 * The same two sources the post's own media has since C74 — a public `https:` address typed in, or a
 * Drive link resolved by the server — and the same asymmetry: an address is text the form holds, and
 * a Drive file is metadata the server answered with. Nothing here fetches the media itself; a Drive
 * role shows what Drive said about the file and links to the viewer page, exactly as the composer's
 * media list does.
 *
 * The note under the control is the honest part. Post Bridge names a cover for Instagram and a
 * thumbnail for YouTube, and the live probe has verified neither, so a role chosen today is stored,
 * version-bound, and **not sent**. Saying that here rather than only in the preview is the
 * difference between a control that teaches the provider's real state and one that implies a
 * delivery nobody has watched happen.
 */
function VariantRoleField({
  capability,
  role,
  media,
  onChange,
  resolveDrive,
  onRecheck,
  canRecheck,
  disabled,
}: {
  capability: PublishPlatformCapability;
  role: PublishVariantMediaRole;
  media: SignalPostMedia | undefined;
  onChange: (next: SignalPostMedia | undefined) => void;
  resolveDrive: (link: string) => Promise<SignalPostMedia>;
  onRecheck?: () => Promise<void>;
  canRecheck: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const word = PUBLISH_VARIANT_MEDIA_ROLE_LABEL[role];
  const label = PUBLISH_VARIANT_FIELD_LABEL[PUBLISH_VARIANT_MEDIA_FIELD[role]];

  const addDrive = async () => {
    const value = link.trim();
    if (!value) return;
    setBusy(true);
    setError('');
    try {
      onChange(await resolveDrive(value));
      setLink('');
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (!onRecheck) return;
    setBusy(true);
    setError('');
    try {
      await onRecheck();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signal-variant-role" data-role={role}>
      <p className="signal-variant-role-head">
        <strong>{label}</strong>
        <span className="signal-variant-count" id={`${id}-state`}>
          {publishRoleDelivers(capability, role)
            ? `${capability.label} receives this ${word}.`
            : publishRoleWarning(capability, role)}
        </span>
      </p>
      {media?.source === 'DRIVE' ? (
        <div className="signal-media-drive">
          <a href={media.url} target="_blank" rel="noreferrer" referrerPolicy="no-referrer">
            {media.driveName}
          </a>
          <span className="signal-media-detail">
            {`${media.mimeType} · ${formatFileSize(media.sizeBytes)}`}
          </span>
          <span className="signal-media-detail">
            {media.driveVerifiedAt
              ? `Checked ${new Date(media.driveVerifiedAt).toLocaleString()}`
              : 'Not checked yet'}
          </span>
          {onRecheck && (
            <button
              type="button"
              className="secondary"
              disabled={disabled || busy || !canRecheck}
              onClick={recheck}
              title={
                canRecheck
                  ? undefined
                  : `Save this override before rechecking: a recheck is itself an edit.`
              }
            >
              <RefreshCw aria-hidden="true" /> Recheck {word}
            </button>
          )}
        </div>
      ) : (
        <label>
          <span className="sr-only">
            {label} address for {capability.label}
          </span>
          <input
            type="url"
            value={media?.url ?? ''}
            disabled={disabled || busy}
            aria-describedby={`${id}-state`}
            placeholder={`A public https address, or add a Drive file below`}
            onChange={(event) =>
              onChange(event.target.value.trim() ? urlPostMedia(event.target.value) : undefined)
            }
          />
        </label>
      )}
      <label>
        <span className="sr-only">
          Add a Drive file as the {capability.label} {word}
        </span>
        <input
          type="text"
          value={link}
          disabled={disabled || busy}
          placeholder="Paste a Google Drive file link"
          onChange={(event) => setLink(event.target.value)}
        />
      </label>
      <div className="signal-variant-role-actions">
        <button type="button" className="secondary" disabled={disabled || busy} onClick={addDrive}>
          Use this Drive file
        </button>
        {media && (
          <button
            type="button"
            className="text-btn"
            disabled={disabled || busy}
            onClick={() => onChange(undefined)}
          >
            Remove {word}
          </button>
        )}
      </div>
      {error && (
        <p className="signal-media-unresolved" role="status">
          <AlertTriangle aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}

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
  resolveDrive,
  onRecheckRole,
  canRecheckRole,
  disabled,
}: {
  capability: PublishPlatformCapability;
  value: PublishContentVariant;
  /**
   * The post's own media, in its order. A selection can only ever be a subset of this.
   *
   * Descriptors rather than URLs: the selection is still stated in URLs, because that is what the
   * stored layer and the provider request carry, but what each one *is* comes from the descriptor
   * — a Drive reference is classified from its stored MIME type, never from its viewer link.
   */
  postMedia: readonly SignalPostMedia[];
  onChange: (next: PublishContentVariant) => void;
  /** Resolves one pasted Drive link to a descriptor, through the server's media capability. */
  resolveDrive: (link: string) => Promise<SignalPostMedia>;
  /** Checks one saved role against Drive again. Absent while the layer has never been saved. */
  onRecheckRole?: (role: PublishVariantMediaRole) => Promise<void>;
  /** Whether a recheck is safe right now: the layer is stored and the form holds no unsaved edits. */
  canRecheckRole?: (role: PublishVariantMediaRole) => boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const supports = (field: PublishVariantField) => publishVariantFieldSupported(field, capability);
  const roles = PUBLISH_VARIANT_MEDIA_ROLES.filter((role) =>
    supports(PUBLISH_VARIANT_MEDIA_FIELD[role]),
  );
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
      {roles.map((role) => (
        <VariantRoleField
          key={role}
          capability={capability}
          role={role}
          media={value[PUBLISH_VARIANT_MEDIA_FIELD[role]]}
          disabled={disabled}
          resolveDrive={resolveDrive}
          canRecheck={canRecheckRole?.(role) ?? false}
          {...(onRecheckRole ? { onRecheck: () => onRecheckRole(role) } : {})}
          onChange={(next) => set({ [PUBLISH_VARIANT_MEDIA_FIELD[role]]: next })}
        />
      ))}
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
              ? `${capability.label} has no verified provider disclosure control, so this is written into the caption. It does not by itself guarantee platform, advertising, or legal compliance.`
              : `${capability.label} carries a verified provider disclosure control. Sending it does not by itself guarantee platform, advertising, or legal compliance.`}
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
              onChange={() => set({ mediaUrls: postMedia.map((item) => item.url) })}
            />
            Choose media for {capability.label}
          </label>
          {selection !== undefined && (
            <ol>
              {postMedia.map((item, index) => (
                <li key={`${index}-${item.url}`}>
                  <label className="signal-variant-check">
                    <input
                      type="checkbox"
                      checked={selection.includes(item.url)}
                      disabled={disabled}
                      onChange={(event) =>
                        set({
                          mediaUrls: event.target.checked
                            ? postMedia
                                .filter(
                                  (candidate) =>
                                    candidate.url === item.url || selection.includes(candidate.url),
                                )
                                .map((candidate) => candidate.url)
                            : selection.filter((candidate) => candidate !== item.url),
                        })
                      }
                    />
                    Media {index + 1} · {signalMediaKindFor(item)}
                    {item.source === 'DRIVE' && ' · Drive'}
                    <span className="signal-variant-url">
                      {item.source === 'DRIVE' ? item.driveName : item.url}
                    </span>
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
  onRecheckRole,
  resolveDrive,
  dirty,
  busy,
}: {
  post: SignalPost;
  layers: Map<string, PublishVariantRecord>;
  onChange: (next: Map<string, PublishVariantRecord>) => void;
  onSave: () => void;
  /** Rechecks one stored role. The layer's platform and account are the caller's to supply. */
  onRecheckRole: (
    platform: PublishPlatform,
    accountId: number | null,
    role: PublishVariantMediaRole,
  ) => Promise<void>;
  resolveDrive: (link: string) => Promise<SignalPostMedia>;
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
                postMedia={post.media}
                disabled={busy}
                resolveDrive={resolveDrive}
                onRecheckRole={(role) => onRecheckRole(platform, null, role)}
                // A recheck is an edit through the ordinary replacement, so it is offered only
                // while there is nothing unsaved for it to discard or silently save.
                canRecheckRole={(role) =>
                  !dirty && stored?.[PUBLISH_VARIANT_MEDIA_FIELD[role]]?.source === 'DRIVE'
                }
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
 *
 * **A Drive reference is never embedded.** Its URL is Drive's viewer page rather than the file, so
 * an `<img>` or a `<video>` pointed at it would fetch an HTML document and show a broken frame;
 * what it gets instead is what Drive said about the file and a link to open it. That is also the
 * honest picture of what this app holds: metadata and a version fingerprint, and no bytes.
 */
function PreviewMedia({ media, index }: { media: SignalPostMedia; index: number }) {
  const url = media.url;
  const kind = signalMediaKindFor(media);
  const [broken, setBroken] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const label = `Media ${index + 1} · ${kind}`;
  const isDrive = media.source === 'DRIVE';

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
      {isDrive && (
        <p className="signal-preview-media-note">
          <FileText aria-hidden="true" /> Drive file · {media.driveName} · {media.mimeType} ·{' '}
          {formatFileSize(media.sizeBytes)}
          {media.driveVerifiedAt
            ? ` · checked ${new Date(media.driveVerifiedAt).toLocaleString()}`
            : ''}
        </p>
      )}
      {!isDrive &&
        kind === 'image' &&
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
      {!isDrive &&
        kind === 'video' &&
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
      {!isDrive && (kind === 'pdf' || kind === 'unknown') && (
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

/**
 * Which accounts this channel publishes to, as an explicit choice (C77).
 *
 * Rendered from the accounts the preview was built from, which is the same list the save route
 * validates against — so a box a person can tick is never one the save will refuse.
 *
 * **Nothing ticked is not "send nowhere".** It means no explicit choice exists and the channel
 * resolves the way it always has, to one account, refusing zero or several. The legend says so,
 * because an empty set of checkboxes otherwise reads as a decision the person did not make.
 */
function TargetChoice({
  report,
  accounts,
  selected,
  onToggle,
  onSave,
  dirty,
  busy,
}: {
  report: PublishChannelReport;
  accounts: NonNullable<PublishPreview['connectedAccounts']>;
  selected: readonly number[];
  onToggle: (accountId: number, next: boolean) => void;
  onSave: () => void;
  dirty: boolean;
  busy: boolean;
}) {
  const onPlatform = accounts.filter((account) => account.platform === report.platform);
  const bufferOnPlatform = onPlatform.some((account) => account.provider === BUFFER_PROVIDER);
  if (!report.platform || onPlatform.length === 0) return null;
  return (
    <fieldset className="signal-target-choice">
      {bufferOnPlatform && <p className="signal-target-choice-hint">{BUFFER_TARGET_MEDIA_HINT}</p>}
      <legend>Accounts</legend>
      <p className="signal-target-choice-hint">
        {selected.length === 0
          ? 'No account chosen, so this channel resolves to its single account as it always has.'
          : `Publishing to ${selected.length} chosen account${selected.length === 1 ? '' : 's'}.`}
      </p>
      {onPlatform.map((account) => {
        const checked = selected.includes(account.id);
        const stateId = account.unavailable ? `target-choice-${account.id}-state` : undefined;
        return (
          <div key={account.id} className="signal-target-choice-option">
            <label>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy}
                aria-describedby={stateId}
                onChange={(event) => onToggle(account.id, event.target.checked)}
              />
              <span className="signal-target-choice-name">{account.handle || account.name}</span>
            </label>
            {account.unavailable && (
              <span className="signal-target-choice-state" id={stateId}>
                {account.unavailable}
              </span>
            )}
          </div>
        );
      })}
      <button type="button" className="secondary" disabled={!dirty || busy} onClick={onSave}>
        Save accounts
      </button>
    </fieldset>
  );
}

/**
 * Every chosen account's own verdict, where more than the channel itself has one.
 *
 * One row per account rather than a merged sentence, because two accounts fail for two reasons and
 * "Facebook is blocked" cannot say which of them a person has to fix. Absent entirely where nobody
 * selected, which is the same distinction the report itself draws.
 */
function TargetVerdicts({ report }: { report: PublishChannelReport }) {
  if (!report.targets?.length) return null;
  return (
    <ul className="signal-target-verdicts">
      {report.targets.map((entry) => (
        <li key={entry.accountId} className={`channel-${entry.status.toLowerCase()}`}>
          <p>
            <strong>{entry.handle || entry.accountId}</strong> ·{' '}
            {PUBLISH_CHANNEL_STATUS_LABEL[entry.status]}
          </p>
          {entry.content && (
            <p className="signal-target-verdict-caption">{entry.content.caption}</p>
          )}
          {entry.refusals.map((refusal) => (
            <p key={refusal} className="signal-refusal">
              {refusal}
            </p>
          ))}
          {entry.warnings.map((warning) => (
            <p key={warning} className="signal-warning">
              {warning}
            </p>
          ))}
        </li>
      ))}
    </ul>
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
  onRecheckRole,
  resolveDrive,
  accountDirty,
  busy,
  targetChoice,
  driveOverride,
  onDriveOverrideChange,
}: {
  report: PublishChannelReport;
  preview: PublishPreview;
  post: SignalPost;
  accountLayer: PublishContentVariant | undefined;
  onAccountChange: (next: PublishContentVariant) => void;
  onAccountSave: () => void;
  onRecheckRole: (
    platform: PublishPlatform,
    accountId: number | null,
    role: PublishVariantMediaRole,
  ) => Promise<void>;
  resolveDrive: (link: string) => Promise<SignalPostMedia>;
  accountDirty: boolean;
  busy: boolean;
  targetChoice: React.ReactNode;
  driveOverride: boolean;
  onDriveOverrideChange: (next: boolean) => void;
}) {
  const content = report.content;
  const capability = report.platform
    ? publishCapabilityForProvider(report.provider, report.platform, report.bufferSchedulingType)
    : undefined;
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
      {targetChoice}
      <TargetVerdicts report={report} />
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
          {/* A role is named beside the text rather than embedded, and never fetched: what it says
              is which file this target's cover or thumbnail is, and the report's own warnings
              already say whether the provider will carry it. */}
          {PUBLISH_VARIANT_MEDIA_ROLES.map((role) => {
            const media = content[PUBLISH_VARIANT_MEDIA_FIELD[role]];
            if (!media) return null;
            return (
              <p className="signal-preview-field" key={role} data-role={role}>
                <strong>{PUBLISH_VARIANT_FIELD_LABEL[PUBLISH_VARIANT_MEDIA_FIELD[role]]}:</strong>{' '}
                {media.source === 'DRIVE' ? `Drive file · ${media.driveName}` : media.url}
              </p>
            );
          })}
          <h4>Media, in this order</h4>
          {content.mediaUrls.length === 0 ? (
            <p className="signal-preview-field">No media on this target.</p>
          ) : (
            <ol className="signal-preview-media-list">
              {/* The selection is URLs; what each one is comes from the post's own descriptors.
                  A URL the post no longer carries falls back to a public reference, which is what
                  it would have been read as before descriptors existed. */}
              {content.mediaUrls.map((url, index) => (
                <PreviewMedia
                  key={`${index}-${url}`}
                  media={post.media.find((item) => item.url === url) ?? urlPostMedia(url)}
                  index={index}
                />
              ))}
            </ol>
          )}
          {report.bufferWire && (
            <>
              <h4>Buffer payload</h4>
              <pre className="signal-preview-buffer-wire">
                {JSON.stringify(report.bufferWire, null, 2)}
              </pre>
            </>
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
      {(report.driveOverridable || report.targets?.some((entry) => entry.driveOverridable)) && (
        <label className="signal-drive-override">
          <input
            type="checkbox"
            checked={driveOverride}
            disabled={busy}
            onChange={(event) => onDriveOverrideChange(event.target.checked)}
          />
          Send Drive media to Buffer anyway, as a direct-download link (risky — may fail silently
          when the post publishes)
        </label>
      )}
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
            postMedia={post.media}
            disabled={busy}
            resolveDrive={resolveDrive}
            onRecheckRole={(role) =>
              onRecheckRole(capability.platform, report.accountId as number, role)
            }
            canRecheckRole={(role) =>
              !accountDirty && accountLayer?.[PUBLISH_VARIANT_MEDIA_FIELD[role]]?.source === 'DRIVE'
            }
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
  onSaveTargets,
  onRecheckRole,
  resolveDrive,
  savedLayers,
  busy,
  driveOverride,
  onDriveOverrideChange,
}: {
  preview: PublishPreview;
  post: SignalPost;
  layers: Map<string, PublishVariantRecord>;
  onChange: (next: Map<string, PublishVariantRecord>) => void;
  onSaveAccount: () => void;
  /** Persists the whole explicit target selection for the post, as a replacement. */
  onSaveTargets: (
    targets: { channel: string; providerAccountIds: number[] }[],
  ) => void | Promise<void>;
  onRecheckRole: (
    platform: PublishPlatform,
    accountId: number | null,
    role: PublishVariantMediaRole,
  ) => Promise<void>;
  resolveDrive: (link: string) => Promise<SignalPostMedia>;
  /** What the server currently holds, so an account layer knows whether it is unsaved. */
  savedLayers: Map<string, PublishVariantRecord>;
  busy: boolean;
  /** Whether this send accepts converting a Buffer target's Drive media to a direct-download link. */
  driveOverride: boolean;
  onDriveOverrideChange: (next: boolean) => void;
}) {
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const reports = preview.channels;
  // Seeded from the preview and edited locally until **Save accounts**, the same shape the account
  // content layer already uses here: an unsaved tick is not a plan, and the plan hash is what the
  // confirmation is taken against.
  const savedSelection = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const entry of preview.selectedTargets ?? [])
      map.set(entry.channel, [...(map.get(entry.channel) ?? []), entry.providerAccountId]);
    return map;
  }, [preview.selectedTargets]);
  const [selection, setSelection, selectionSaved] =
    useServerSeeded<Map<string, number[]>>(savedSelection);

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
          targetChoice={
            preview.connectedAccounts ? (
              <TargetChoice
                report={selected}
                accounts={preview.connectedAccounts}
                selected={selection.get(selected.channel) ?? []}
                busy={busy}
                dirty={
                  JSON.stringify([...(selection.get(selected.channel) ?? [])].sort()) !==
                  JSON.stringify([...(savedSelection.get(selected.channel) ?? [])].sort())
                }
                onToggle={(accountId, next) => {
                  const current = selection.get(selected.channel) ?? [];
                  const copy = new Map(selection);
                  copy.set(
                    selected.channel,
                    next
                      ? [...current, accountId].sort((a, b) => a - b)
                      : current.filter((id) => id !== accountId),
                  );
                  setSelection(copy);
                }}
                onSave={() => {
                  void Promise.resolve(
                    onSaveTargets(
                      [...selection.entries()].map(([channel, providerAccountIds]) => ({
                        channel,
                        providerAccountIds,
                      })),
                    ),
                    // The saved selection is now what the next preview will carry, so hand authority
                    // back. Held open, this panel would ignore every later preview it was given.
                  ).then(selectionSaved);
                }}
              />
            ) : null
          }
          report={selected}
          preview={preview}
          post={post}
          onRecheckRole={onRecheckRole}
          resolveDrive={resolveDrive}
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
          driveOverride={driveOverride}
          onDriveOverrideChange={onDriveOverrideChange}
        />
      </div>
    </div>
  );
}
