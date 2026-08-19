import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Merge } from 'lucide-react';
import { send } from '../api';
import type { Client } from '../../../shared/types';
import {
  CLIENT_MERGE_CHOICES,
  CLIENT_MERGE_FIELDS,
  CLIENT_MERGE_NOTICES,
  type ClientMergeChoice,
  type ClientMergeField,
  type ClientMergeFieldPlan,
  type ClientMergePreview,
  type ClientMergeResult,
} from '../../../shared/client-merge';
import { Empty } from './Primitives';

/** One field as the dialog holds it. `value` is the raw text of the custom box, trimmed on send. */
type FieldSelection = { choice: ClientMergeChoice; value: string };
type FieldSelections = Record<ClientMergeField, FieldSelection>;

const DEFAULT_SELECTIONS = Object.fromEntries(
  CLIENT_MERGE_FIELDS.map(({ key }) => [key, { choice: 'DESTINATION', value: '' }]),
) as FieldSelections;

/** The choices as the API takes them. A value travels only with the choice that reads one. */
const requestFields = (chosen: FieldSelections) =>
  Object.fromEntries(
    CLIENT_MERGE_FIELDS.map(({ key }) => [
      key,
      chosen[key].choice === 'CUSTOM'
        ? { choice: 'CUSTOM', value: chosen[key].value.trim() }
        : { choice: chosen[key].choice },
    ]),
  );

/**
 * Whether the plan on screen is the plan these choices describe. Compared against the server's
 * own echo rather than against a flag, so a request that failed, was superseded, or answered out
 * of order leaves the confirmation disabled without anything having to notice.
 */
const matchesPreview = (fields: ClientMergeFieldPlan[], chosen: FieldSelections) =>
  fields.every(
    (field) =>
      chosen[field.field].choice === field.choice &&
      (field.choice !== 'CUSTOM' || chosen[field.field].value.trim() === (field.value ?? '')),
  );

/** A blank field is shown as blank rather than as nothing, so it can be chosen deliberately. */
const shown = (value: string | null) => value ?? '(none)';

/**
 * How long a choice sits before the plan is re-read. Long enough that typing a custom value is
 * one request rather than one per keystroke, short enough that a radio feels immediate.
 */
const PLAN_DELAY_MS = 200;

/**
 * Merging one client into another, confirmed against a preview rather than a `window.confirm`.
 *
 * Choosing a destination loads the server's own plan, and the plan is what the dialog reads out —
 * both names, every project that would move whatever its status, every import identity that
 * follows them, what each of the six choosable fields would end up as, and the fixed statements in
 * `CLIENT_MERGE_NOTICES` about what a merge does not do. Confirm stays disabled until a clean
 * preview is on screen, and it sends that preview's hash back, so a workspace that moved in the
 * meantime is refused with a 409 instead of merging something nobody was shown.
 *
 * The field choices are part of the plan rather than of the confirmation, which is why every
 * change to one re-reads it: the hash covers the chosen values, so the only confirmable state is
 * one the server has planned and shown. Until that round trip lands, the choices on screen and the
 * plan behind them disagree and Confirm is disabled — a stale plan is never confirmable, and that
 * includes one made stale by the person confirming it.
 */
export function ClientMergeForm({
  source,
  clients,
  close,
  refresh,
  flash,
}: {
  source: Client;
  clients: Client[];
  close: () => void;
  refresh: () => Promise<void>;
  flash: (s: string, t?: 'success' | 'error') => void;
}) {
  const navigate = useNavigate();
  const [destinationId, setDestinationId] = useState('');
  const [selections, setSelections] = useState<FieldSelections>(DEFAULT_SELECTIONS);
  const [preview, setPreview] = useState<ClientMergePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; from: 'preview' | 'commit' } | null>(null);
  /** A destination has to be a live client that is not this one and was not itself merged away. */
  const destinations = clients.filter(
    (candidate) =>
      candidate.status === 'ACTIVE' && candidate.id !== source.id && !candidate.mergedInto,
  );

  /** The read this dialog is waiting on. An answer to an older one is not an answer. */
  const latestRead = useRef(0);

  /**
   * Reads the server's plan for these choices. A refusal the commit produced is left on screen —
   * see `confirm` — while one this read produced is replaced by whatever this read says.
   *
   * Only the newest read is allowed to speak. Two answers can be in flight after a change made
   * while one was still out, and the last to arrive is not necessarily the last to be asked.
   */
  const readPlan = useCallback(
    async (id: string, chosen: FieldSelections) => {
      const read = ++latestRead.current;
      setBusy(true);
      try {
        const plan = await send<ClientMergePreview>(`/clients/${source.id}/merge/preview`, 'POST', {
          destinationId: id,
          fields: requestFields(chosen),
        });
        if (read !== latestRead.current) return;
        setPreview(plan);
        setError((current) => (current?.from === 'preview' ? null : current));
      } catch (err) {
        if (read !== latestRead.current) return;
        setError({ message: (err as Error).message, from: 'preview' });
      } finally {
        if (read === latestRead.current) setBusy(false);
      }
    },
    [source.id],
  );

  /**
   * Every choice re-plans, because the hash covers the values it settles. The wait is cleared on
   * the next change, so a value being typed is planned once it stops changing rather than six
   * times on the way there.
   */
  useEffect(() => {
    if (!destinationId) return;
    const timer = setTimeout(() => void readPlan(destinationId, selections), PLAN_DELAY_MS);
    return () => clearTimeout(timer);
  }, [destinationId, selections, readPlan]);

  const chooseDestination = (id: string) => {
    setDestinationId(id);
    // The choices named the other client's values, so they cannot outlive it.
    setSelections(DEFAULT_SELECTIONS);
    setPreview(null);
    setError(null);
  };
  /** Switching to a custom value starts from what the client being kept holds, not from blank. */
  const choose = (field: ClientMergeField, choice: ClientMergeChoice, seed: string | null) =>
    setSelections((current) => ({
      ...current,
      [field]: {
        choice,
        value: choice === 'CUSTOM' ? current[field].value || (seed ?? '') : current[field].value,
      },
    }));
  const typeCustom = (field: ClientMergeField, value: string) =>
    setSelections((current) => ({ ...current, [field]: { choice: 'CUSTOM', value } }));

  const planned = Boolean(preview && matchesPreview(preview.fields, selections));

  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await send<ClientMergeResult>(`/clients/${source.id}/merge`, 'POST', {
        destinationId: preview.destination.id,
        fields: requestFields(selections),
        planHash: preview.planHash,
      });
      await refresh();
      close();
      navigate(`/clients/${result.destination.id}`);
      const changed = result.fields.filter((field) => field.value !== field.destination).length;
      flash(
        `${result.source.name} merged into ${result.destination.name}. ${result.movedProjectCount} project${
          result.movedProjectCount === 1 ? '' : 's'
        } moved${changed ? `, ${changed} field${changed === 1 ? '' : 's'} updated` : ''}.`,
      );
    } catch (err) {
      setError({ message: (err as Error).message, from: 'commit' });
      setBusy(false);
      /**
       * A stale plan is the one refusal the dialog can resolve by itself: re-read the merge, so
       * the next confirmation is taken against what the workspace says now. The message stays
       * on screen beside the fresh plan — the point is that this is a second look, not a retry
       * of the same one.
       */
      if ((err as { status?: number }).status === 409) {
        setPreview(null);
        await readPlan(preview.destination.id, selections);
      }
    }
  };

  if (!destinations.length)
    return (
      <div className="form">
        <Empty
          compact
          title="No client to merge into"
          body="A merge needs another active client that has not itself been merged away. Create or unarchive one first."
        />
        <footer className="merge-actions">
          <button type="button" className="secondary" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    );

  return (
    <div className="form client-merge">
      <label>
        Merge into
        <select
          name="destinationId"
          value={destinationId}
          onChange={(event) => chooseDestination(event.target.value)}
        >
          <option value="">Select the client to keep</option>
          {destinations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">
        <strong>{source.name}</strong> is archived once the merge is done, keeping its own details
        on its record. Choose below which values the client you keep ends up with.
      </p>

      {preview && (
        <section className="merge-plan" aria-label="Merge preview">
          <h3>
            {preview.source.name} → {preview.destination.name}
          </h3>

          {/*
            The choosable fields, with both records' values in front of the radio that takes one.
            Every field defaults to the client being kept, blank or not: a merge that quietly
            filled in a gap because the other record had something would be deciding on its own
            which record is right, which is the decision this dialog exists to ask for.
          */}
          <fieldset className="merge-fields">
            <legend>Field values</legend>
            <p>
              What {preview.destination.name} is left holding. Keep destination is the default for
              every field, a blank one included.
            </p>
            {preview.fields.map((field) => {
              const meta = CLIENT_MERGE_FIELDS.find(({ key }) => key === field.field)!;
              const chosen = selections[field.field];
              return (
                <fieldset key={field.field} className="merge-field">
                  <legend>{meta.label}</legend>
                  {CLIENT_MERGE_CHOICES.map(({ choice, label }) => (
                    <label key={choice} className="merge-choice">
                      <input
                        type="radio"
                        name={`merge-field-${field.field}`}
                        value={choice}
                        checked={chosen.choice === choice}
                        onChange={() => choose(field.field, choice, field.destination)}
                      />
                      <span className="merge-choice-label">{label}</span>
                      {choice !== 'CUSTOM' && (
                        <span className="merge-choice-value">
                          {shown(choice === 'SOURCE' ? field.source : field.destination)}
                        </span>
                      )}
                    </label>
                  ))}
                  {chosen.choice === 'CUSTOM' && (
                    <label className="merge-custom">
                      <span>Custom {meta.label.toLowerCase()}</span>
                      {'multiline' in meta ? (
                        <textarea
                          rows={3}
                          value={chosen.value}
                          onChange={(event) => typeCustom(field.field, event.target.value)}
                        />
                      ) : (
                        <input
                          type="text"
                          value={chosen.value}
                          onChange={(event) => typeCustom(field.field, event.target.value)}
                        />
                      )}
                    </label>
                  )}
                </fieldset>
              );
            })}
          </fieldset>
          {/*
            The slug is derived rather than chosen, and it is only worth a sentence when the name
            being kept changes it — which is the same thing renaming the client would do.
          */}
          {preview.slug.next !== preview.slug.current && (
            <p className="merge-slug">
              The client’s web address changes from <code>{preview.slug.current}</code> to{' '}
              <code>{preview.slug.next}</code>, as it would if you renamed it.
            </p>
          )}

          <p>
            {preview.projects.length === 0
              ? `${preview.source.name} has no projects. The merge still records it as merged into ${preview.destination.name}.`
              : `${preview.projects.length} project${
                  preview.projects.length === 1 ? '' : 's'
                } will move to ${preview.destination.name}:`}
          </p>
          {preview.projects.length > 0 && (
            <ul className="merge-projects">
              {preview.projects.map((project) => (
                <li key={project.id}>
                  <strong>{project.name}</strong>
                  <span>{project.status.replace('_', ' ')}</span>
                </li>
              ))}
            </ul>
          )}
          {/*
            The identities the source is known by outside this workspace. Listed rather than
            counted: which id follows the work is the fact a later import turns on, and an
            identity nobody expected to see here is worth catching before the merge, not after.
          */}
          {preview.aliases.length > 0 && (
            <>
              <p>
                {preview.aliases.length === 1
                  ? 'One import identity moves'
                  : `${preview.aliases.length} import identities move`}{' '}
                with it, so a playbook naming {preview.source.name} at its own source will resolve
                to {preview.destination.name} afterwards:
              </p>
              <ul className="merge-aliases" aria-label="Import identities that move">
                {preview.aliases.map((alias) => (
                  <li key={`${alias.namespace} ${alias.externalId}`}>
                    <strong>{alias.externalId}</strong>
                    <code>{alias.namespace}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="merge-notices">
            {CLIENT_MERGE_NOTICES.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="form-error" role="alert">
        {error && (
          <>
            <AlertTriangle /> {error.message}
          </>
        )}
      </div>
      <footer className="merge-actions">
        <button type="button" className="secondary" onClick={close}>
          Cancel
        </button>
        <button type="button" className="danger" onClick={confirm} disabled={!planned || busy}>
          <Merge /> {busy ? 'Merging…' : 'Merge clients'}
        </button>
      </footer>
    </div>
  );
}
